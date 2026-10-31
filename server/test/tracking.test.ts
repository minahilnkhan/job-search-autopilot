import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { settings } from "../src/db/schema";
import { addDays, streakDays, weekStart } from "../src/domain/week";
import { IDLE_LIMIT_MINUTES } from "../src/services/time";
import type { DB } from "../src/db/client";
import { OFFLINE_PIPELINE, makeTestDb, prepDeps } from "./helpers";

// Phase 5: hours and to-dos. The mentor prompt wants hours as well as counts,
// and holds the week to a 30-hour cap with project hours as approved overflow.

let db: DB;
let app: ReturnType<typeof buildApp>;
const TZ = "America/Chicago";

const req = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as object });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};

beforeEach(() => {
  db = makeTestDb();
  app = buildApp(db, { pipeline: OFFLINE_PIPELINE, prep: prepDeps() });
});

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

describe("week maths", () => {
  it("weeks run Monday to Sunday", () => {
    expect(weekStart("2026-10-30")).toBe("2026-10-26"); // Friday → Monday
    expect(weekStart("2026-10-26")).toBe("2026-10-26"); // Monday stays
    expect(weekStart("2026-11-01")).toBe("2026-10-26"); // Sunday belongs to the week that started
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01"); // across a month, and DST weekends
  });

  it("a streak isn't broken by a day that's still in progress", () => {
    const counts = new Map([
      ["2026-10-28", 10],
      ["2026-10-29", 10],
      ["2026-10-30", 3], // today, not done yet
    ]);
    expect(streakDays(counts, "2026-10-30", 10)).toBe(2);
    counts.set("2026-10-30", 10);
    expect(streakDays(counts, "2026-10-30", 10)).toBe(3);
    expect(streakDays(new Map(), "2026-10-30", 10)).toBe(0);
  });
});

describe("time tracking", () => {
  it("one timer at a time: starting a second stops the first and logs its minutes", async () => {
    const a = (await req("POST", "/api/time/start", { bucket: "applications" })).body;
    expect(a).toMatchObject({ bucket: "applications", needsConfirm: false });
    const b = (await req("POST", "/api/time/start", { bucket: "prep", note: "LeetCode" })).body;
    expect(b.bucket).toBe("prep");
    const after = (await req("GET", "/api/time")).body;
    expect(after.running).toMatchObject({ id: b.id, bucket: "prep" });
    expect(after.entries.map((e: { bucket: string }) => e.bucket)).toEqual(["applications"]); // the first one closed
  });

  it("a timer left running over two hours asks what you actually worked, and won't be overwritten", async () => {
    const t = (await req("POST", "/api/time/start", { bucket: "projects" })).body;
    // Backdate it: three hours ago.
    db.run(`update time_logs set started_at = started_at - ${3 * 60 * 60 * 1000} where id = ${t.id}`);
    const running = (await req("GET", "/api/time")).body.running;
    expect(running).toMatchObject({ needsConfirm: true });
    expect(running.elapsedMinutes).toBeGreaterThan(IDLE_LIMIT_MINUTES);

    const blocked = await req("POST", "/api/time/start", { bucket: "applications" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("actually worked");

    const stopped = (await req("POST", `/api/time/${t.id}/stop`, { minutes: 90 })).body;
    expect(stopped.minutes).toBe(90); // what you confirmed, not the three hours on the clock
  });

  it("discarding a forgotten timer logs nothing", async () => {
    const t = (await req("POST", "/api/time/start", { bucket: "projects" })).body;
    expect((await req("POST", `/api/time/${t.id}/discard`)).status).toBe(200);
    const after = (await req("GET", "/api/time")).body;
    expect(after.running).toBeNull();
    expect(after.entries).toEqual([]);
  });

  it("project hours past the bucket are overflow, not a breach of the cap", async () => {
    await req("POST", "/api/time", { bucket: "applications", minutes: 600 }); // 10h
    await req("POST", "/api/time", { bucket: "projects", minutes: 900 }); // 15h, bucket is 6
    await req("POST", "/api/time", { bucket: "prep", minutes: 120 }); // 2h
    const w = (await req("GET", "/api/time")).body.week;
    expect(w).toMatchObject({ total: 27, cap: 30, coreHours: 18, projectOverflow: 9 });
    expect(w.buckets).toEqual([
      { bucket: "applications", hours: 10, target: 20 },
      { bucket: "projects", hours: 15, target: 6 },
      { bucket: "prep", hours: 2, target: 4 },
    ]);
  });
});

describe("tasks and the cap", () => {
  it("adds, reorders by priority, and completes", async () => {
    await req("POST", "/api/tasks", { title: "Apply to 3 Tier A", bucket: "applications", priority: 1, dueDate: today() });
    await req("POST", "/api/tasks", { title: "Two-pointer set", bucket: "prep", priority: 3, dueDate: today() });
    const { tasks } = (await req("GET", "/api/tasks")).body;
    expect(tasks.map((t: { title: string }) => t.title)).toEqual(["Apply to 3 Tier A", "Two-pointer set"]);
    await req("PATCH", `/api/tasks/${tasks[0].id}`, { status: "done" });
    expect((await req("GET", "/api/tasks")).body.tasks).toHaveLength(1); // done drops off the open list
    expect((await req("GET", "/api/tasks?includeDone=true")).body.tasks).toHaveLength(2);
  });

  it("marks a task overdue once its day has passed", async () => {
    await req("POST", "/api/tasks", { title: "Yesterday's follow-up", dueDate: addDays(today(), -1) });
    expect((await req("GET", "/api/tasks")).body.tasks[0]).toMatchObject({ overdue: true });
  });

  it("warns before a task takes the week over the cap, and adds it when you say so", async () => {
    await req("POST", "/api/time", { bucket: "applications", minutes: 20 * 60 }); // 20h logged
    await req("POST", "/api/tasks", { title: "Prep block", bucket: "prep", dueDate: today(), estimateMinutes: 8 * 60 }); // 28h
    const over = (await req("POST", "/api/tasks", { title: "One more project session", bucket: "projects", dueDate: today(), estimateMinutes: 4 * 60 })).body;
    expect(over.task).toBeNull();
    expect(over.warning).toMatchObject({ cap: 30, plannedHours: 28, afterHours: 32 });
    expect(over.warning.message).toContain("what it replaces");

    const forced = (await req("POST", "/api/tasks", { title: "One more project session", bucket: "projects", dueDate: today(), estimateMinutes: 4 * 60, acceptOverCap: true })).body;
    expect(forced.task).toMatchObject({ title: "One more project session" });
    expect(forced.warning).toBeNull();
  });

  it("a cap raised in Settings moves the warning with it", async () => {
    db.update(settings).set({ targets: { appsPerDay: 10, daysPerWeek: 7, hoursPerWeekCap: 40, bucketHours: { applications: 20, projects: 6, prep: 4 } } }).run();
    await req("POST", "/api/time", { bucket: "applications", minutes: 30 * 60 });
    const ok = (await req("POST", "/api/tasks", { title: "Extra", bucket: "prep", dueDate: today(), estimateMinutes: 5 * 60 })).body;
    expect(ok.warning).toBeNull();
  });
});
