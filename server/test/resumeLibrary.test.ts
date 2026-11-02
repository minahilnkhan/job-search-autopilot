import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { getBaseRow } from "../src/services/resumes";
import type { DB } from "../src/db/client";
import { FDE_JD, FIXTURE_RESUME, OFFLINE_PIPELINE, makeTestDb, prepDeps } from "./helpers";

// The Resumes tab: named versions beside the two bases. What matters here is
// that a version is held to the same Truth Check as a base, and that adding
// versions never changes which base an application is built from.

let db: DB;
let app: ReturnType<typeof buildApp>;

const req = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as object });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};

beforeEach(async () => {
  db = makeTestDb();
  app = buildApp(db, { pipeline: OFFLINE_PIPELINE, prep: prepDeps() });
  await req("PUT", "/api/resumes/bases/fde", { text: FIXTURE_RESUME });
  await req("PUT", "/api/resumes/bases/swe", { text: FIXTURE_RESUME });
});

describe("resume versions", () => {
  it("lists the two bases first, tagged FDE and SWE", async () => {
    const { body } = await req("GET", "/api/resumes");
    expect(body.map((d: { key: string; roleTag: string }) => [d.key, d.roleTag])).toEqual([
      ["base:fde", "fde"],
      ["base:swe", "swe"],
    ]);
    expect(body[0].text).toContain("# Test Person");
  });

  it("a new version starts as a copy, with its own name and role tag", async () => {
    const { status, body } = await req("POST", "/api/resumes", { name: "Applied AI", roleTag: "applied_ai", from: "base:swe" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: "version", name: "Applied AI", roleTag: "applied_ai", baseType: "swe", hasPdf: true });
    expect(body.text).toBe((await req("GET", "/api/resumes")).body[1].text);
    expect(body.key).toMatch(/^lib:\d+$/);
  });

  it("editing a version runs the same Truth Check as a base", async () => {
    const v = (await req("POST", "/api/resumes", { name: "Consulting", roleTag: "consulting", from: "base:fde" })).body;
    const planted = v.text.replace("- Owned the Word Splitter feature end to end", "- Cut latency 60% by tightening Claude prompts");
    const { body } = await req("PUT", `/api/resumes/${v.key}`, { text: planted });
    expect(body.truth.pass).toBe(false);
    expect(body.truth.issues.map((i: { kind: string }) => i.kind)).toContain("do_not_claim");
    expect(body.versionId).not.toBe(v.versionId); // a new row; the old wording is kept as history
  });

  it("versions never change which base an application starts from", async () => {
    const before = getBaseRow(db, "fde")!.id;
    const v = (await req("POST", "/api/resumes", { name: "FDE, tighter", roleTag: "fde", from: "base:fde" })).body;
    await req("PUT", `/api/resumes/${v.key}`, { text: v.text.replace("Lead Instructor", "Lead Roblox Instructor") });
    expect(getBaseRow(db, "fde")!.id).toBe(before);

    const job = (await req("POST", "/api/jobs", { companyName: "Co", title: "Forward Deployed Engineer", location: "Chicago, IL", description: FDE_JD })).body.job;
    const a = (await req("POST", "/api/applications", { jobId: job.id })).body;
    expect(a.resumeText).toContain("Lead Instructor");
    expect(a.resumeText).not.toContain("Lead Roblox Instructor");
  });

  it("renames and retags a version, but not a base", async () => {
    const v = (await req("POST", "/api/resumes", { name: "Teaching", roleTag: "other", from: "base:fde" })).body;
    const r = await req("PATCH", `/api/resumes/${v.key}`, { name: "Technical education", roleTag: "education" });
    expect(r.body).toMatchObject({ name: "Technical education", roleTag: "education" });
    expect((await req("PATCH", "/api/resumes/base:fde", { roleTag: "education" })).status).toBe(409);
  });

  it("deletes a version, and refuses to delete a base", async () => {
    const v = (await req("POST", "/api/resumes", { name: "Scratch", roleTag: "other", from: "base:swe" })).body;
    expect((await req("DELETE", `/api/resumes/${v.key}`)).status).toBe(200);
    expect((await req("GET", "/api/resumes")).body).toHaveLength(2);
    expect((await req("DELETE", "/api/resumes/base:swe")).status).toBe(409);
  });

  it("serves each version's PDF", async () => {
    const v = (await req("POST", "/api/resumes", { name: "Applied AI", roleTag: "applied_ai", from: "base:swe" })).body;
    const res = await app.inject({ method: "GET", url: `/api/resumes/${v.key}/file.pdf` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("rejects an unknown role tag and a malformed resume", async () => {
    expect((await req("POST", "/api/resumes", { name: "X", roleTag: "astronaut", from: "base:fde" })).status).toBe(400);
    const v = (await req("POST", "/api/resumes", { name: "X", roleTag: "other", from: "base:fde" })).body;
    expect((await req("PUT", `/api/resumes/${v.key}`, { text: "no name heading" })).status).toBe(409);
  });
});
