import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { trackerState, trackerStateText } from "../src/services/tracker";
import type { DB } from "../src/db/client";
import { OFFLINE_PIPELINE, makeTestDb, prepDeps } from "./helpers";

// One project a week. The rules that matter are the prompt's: hours come from
// the week's time logs, and a project isn't "shipped" without a repo and one
// measured result.

let db: DB;
let app: ReturnType<typeof buildApp>;

const req = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as object });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};

beforeEach(() => {
  db = makeTestDb();
  app = buildApp(db, { pipeline: OFFLINE_PIPELINE, prep: prepDeps() });
});

describe("weekly project", () => {
  it("starts in this week and picks up the week's project hours", async () => {
    const p = (await req("POST", "/api/projects", { title: "Receipt parser", summary: "Messy receipts through a real API.", skills: ["Docker"] })).body;
    expect(p).toMatchObject({ title: "Receipt parser", status: "active", hoursLogged: 0, skills: ["Docker"] });

    await req("POST", "/api/time", { bucket: "projects", minutes: 150 });
    await req("POST", "/api/time", { bucket: "prep", minutes: 60 }); // a different bucket, not the project's
    const { current } = (await req("GET", "/api/projects")).body;
    expect(current.hoursLogged).toBe(2.5);
  });

  it("won't ship without a repo and one measured result", async () => {
    const p = (await req("POST", "/api/projects", { title: "Receipt parser" })).body;
    const noRepo = await req("PATCH", `/api/projects/${p.id}`, { status: "shipped" });
    expect(noRepo.status).toBe(409);
    expect(noRepo.body.error).toContain("GitHub URL");

    const noResult = await req("PATCH", `/api/projects/${p.id}`, { status: "shipped", repoUrl: "github.com/mkhan2025/receipts" });
    expect(noResult.status).toBe(409);
    expect(noResult.body.error).toContain("measured");

    const ok = await req("PATCH", `/api/projects/${p.id}`, { status: "shipped", repoUrl: "github.com/mkhan2025/receipts", resultMetric: "92% of 60 test receipts parsed" });
    expect(ok.body).toMatchObject({ status: "shipped", resultMetric: "92% of 60 test receipts parsed" });
  });

  it("shows up in the state the mentor reads", async () => {
    await req("POST", "/api/projects", { title: "Receipt parser", skills: ["Docker", "GitHub Actions"] });
    await req("POST", "/api/time", { bucket: "projects", minutes: 180 });
    const t = trackerState(db);
    expect(t.project).toMatchObject({ title: "Receipt parser", hoursLogged: 3 });
    expect(trackerStateText(t)).toContain("This week's project: Receipt parser (active, 3h logged, building Docker, GitHub Actions)");
  });

  it("a project from a past week doesn't count as this week's", async () => {
    await req("POST", "/api/projects", { title: "Old one", weekStart: "2026-01-05" });
    expect((await req("GET", "/api/projects")).body.current).toBeNull();
    expect((await req("GET", "/api/projects")).body.all).toHaveLength(1);
  });
});
