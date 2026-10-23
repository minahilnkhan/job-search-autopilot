import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { DEFAULT_SETTINGS } from "../src/domain/settingsDefaults";
import { FDE_JD, makeTestDb } from "./helpers";

let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  app = buildApp(makeTestDb());
});

const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });

describe("Phase 1 acceptance: paste a JD → stored, hard-filtered, with fail reasons", () => {
  it("extract → save → list", async () => {
    const extract = await post("/api/jobs/extract", { title: "Senior Forward Deployed Engineer", location: "Chicago, IL", description: `${FDE_JD}\n5+ years of experience required.` });
    expect(extract.statusCode).toBe(200);
    const { fields } = extract.json();
    expect(fields.yearsRequired).toBe(5);

    const save = await post("/api/jobs", {
      companyName: "Acme AI",
      title: "Senior Forward Deployed Engineer",
      location: "Chicago, IL",
      url: "https://example.com/jobs/1",
      description: `${FDE_JD}\n5+ years of experience required.`,
      fields,
    });
    expect(save.statusCode).toBe(201);
    const { job, duplicate } = save.json();
    expect(duplicate).toBe(false);
    expect(job.hardFilterPass).toBe(false);
    const fails = job.filterReasons.filter((r: { severity: string }) => r.severity === "fail");
    expect(fails.map((r: { code: string }) => r.code).sort()).toEqual(["experience_4plus", "title_senior"]);
    expect(fails.every((r: { message: string }) => r.message.length > 0)).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/jobs" });
    expect(list.json()).toHaveLength(1);
  });

  it("second paste of the same job returns the existing one", async () => {
    const body = { companyName: "Acme AI", title: "FDE", location: "Chicago, IL", description: FDE_JD };
    const first = (await post("/api/jobs", body)).json();
    const second = await post("/api/jobs", body);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ duplicate: true, job: { id: first.job.id } });
  });

  it("preview runs filters without saving", async () => {
    const { fields } = (await post("/api/jobs/extract", { title: "FDE", description: FDE_JD })).json();
    const preview = await post("/api/jobs/preview", { companyName: "New Co", title: "FDE", location: "Toronto, Canada", fields });
    expect(preview.json().pass).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/jobs" })).json()).toHaveLength(0);
  });

  it("PATCH edits fields and re-filters", async () => {
    const { job } = (await post("/api/jobs", { companyName: "Acme AI", title: "FDE", location: "Chicago, IL", description: FDE_JD })).json();
    const res = await app.inject({ method: "PATCH", url: `/api/jobs/${job.id}`, payload: { location: "London, UK" } });
    expect(res.json().hardFilterPass).toBe(false);
  });

  it("rejects bad input with 400 and field paths", async () => {
    const res = await post("/api/jobs", { companyName: "", title: "FDE", description: "short" });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(["companyName", "description"]));
  });

  it("404 for a missing job", async () => {
    expect((await app.inject({ method: "GET", url: "/api/jobs/999" })).statusCode).toBe(404);
  });
});

describe("companies", () => {
  it("create, reject case-insensitive duplicate, confirm E-Verify re-filters jobs", async () => {
    const created = await post("/api/companies", { name: "Acme AI", tags: ["ai-native"] });
    expect(created.statusCode).toBe(201);
    expect((await post("/api/companies", { name: "acme ai" })).statusCode).toBe(409);

    const { job } = (await post("/api/jobs", { companyName: "Acme AI", title: "FDE", location: "Chicago, IL", description: FDE_JD })).json();
    expect(job.filterReasons.map((r: { code: string }) => r.code)).toEqual(["everify_unknown"]);

    const patch = await app.inject({ method: "PATCH", url: `/api/companies/${created.json().id}`, payload: { eVerify: "confirmed" } });
    expect(patch.json().refilteredJobs).toBe(1);
    const after = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json();
    expect(after.filterReasons).toEqual([]);
  });
});

describe("settings", () => {
  it("returns defaults with fixed work-auth answers", async () => {
    const res = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    expect(res.workAuth).toEqual({ authorizedToWorkInUS: "Yes", requiresSponsorshipNowOrFuture: "Yes" });
    expect(res.capReviewDate).toBe("2026-11-06");
  });

  it("validates and saves", async () => {
    const next = { ...DEFAULT_SETTINGS, targets: { ...DEFAULT_SETTINGS.targets, appsPerDay: 8 } };
    expect((await app.inject({ method: "PUT", url: "/api/settings", payload: next })).json().targets.appsPerDay).toBe(8);

    const over = { ...DEFAULT_SETTINGS, targets: { ...DEFAULT_SETTINGS.targets, hoursPerWeekCap: 20 } };
    expect((await app.inject({ method: "PUT", url: "/api/settings", payload: over })).statusCode).toBe(400);
  });
});
