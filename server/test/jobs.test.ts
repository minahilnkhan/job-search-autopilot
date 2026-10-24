import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applications, companies } from "../src/db/schema";
import { createJob, refilterCompanyJobs, updateJob, ConflictError } from "../src/services/jobs";
import { applicationHistory } from "../src/services/history";
import { dedupeKey, normalizeTitle } from "../src/domain/normalize";
import { FDE_JD, makeTestDb, fields } from "./helpers";
import type { DB } from "../src/db/client";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-23T12:00:00Z");

let db: DB;
beforeEach(() => {
  db = makeTestDb();
});

const paste = (over: Partial<Parameters<typeof createJob>[1]> = {}) =>
  createJob(db, { companyName: "Acme AI", title: "Forward Deployed Engineer", location: "Chicago, IL", description: FDE_JD, ...over }, NOW);

function addApplication(jobId: number, status: "draft" | "approved" | "submitted", daysAgo: number) {
  const at = new Date(NOW.getTime() - daysAgo * DAY);
  db.insert(applications)
    .values({ jobId, status, approvedAt: status === "draft" ? null : at, submittedAt: status === "submitted" ? at : null })
    .run();
}

describe("normalize / dedupe key", () => {
  it("folds case, punctuation and Sr.", () => {
    expect(normalizeTitle("Sr. Software Engineer - Platform")).toBe("senior software engineer platform");
    expect(dedupeKey("Acme AI", "Software Engineer (Backend)", "Chicago, IL")).toBe(
      dedupeKey("ACME AI", "software engineer backend", "chicago IL")
    );
  });

  it("keeps genuinely different roles apart", () => {
    expect(dedupeKey("Acme", "Software Engineer", "Chicago, IL")).not.toBe(dedupeKey("Acme", "Software Engineer II", "Chicago, IL"));
  });
});

describe("createJob", () => {
  it("stores the job with filter results and creates the company", () => {
    const { duplicate, job } = paste();
    expect(duplicate).toBe(false);
    expect(job.companyName).toBe("Acme AI");
    expect(job.yearsRequired).toBe(2);
    expect(job.hardFilterPass).toBe(true);
    // New company → E-Verify unknown → warning, but still a pass.
    expect(job.filterReasons.map((r) => r.code)).toEqual(["everify_unknown"]);
  });

  it("reuses an existing company regardless of capitalization", () => {
    paste();
    paste({ companyName: "ACME ai", title: "Solutions Engineer" });
    expect(db.select().from(companies).all()).toHaveLength(1);
  });

  it("dedupes the same company + title + location", () => {
    const first = paste();
    const second = paste({ companyName: "acme ai", title: "forward deployed engineer", location: "Chicago, IL" });
    expect(second.duplicate).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it("a different location is a different job", () => {
    paste();
    expect(paste({ location: "New York, NY" }).duplicate).toBe(false);
  });

  it("stores fail reasons for a failing JD", () => {
    const { job } = paste({ title: "Senior FDE", description: "6+ years of experience. Must be a U.S. citizen." });
    expect(job.hardFilterPass).toBe(false);
    expect(job.filterReasons.filter((r) => r.severity === "fail").map((r) => r.code)).toEqual(
      expect.arrayContaining(["experience_4plus", "title_senior", "citizenship"])
    );
  });

  it("uses reviewed fields when given instead of re-extracting", () => {
    const { job } = paste({ fields: fields({ yearsRequired: 5 }) });
    expect(job.yearsRequired).toBe(5);
    expect(job.hardFilterPass).toBe(false);
  });
});

describe("application history (30-day window)", () => {
  it("counts approved-or-later apps; drafts don't count", () => {
    const a = paste({ title: "Role A" }).job;
    const b = paste({ title: "Role B" }).job;
    addApplication(a.id, "submitted", 3);
    addApplication(b.id, "draft", 1);
    const h = applicationHistory(db, { companyId: a.companyId, title: "Role C", now: NOW });
    expect(h.companyAppsLast30Days).toBe(1);
    expect(h.alreadyApplied).toBe(false);
  });

  it("window edge: exactly 30 days ago counts, 31 does not", () => {
    const a = paste({ title: "Role A" }).job;
    const b = paste({ title: "Role B" }).job;
    addApplication(a.id, "submitted", 30);
    addApplication(b.id, "submitted", 31);
    expect(applicationHistory(db, { companyId: a.companyId, title: "Role C", now: NOW }).companyAppsLast30Days).toBe(1);
  });

  it("falls back to approved_at when not yet submitted", () => {
    const a = paste({ title: "Role A" }).job;
    addApplication(a.id, "approved", 2);
    expect(applicationHistory(db, { companyId: a.companyId, title: "Role C", now: NOW }).companyAppsLast30Days).toBe(1);
  });

  it("2 apps in 30 days fails the third job at that company", () => {
    const a = paste({ title: "Role A" }).job;
    const b = paste({ title: "Role B" }).job;
    addApplication(a.id, "submitted", 5);
    addApplication(b.id, "submitted", 10);
    const c = paste({ title: "Role C" }).job;
    expect(c.hardFilterPass).toBe(false);
    expect(c.filterReasons.map((r) => r.code)).toContain("company_cap_30d");
  });

  it("a re-post of a role you applied to (new location) fails as already applied", () => {
    const a = paste().job;
    addApplication(a.id, "submitted", 40); // outside the 30-day window
    const repost = paste({ location: "Remote - US" }).job;
    expect(repost.filterReasons.map((r) => r.code)).toContain("already_applied");
  });

  it("a job's own application doesn't count against it when re-filtered", () => {
    const a = paste().job;
    addApplication(a.id, "submitted", 1);
    expect(updateJob(db, a.id, {}, NOW).hardFilterPass).toBe(true);
  });
});

describe("updateJob / refilter", () => {
  it("re-runs filters on edited fields", () => {
    const { job } = paste();
    const updated = updateJob(db, job.id, { fields: { ...job.extractedFields, yearsRequired: 5 } }, NOW);
    expect(updated.hardFilterPass).toBe(false);
  });

  it("refuses an edit that would duplicate another job", () => {
    paste({ title: "Role A" });
    const b = paste({ title: "Role B" }).job;
    expect(() => updateJob(db, b.id, { title: "Role A" }, NOW)).toThrow(ConflictError);
  });

  it("confirming E-Verify on the company clears the warning on its jobs", () => {
    const { job } = paste();
    db.update(companies).set({ eVerify: "confirmed" }).where(eq(companies.id, job.companyId)).run();
    refilterCompanyJobs(db, job.companyId, NOW);
    expect(updateJob(db, job.id, {}, NOW).filterReasons).toEqual([]);
  });
});

describe("deleting jobs", () => {
  it("deletes selected jobs, withdraws unsubmitted applications, keeps submitted ones, and a re-paste brings one back", async () => {
    const { buildApp } = await import("../src/app");
    const { applications, jobs } = await import("../src/db/schema");
    const { makeTestDb, OFFLINE_PIPELINE, prepDeps, FDE_JD } = await import("./helpers");
    const { eq } = await import("drizzle-orm");
    const db = makeTestDb();
    const app = buildApp(db, { pipeline: OFFLINE_PIPELINE, prep: prepDeps() });
    const req = async (method: "GET" | "POST", url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, payload: payload as object });
      return { status: res.statusCode, body: res.json() };
    };
    const add = async (title: string) => (await req("POST", "/api/jobs", { companyName: "Acme AI", title, location: "Chicago, IL", description: FDE_JD })).body.job.id as number;
    const a = await add("Software Engineer");
    const b = await add("Solutions Engineer");
    const c = await add("Forward Deployed Engineer");
    db.update(jobs).set({ status: "shortlisted" }).where(eq(jobs.id, b)).run();
    db.insert(applications).values({ jobId: b, tier: "B", status: "approved" }).run();
    db.insert(applications).values({ jobId: c, tier: "A", status: "submitted", submittedAt: new Date() }).run();

    const r = await req("POST", "/api/jobs/delete", { ids: [a, b, c] });
    expect(r.body.deleted).toBe(2);
    expect(r.body.kept).toEqual([expect.objectContaining({ id: c })]);
    expect((await req("GET", "/api/jobs")).body.map((j: { id: number }) => j.id)).toEqual([c]);
    expect(db.select().from(applications).where(eq(applications.jobId, b)).get()).toMatchObject({ status: "withdrawn", reviewReason: "Job deleted" });

    const back = await req("POST", "/api/jobs", { companyName: "Acme AI", title: "Software Engineer", location: "Chicago, IL", description: FDE_JD });
    expect(back.body).toMatchObject({ duplicate: true, job: { id: a, status: "new" } });
    expect((await req("GET", "/api/jobs")).body.map((j: { id: number }) => j.id).sort()).toEqual([a, c].sort());
  });
});
