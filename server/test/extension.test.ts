import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { jobs, settings } from "../src/db/schema";
import { FDE_JD, FIXTURE_FACTS, FIXTURE_RESUME, OFFLINE_PIPELINE, makeTestDb, prepDeps } from "./helpers";

async function setup() {
  const db = makeTestDb();
  db.update(settings).set({ standardAnswers: [{ question: "When can you start?", answer: "Two weeks." }] }).run();
  const app = buildApp(db, {
    pipeline: OFFLINE_PIPELINE,
    prep: prepDeps(),
    submit: {
      openPage: async () => {
        throw new Error("not used");
      },
      facts: () => FIXTURE_FACTS,
      getAnswerWriter: () => ({
        writer: async (input) => ({
          model: "claude-sonnet-5-5",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          items: input.questions.map((q) =>
            /why/i.test(q.label) ? { id: q.id, action: "answer" as const, answer: "I build customer-facing LLM features.", ask: "" } : { id: q.id, action: "ask" as const, answer: "", ask: "What salary should I put?" }
          ),
        }),
      }),
    },
  });
  const req = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method, url, payload: payload as object, headers });
    return { status: res.statusCode, body: res.json() };
  };
  await req("PUT", "/api/resumes/bases/fde", { text: FIXTURE_RESUME });
  await req("PUT", "/api/resumes/bases/swe", { text: FIXTURE_RESUME });
  const job = (await req("POST", "/api/jobs", { companyName: "Acme AI", title: "Software Engineer", url: "https://job-boards.greenhouse.io/acme/jobs/4012", location: "Chicago, IL", description: FDE_JD })).body.job;
  db.update(jobs).set({ tier: "B", fitScore: 6, externalId: "4012" }).where(eq(jobs.id, job.id)).run();
  const a = (await req("POST", "/api/applications", { jobId: job.id })).body;
  return { db, req, a };
}

describe("Chrome extension API", () => {
  it("refuses without the pairing code, and the code can be replaced", async () => {
    const { req } = await setup();
    expect((await req("GET", "/api/extension/ping")).status).toBe(401);
    expect((await req("GET", "/api/extension/ping", undefined, { "x-autopilot-token": "wrong" })).status).toBe(401);
    const code = (await req("GET", "/api/extension-pairing")).body.code;
    expect(code).toMatch(/^[\w-]{20,}$/);
    expect((await req("GET", "/api/extension-pairing")).body.code).toBe(code); // stable
    expect((await req("GET", "/api/extension/ping", undefined, { "x-autopilot-token": code })).body).toEqual({ ok: true });
    const fresh = (await req("POST", "/api/extension-pairing/new")).body.code;
    expect(fresh).not.toBe(code);
    expect((await req("GET", "/api/extension/ping", undefined, { "x-autopilot-token": code })).status).toBe(401);
    expect((await req("GET", "/api/settings")).body.extensionToken).toBeUndefined();
  });

  it("ignores requests addressed to another host (DNS rebinding)", async () => {
    const { req } = await setup();
    expect((await req("GET", "/api/health", undefined, { host: "evil.example:3001" })).status).toBe(403);
    expect((await req("GET", "/api/health", undefined, { host: "127.0.0.1:3001" })).status).toBe(200);
  });

  it("matches the page to the approved application, hands over the payload, drafts or asks, and records the submit", async () => {
    const { req, a } = await setup();
    const code = (await req("GET", "/api/extension-pairing")).body.code;
    const h = { "x-autopilot-token": code };
    expect((await req("GET", `/api/extension/applications/${a.id}/payload`, undefined, h)).status).toBe(409); // not approved yet
    await req("POST", `/api/applications/${a.id}/approve`);

    const m = (await req("POST", "/api/extension/match", { url: "https://job-boards.greenhouse.io/acme/jobs/4012?gh_src=x" }, h)).body;
    expect(m.best).toBe(a.id);
    expect((await req("POST", "/api/extension/match", { url: "https://example.com/" }, h)).body.best).toBeNull();

    const p = (await req("GET", `/api/extension/applications/${a.id}/payload`, undefined, h)).body;
    expect(p.resume.fileName).toBe("Test_Person_Resume.pdf");
    expect(Buffer.from(p.resume.base64, "base64").toString()).toContain("%PDF");
    expect(p.values.answers.some((x: { source: string }) => x.source === "fixed")).toBe(true);

    const control = (id: string, label: string) => ({ id, kind: "textarea", label, hints: "", required: true, value: "", options: [] });
    const q = (await req("POST", `/api/extension/applications/${a.id}/questions`, { url: "https://job-boards.greenhouse.io/acme/jobs/4012", controls: [control("0|ap5", "Why Acme?"), control("0|ap6", "Salary expectations?")] }, h)).body;
    expect(q.answers).toEqual([{ controlId: "0|ap5", value: "I build customer-facing LLM features." }]);
    expect(q.asks).toEqual([expect.objectContaining({ id: "ask-1", label: "Salary expectations?", controlKey: "0|ap6" })]);

    const ans = (await req("POST", `/api/extension/applications/${a.id}/answer`, { askId: "ask-1", answer: "Open to the range.", filled: true }, h)).body;
    expect(ans.ask).toMatchObject({ answer: "Open to the range.", filled: true });
    await req("POST", `/api/extension/applications/${a.id}/report`, { filled: [{ label: "Email", value: "x" }], leftForYou: [], resumeUploaded: true, notices: [] }, h);
    const detail = (await req("GET", `/api/applications/${a.id}`)).body;
    expect(detail.prefillReport).toMatchObject({ mode: "extension", resumeUploaded: true, asks: [expect.objectContaining({ answer: "Open to the range." })] });
    expect(detail.answers).toEqual(expect.arrayContaining([expect.objectContaining({ question: "Why Acme?", source: "generated" })]));

    expect((await req("POST", `/api/extension/applications/${a.id}/submitted`, {}, h)).body.status).toBe("submitted");
  });
});
