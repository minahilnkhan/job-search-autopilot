import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "../src/db/client";
import { apiUsage, applications, companies, jobs } from "../src/db/schema";
import { getShortlist, listRuns, runPipeline, type PipelineDeps } from "../src/services/pipeline";
import { parseAshby, parseGreenhouse, parseLever } from "../src/sources/boards";
import type { FetchBoard } from "../src/sources/types";
import { shouldCatchUp } from "../src/scheduler";
import { monthSpend } from "../src/services/usage";
import { createJob } from "../src/services/jobs";
import { FDE_JD, fakeScorer, GOOD_JUDGMENT, makeTestDb } from "./helpers";

const NOW = new Date("2026-10-23T12:00:00Z"); // 7:00 in Chicago
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8"));

// Three companies, one per job board, served from the saved fixtures.
const fixtureBoards: FetchBoard = async (b) => {
  if (b.token === "broken") throw new Error("Job board returned HTTP 500");
  return { greenhouse: () => parseGreenhouse(fixture("greenhouse.json")), lever: () => parseLever(fixture("lever.json")), ashby: () => parseAshby(fixture("ashby.json")) }[b.atsType]();
};

let db: DB;
beforeEach(() => {
  db = makeTestDb();
  db.insert(companies)
    .values([
      { name: "Acme GH", atsType: "greenhouse", atsBoardToken: "acmegh", tags: ["ai-native"], eVerify: "confirmed" },
      { name: "Acme Lever", atsType: "lever", atsBoardToken: "acmelever" },
      { name: "Acme Ashby", atsType: "ashby", atsBoardToken: "acmeashby", warmContact: true },
      { name: "No Board Inc" },
    ])
    .run();
});

const deps = (scorer = fakeScorer().scorer): PipelineDeps => ({
  fetchBoard: fixtureBoards,
  getScorer: () => ({ scorer }),
  now: () => NOW,
});

describe("Phase 2 acceptance: a run produces a ranked shortlist with score breakdowns", () => {
  it("fetch → filter → score → shortlist", async () => {
    const { scorer, calls } = fakeScorer();
    const run = await runPipeline(db, deps(scorer), "schedule");

    expect(run.status).toBe("ok");
    expect(run.stats).toMatchObject({ companies: 3, companiesFailed: 0, postingsSeen: 5, newJobs: 5, passedFilters: 4, scored: 4 });

    // The sales posting is screened out before any AI call.
    expect(calls.map((c) => c.title)).not.toContain("Account Executive - Enterprise");
    const ae = db.select().from(jobs).where(eq(jobs.title, "Account Executive - Enterprise")).get()!;
    expect(ae.filterFailReasons.map((r) => r.code)).toContain("off_target_role");
    expect(ae.scoredAt).toBeNull();

    // Ranked: score, then freshness, then Chicago/remote.
    const list = getShortlist(db)!;
    expect(list.date).toBe("2026-10-23");
    expect(list.run?.id).toBe(run.id);
    expect(list.entries.map((e) => `${e.rank}. ${e.job.title} (${e.job.fitScore})`)).toEqual([
      "1. Forward Deployed Engineer (9)", // AI-native bonus, posted 4 days ago
      "2. Solutions Engineer (9)", // warm-contact bonus, 8 days old
      "3. Software Engineer, New Grad (8)", // remote / Chicago breaks the tie
      "4. Software Engineer (Contract) (8)",
    ]);

    // Every entry carries its full breakdown.
    const top = list.entries[0]!.job;
    expect(top.tier).toBe("A");
    expect(top.scoreBreakdown).toMatchObject({
      requirementsMatch: 4,
      roleSignal: 2,
      stackMatch: 2,
      strategicBonus: 1,
      total: 9,
      model: "claude-haiku-5-5",
    });
    expect(top.scoreBreakdown!.requirements).toHaveLength(4);
  });

  it("the board's 'Contract' commitment reaches the filters as a warning", async () => {
    await runPipeline(db, deps(), "manual");
    const c = db.select().from(jobs).where(eq(jobs.title, "Software Engineer (Contract)")).get()!;
    expect(c.filterFailReasons.map((r) => r.code)).toContain("employment_contract");
  });
});

describe("re-runs and failures", () => {
  it("a second run dedupes: nothing new, nothing re-scored, last-seen updated", async () => {
    await runPipeline(db, deps(), "schedule");
    const { scorer, calls } = fakeScorer();
    const later = new Date(NOW.getTime() + 86_400_000);
    const run = await runPipeline(db, { ...deps(scorer), now: () => later }, "schedule");
    expect(run.stats).toMatchObject({ postingsSeen: 5, newJobs: 0, scored: 0 });
    expect(calls).toHaveLength(0);
    const fde = db.select().from(jobs).where(eq(jobs.title, "Forward Deployed Engineer")).get()!;
    expect(fde.lastSeenAt?.getTime()).toBe(later.getTime());
  });

  it("without an API key it still fetches and filters, and says why scoring was skipped", async () => {
    const run = await runPipeline(db, { ...deps(), getScorer: () => ({ unavailable: "no ANTHROPIC_API_KEY." }) }, "manual");
    expect(run.status).toBe("partial");
    expect(run.message).toContain("Scoring skipped: no ANTHROPIC_API_KEY");
    expect(run.stats?.newJobs).toBe(5);
    expect(getShortlist(db)!.entries).toHaveLength(0);
  });

  it("records a failing job board on the company and keeps going", async () => {
    db.update(companies).set({ atsBoardToken: "broken" }).where(eq(companies.name, "Acme Lever")).run();
    const run = await runPipeline(db, deps(), "manual");
    expect(run.status).toBe("partial");
    expect(run.stats).toMatchObject({ companiesFailed: 1, scored: 2 });
    const lever = db.select().from(companies).where(eq(companies.name, "Acme Lever")).get()!;
    expect(lever.atsLastStatus).toBe("failed: Job board returned HTTP 500");
    const gh = db.select().from(companies).where(eq(companies.name, "Acme GH")).get()!;
    expect(gh.atsLastStatus).toBe("ok: 2 postings");
  });

  it("one failed scoring call doesn't stop the others", async () => {
    const run = await runPipeline(db, deps(fakeScorer(GOOD_JUDGMENT, { failFor: "New Grad" }).scorer), "manual");
    expect(run.stats).toMatchObject({ scored: 3, scoreErrors: 1 });
    expect(run.message).toContain("model overloaded");
  });

  it("respects the per-run scoring cap and leaves the rest for next time", async () => {
    const { settings } = await import("../src/db/schema");
    const row = db.select().from(settings).get()!;
    db.update(settings).set({ pipeline: { ...row.pipeline, maxScoresPerRun: 1 } }).run();
    const run = await runPipeline(db, deps(), "manual");
    expect(run.stats).toMatchObject({ scored: 1, skippedOverCap: 3 });
  });

  it("refuses to start a second run while one is going", async () => {
    const slow: FetchBoard = () => new Promise((r) => setTimeout(() => r([]), 50));
    const first = runPipeline(db, { ...deps(), fetchBoard: slow }, "manual");
    await expect(runPipeline(db, deps(), "manual")).rejects.toThrow("already in progress");
    await first;
    expect(listRuns(db)).toHaveLength(1);
  });
});

describe("shortlist rules", () => {
  it("leaves out jobs you've applied to and honors the company cap", async () => {
    await runPipeline(db, deps(), "schedule");
    const fde = db.select().from(jobs).where(eq(jobs.title, "Forward Deployed Engineer")).get()!;
    const newGrad = db.select().from(jobs).where(eq(jobs.title, "Software Engineer, New Grad")).get()!;
    db.insert(applications).values({ jobId: fde.id, status: "submitted", submittedAt: NOW }).run();
    db.insert(applications).values({ jobId: newGrad.id, status: "approved", approvedAt: NOW }).run();
    await runPipeline(db, deps(), "manual");
    const titles = getShortlist(db)!.entries.map((e) => e.job.title);
    expect(titles).not.toContain("Forward Deployed Engineer");
    // Acme Lever: 1 recent application → only 1 more slot, and New Grad is applied to.
    expect(titles).toEqual(["Solutions Engineer", "Software Engineer (Contract)"]);
  });

  it("also scores jobs you pasted by hand", async () => {
    createJob(db, { companyName: "Pasted Co", title: "FDE", location: "Chicago, IL", description: FDE_JD }, NOW);
    const { scorer, calls } = fakeScorer();
    await runPipeline(db, deps(scorer), "manual");
    expect(calls.map((c) => c.companyName)).toContain("Pasted Co");
  });
});

describe("cost tracking", () => {
  it("logs every call with its cost", async () => {
    await runPipeline(db, deps(), "manual");
    const rows = db.select().from(apiUsage).all();
    expect(rows).toHaveLength(4);
    // 1200 in × $0.10 + 400 out × $0.50 + 5000 cache reads × $0.01, per million
    expect(rows[0]!.costUsd).toBeCloseTo(0.00037, 8);
    const month = monthSpend(db, NOW);
    expect(month.calls).toBe(4);
    expect(month.costUsd).toBeCloseTo(0.00148, 8);
  });
});

describe("scheduler catch-up", () => {
  const base = { enabled: true, today: "2026-10-23", dailyTime: "07:00", lastCompletedRunDate: "2026-10-22" };
  it("runs when today's time has passed and nothing completed today", () => {
    expect(shouldCatchUp({ ...base, timeNow: "09:15" })).toBe(true);
  });
  it("waits if it's not time yet", () => {
    expect(shouldCatchUp({ ...base, timeNow: "06:59" })).toBe(false);
  });
  it("doesn't run twice in a day", () => {
    expect(shouldCatchUp({ ...base, timeNow: "09:15", lastCompletedRunDate: "2026-10-23" })).toBe(false);
  });
  it("does nothing when turned off", () => {
    expect(shouldCatchUp({ ...base, timeNow: "09:15", enabled: false })).toBe(false);
  });
});

describe("account problems", () => {
  it("stops the run on the first 'credit balance too low' error instead of trying every job", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    let calls = 0;
    const broke: PipelineDeps["getScorer"] = () => ({
      scorer: async () => {
        calls++;
        throw new Anthropic.BadRequestError(
          400,
          { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } },
          "Your credit balance is too low to access the Anthropic API.",
          new Headers()
        );
      },
    });
    const run = await runPipeline(db, { ...deps(), getScorer: broke }, "manual");
    expect(calls).toBeLessThanOrEqual(1 + 4); // the cache-warming call, plus at most one per in-flight worker
    expect(run.status).toBe("partial");
    expect(run.message).toContain("no credits");
    expect(run.message).toContain("platform.claude.com/settings/billing");
    expect(run.stats).toMatchObject({ scored: 0, scoreErrors: 0 });
    // Nothing is lost: the jobs stay unscored and the next run picks them up.
    const next = await runPipeline(db, deps(), "manual");
    expect(next.stats?.scored).toBe(4);
  });
});
