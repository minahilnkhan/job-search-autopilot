import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { apiUsage, applications, jobs } from "../src/db/schema";
import { needsDailyCheckIn, needsWeeklyReview } from "../src/services/checkIns";
import type { CheckInInput, CheckInWriter, DailyCheckIn, WeeklyReview } from "../src/llm/checkIn";
import type { DB } from "../src/db/client";
import { FDE_JD, FIXTURE_RESUME, OFFLINE_PIPELINE, makeTestDb, prepDeps } from "./helpers";

// The mentor's scheduled jobs. The point of these tests is the division of
// labour: the model writes judgment, the app owns every number.

let db: DB;
let app: ReturnType<typeof buildApp>;
let seen: CheckInInput[];
const FRIDAY = new Date("2026-10-30T18:00:00Z");

const DAILY: DailyCheckIn = {
  priorities: [
    { title: "Review the 2 applications waiting", bucket: "applications", estimateMinutes: 45, why: "queue is backing up" },
    { title: "Apply to the 3 Tier A picks", bucket: "applications", estimateMinutes: 120, why: "behind on the week" },
    { title: "One hour on the Docker project", bucket: "projects", estimateMinutes: 60, why: "keeps the weekly project moving" },
  ],
  verdict: { kind: "call_out", text: "Three days under target. What got in the way?" },
  adjustments: ["Move an hour from projects into applications until the week evens out."],
};

const WEEKLY: WeeklyReview = {
  diagnosis: "Tier A is converting and Tier B isn't, but it's early.",
  targets: { applications: 70, projectHours: 16, prepHours: 4, note: "Same as last week." },
  projectIdeas: [
    { title: "Receipt parser", oneLine: "Parses messy receipts through an API, deployed, measures accuracy.", skills: ["Docker"], wildcard: false },
    { title: "Tab Therapist v2", oneLine: "Extends her existing extension with GitHub Actions CI.", skills: ["GitHub Actions"], wildcard: false },
    { title: "Transit delay tracker", oneLine: "Real CTA data, deployed, measures prediction error.", skills: ["Docker"], wildcard: false },
    { title: "Slang mapper", oneLine: "Maps regional slang using a real API.", skills: ["React"], wildcard: false },
    { title: "Eval harness", oneLine: "A small eval set for her Claude pipeline.", skills: ["Docker"], wildcard: false },
    { title: "Roblox physics toy", oneLine: "A silly physics demo in the browser.", skills: [], wildcard: true },
  ],
  prepFocus: "Two-pointer and hashing problems.",
  githubTask: "Pin the four strongest repos and archive the tutorial ones.",
  tasks: [
    { title: "Build the receipt parser skeleton", bucket: "projects", estimateMinutes: 120 },
    { title: "Four LeetCode mediums", bucket: "prep", estimateMinutes: 90 },
  ],
};

function fakeWriter(over: { fail?: string } = {}): CheckInWriter {
  const usage = { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 3000, cacheWriteTokens: 0 };
  const record = async <T>(input: CheckInInput, output: T) => {
    if (over.fail) throw new Error(over.fail);
    seen.push(input);
    return { output, usage, model: "claude-sonnet-5-5" };
  };
  return { daily: (i) => record(i, DAILY), weekly: (i) => record(i, WEEKLY) };
}

const req = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as object });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};

function setup(writer: CheckInWriter | { unavailable: string } = fakeWriter()) {
  db = makeTestDb();
  seen = [];
  app = buildApp(db, {
    pipeline: OFFLINE_PIPELINE,
    prep: prepDeps(),
    checkIn: { getCheckIn: () => ("unavailable" in writer ? writer : { writer }) },
  });
}

beforeEach(() => setup());

async function submittedApp(title = "Forward Deployed Engineer") {
  await req("PUT", "/api/resumes/bases/fde", { text: FIXTURE_RESUME });
  await req("PUT", "/api/resumes/bases/swe", { text: FIXTURE_RESUME });
  const { body } = await req("POST", "/api/jobs", { companyName: `Co ${Math.random()}`, title, location: "Chicago, IL", description: FDE_JD });
  db.update(jobs).set({ tier: "A", fitScore: 9 }).where(eq(jobs.id, body.job.id)).run();
  const a = (await req("POST", "/api/applications", { jobId: body.job.id })).body;
  db.update(applications).set({ status: "submitted", submittedAt: new Date(), tier: "A" }).where(eq(applications.id, a.id)).run();
  return a.id as number;
}

describe("daily check-in", () => {
  it("sends the counted state, turns the priorities into today's tasks, and logs the cost", async () => {
    await submittedApp();
    await req("POST", "/api/time", { bucket: "applications", minutes: 120 });

    const { body } = await req("POST", "/api/check-ins/daily");
    expect(body).toMatchObject({ type: "daily" });
    expect(body.output.verdict.kind).toBe("call_out");
    // The state it was given is saved with it, so a later read shows what the mentor actually knew.
    expect(body.state).toMatchObject({ today: { submitted: { total: 1, tierA: 1, tierB: 0 } } });
    expect(seen[0]!.trackerState).toContain("1/10 applications");

    const { tasks } = (await req("GET", "/api/tasks")).body;
    expect(tasks.map((t: { title: string }) => t.title)).toEqual(DAILY.priorities.map((p) => p.title));
    expect(tasks[0]).toMatchObject({ source: "mentor", priority: 1, bucket: "applications", estimateMinutes: 45, dueDate: body.date });
    expect(db.select().from(apiUsage).all().map((u) => u.purpose)).toContain("check_in_daily");
  });

  it("running it again replaces today's priorities, but keeps ones you've started or finished", async () => {
    await req("POST", "/api/check-ins/daily");
    const before = (await req("GET", "/api/tasks")).body.tasks;
    await req("PATCH" as "POST", `/api/tasks/${before[0].id}`, { status: "doing" });

    await req("POST", "/api/check-ins/daily");
    const after = (await req("GET", "/api/tasks")).body.tasks;
    expect(after.filter((t: { status: string }) => t.status === "doing")).toHaveLength(1);
    expect(after).toHaveLength(4); // the one you started, plus the three fresh ones
  });

  it("a check-in you've already run today doesn't run again on its own", async () => {
    expect(needsDailyCheckIn(db)).toBe(true);
    await req("POST", "/api/check-ins/daily");
    expect(needsDailyCheckIn(db)).toBe(false);
  });

  it("says plainly when it can't run, and saves nothing", async () => {
    setup({ unavailable: "no ANTHROPIC_API_KEY in .env" });
    const r = await req("POST", "/api/check-ins/daily");
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("no ANTHROPIC_API_KEY");
    expect((await req("GET", "/api/check-ins")).body.daily).toBeNull();
  });

  it("an API failure is reported, not swallowed", async () => {
    setup(fakeWriter({ fail: "overloaded_error" }));
    const r = await req("POST", "/api/check-ins/daily");
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("overloaded");
  });
});

describe("weekly review", () => {
  it("saves the ideas and makes the week's tasks, with the GitHub task among them", async () => {
    const { body } = await req("POST", "/api/check-ins/weekly");
    expect(body.output.projectIdeas).toHaveLength(6);
    expect(body.output.projectIdeas.filter((i: { wildcard: boolean }) => i.wildcard)).toHaveLength(1);

    const titles = (await req("GET", "/api/tasks")).body.tasks.map((t: { title: string }) => t.title);
    expect(titles).toContain("Build the receipt parser skeleton");
    expect(titles).toContain("GitHub: Pin the four strongest repos and archive the tutorial ones.");
    expect((await req("GET", "/api/check-ins")).body.weekly.type).toBe("weekly");
  });

  it("is due on Sundays only, and once a week", () => {
    expect(needsWeeklyReview(db, FRIDAY)).toBe(false);
    expect(needsWeeklyReview(db, new Date("2026-11-01T18:00:00Z"))).toBe(true); // Sunday
  });

  it("sends the skills recent postings asked for, so the ideas aren't invented from nothing", async () => {
    await req("POST", "/api/check-ins/weekly");
    expect(seen[0]).toHaveProperty("skillsToBuild");
    expect(seen[0]!.trackerState).toContain("Week (from");
  });
});
