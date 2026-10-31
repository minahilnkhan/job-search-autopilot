import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { applications, jobs } from "../src/db/schema";
import { roleType, trackerState, trackerStateText } from "../src/services/tracker";
import { addDays, weekStart } from "../src/domain/week";
import type { DB } from "../src/db/client";
import { FDE_JD, FIXTURE_RESUME, OFFLINE_PIPELINE, makeTestDb, prepDeps } from "./helpers";

// The mentor prompt tells the model to base every count on <tracker_state>.
// These tests are what makes that safe: the numbers come from the database,
// and the text says what they mean.

let db: DB;
let app: ReturnType<typeof buildApp>;
const NOW = new Date("2026-10-30T18:00:00Z"); // Friday, 1pm in Chicago
const TODAY = "2026-10-30";

const req = async (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as object });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};

beforeEach(async () => {
  seq = 0;
  db = makeTestDb();
  app = buildApp(db, { pipeline: OFFLINE_PIPELINE, prep: prepDeps() });
  await req("PUT", "/api/resumes/bases/fde", { text: FIXTURE_RESUME });
  await req("PUT", "/api/resumes/bases/swe", { text: FIXTURE_RESUME });
});

let seq = 0;

/** A submitted application on `date`, at `tier`, in whatever state it reached. One company each, so nothing dedupes. */
async function submitted(title: string, tier: "A" | "B", date: string, status = "submitted") {
  const { body } = await req("POST", "/api/jobs", { companyName: `Co ${++seq}`, title, location: "Chicago, IL", description: FDE_JD });
  db.update(jobs).set({ tier, fitScore: tier === "A" ? 9 : 6 }).where(eq(jobs.id, body.job.id)).run();
  const a = (await req("POST", "/api/applications", { jobId: body.job.id })).body;
  db.update(applications)
    .set({ status: status as "submitted", submittedAt: new Date(`${date}T18:00:00Z`), tier })
    .where(eq(applications.id, a.id))
    .run();
  return a.id as number;
}

describe("tracker state", () => {
  it("counts today, this week and last week separately, by tier", async () => {
    await submitted("Forward Deployed Engineer", "A", TODAY);
    await submitted("Software Engineer", "B", TODAY);
    await submitted("Software Engineer", "B", "2026-10-27"); // Tuesday, same week
    await submitted("Software Engineer", "B", "2026-10-22"); // last week

    const t = trackerState(db, NOW);
    expect(t.date).toBe(TODAY);
    expect(t.weekStart).toBe("2026-10-26");
    expect(t.today.submitted).toEqual({ total: 2, tierA: 1, tierB: 1 });
    expect(t.week.submitted).toEqual({ total: 3, tierA: 1, tierB: 2 });
    expect(t.lastWeek.submitted).toEqual({ total: 1, tierA: 0, tierB: 1 });
    expect(t.targets).toMatchObject({ appsPerDay: 10, appsPerWeek: 70, cap: 30 });
  });

  it("response rate splits by tier and role type; a rejection still counts as a response", async () => {
    await submitted("Forward Deployed Engineer", "A", TODAY, "screen");
    await submitted("Forward Deployed Engineer", "A", TODAY, "rejected");
    await submitted("Software Engineer", "B", TODAY);
    await submitted("Software Engineer", "B", TODAY);

    const t = trackerState(db, NOW);
    expect(t.responseRate.tierA).toEqual({ applications: 2, responses: 2, rate: 100 });
    expect(t.responseRate.tierB).toEqual({ applications: 2, responses: 0, rate: 0 });
    expect(t.responseRate.overall.rate).toBe(50);
    expect(t.responseRate.byRoleType).toEqual([
      { type: "FDE / Solutions", applications: 2, responses: 2, rate: 100 },
      { type: "Software Engineering", applications: 2, responses: 0, rate: 0 },
    ]);
  });

  it("sorts titles into role families", () => {
    expect(roleType("Forward Deployed Software Engineer, New Grad")).toBe("FDE / Solutions");
    expect(roleType("Applied AI Engineer")).toBe("Applied AI");
    expect(roleType("Technical Consultant")).toBe("Consulting");
    expect(roleType("Developer Advocate")).toBe("Teaching / DevEd");
    expect(roleType("Backend Engineer II")).toBe("Software Engineering");
  });

  it("carries hours, the queue and open tasks, and reads as plain sentences", async () => {
    await submitted("Forward Deployed Engineer", "A", TODAY);
    await req("POST", "/api/time", { bucket: "applications", minutes: 300, date: TODAY });
    await req("POST", "/api/time", { bucket: "projects", minutes: 600, date: TODAY }); // 10h, bucket is 6
    await req("POST", "/api/tasks", { title: "Finish the Docker project README", bucket: "projects", dueDate: addDays(TODAY, -1) });

    const t = trackerState(db, NOW);
    expect(t.week.hours).toMatchObject({ coreHours: 11, projectOverflow: 4, cap: 30 });
    expect(t.tasks[0]).toMatchObject({ title: "Finish the Docker project README", overdue: true });

    const text = trackerStateText(t);
    expect(text).toContain("1/10 applications");
    expect(text).toContain("1/70 applications");
    expect(text).toContain("Core 11/30h, plus 4h approved project overflow");
    expect(text).toContain("(OVERDUE)");
    expect(text).toContain("Cap review 2026-11-06 (7 days away)");
  });

  it("an empty week reads as zeros, not as missing data", () => {
    const t = trackerState(db, NOW);
    expect(t.today.submitted.total).toBe(0);
    expect(t.responseRate.overall).toEqual({ applications: 0, responses: 0, rate: null });
    const text = trackerStateText(t);
    expect(text).toContain("overall no applications yet");
    expect(text).toContain("Open tasks: none.");
    expect(text).toContain("This week's project: none chosen yet.");
  });

  it("counts the streak in whole days at target, and doesn't break it mid-day", async () => {
    for (const d of [addDays(TODAY, -2), addDays(TODAY, -1)]) {
      for (let i = 0; i < 10; i++) await submitted("Software Engineer", "B", d);
    }
    await submitted("Software Engineer", "B", TODAY); // 1 of 10 so far today
    expect(trackerState(db, NOW).streak).toBe(2);
    expect(weekStart(TODAY)).toBe("2026-10-26");
  });
});
