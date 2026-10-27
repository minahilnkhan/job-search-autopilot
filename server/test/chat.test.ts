import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { jobs, settings, applications } from "../src/db/schema";
import { FDE_JD, FIXTURE_FACTS, FIXTURE_RESUME, OFFLINE_PIPELINE, fakeRenderer, makeTestDb, prepDeps } from "./helpers";
import type { ChatInput, ChatEdits } from "../src/llm/chat";

async function setup(reply: (input: ChatInput) => { reply: string; edits: ChatEdits }, renderer = fakeRenderer()) {
  const db = makeTestDb();
  db.update(settings).set({ standardAnswers: [{ question: "When can you start?", answer: "Two weeks." }] }).run();
  const seen: ChatInput[] = [];
  const app = buildApp(db, {
    pipeline: OFFLINE_PIPELINE,
    prep: prepDeps({ renderer }),
    submit: {
      openPage: async () => {
        throw new Error("not used");
      },
      facts: () => FIXTURE_FACTS,
      getChat: () => ({
        writer: async (input) => {
          seen.push(input);
          return { ...reply(input), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5-5" };
        },
      }),
      getFollowUp: () => ({
        writer: async (input) => ({ text: `Following up on the ${input.title} role at ${input.companyName}.`, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5-5" }),
      }),
    },
  });
  const req = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method, url, payload: payload as object, headers });
    return { status: res.statusCode, body: res.json() };
  };
  await req("PUT", "/api/resumes/bases/fde", { text: FIXTURE_RESUME });
  await req("PUT", "/api/resumes/bases/swe", { text: FIXTURE_RESUME });
  const job = (await req("POST", "/api/jobs", { companyName: "Acme AI", title: "Software Engineer", location: "Chicago, IL", description: FDE_JD })).body.job;
  db.update(jobs).set({ tier: "B", fitScore: 6 }).where(eq(jobs.id, job.id)).run();
  const a = (await req("POST", "/api/applications", { jobId: job.id })).body;
  await req("POST", `/api/applications/${a.id}/approve`);
  const code = (await req("GET", "/api/extension-pairing")).body.code;
  return { db, req, a, h: { "x-autopilot-token": code }, seen };
}

describe("extension chat", () => {
  it("proposes Truth-Checked edits, blocks DO NOT CLAIM and work-auth changes, and applying keeps it approved", async () => {
    const { req, a, h, seen } = await setup(() => ({
      reply: "Shortened it.",
      edits: {
        lines: [
          { id: "0.0.0", text: "Owned the Word Splitter LLM feature end to end" },
          { id: "0.0.1", text: "Cut search latency 60% at Acme Learning" },
        ],
        answers: [
          { question: "When can you start?", answer: "Three weeks after an offer." },
          { question: "Are you legally authorized to work in the United States?", answer: "No" },
          { question: "Why Acme?", answer: "I build customer-facing LLM features." },
        ],
      },
    }));
    const p = (await req("POST", `/api/extension/applications/${a.id}/chat`, { message: "tweak it", history: [{ role: "user", text: "hi" }], formQuestions: ["Why Acme?"] }, h)).body;
    expect(seen[0]!.formQuestions).toEqual(["Why Acme?"]);
    expect(seen[0]!.resumeLines).toContain("[0.0.0]");
    expect(p.reply).toBe("Shortened it.");
    expect(p.edits.map((e: { kind: string; key: string }) => `${e.kind}:${e.key}`)).toEqual(["line:0.0.0", "answer:When can you start?", "answer:Why Acme?"]);
    expect(p.blocked.map((b: { reason: string }) => b.reason).join(" ")).toMatch(/DO NOT CLAIM|inventory/);
    expect(p.blocked.map((b: { label: string }) => b.label)).toContain("Are you legally authorized to work in the United States?");

    const r = (await req("POST", `/api/extension/applications/${a.id}/chat/apply`, { edits: p.edits }, h)).body;
    expect(r).toMatchObject({ status: "approved", resumeChanged: true, message: null });
    const d = (await req("GET", `/api/applications/${a.id}`)).body;
    expect(d.resume.sections[0].entries[0].bullets[0]).toBe("Owned the Word Splitter LLM feature end to end");
    expect(d.answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ question: "When can you start?", answer: "Three weeks after an offer." }),
      expect.objectContaining({ question: "Why Acme?", source: "generated" }),
    ]));
  });

  it("sends it back to Review when the edit pushes the resume past one page", async () => {
    let pages = 1;
    const base = fakeRenderer();
    const renderer: typeof base = async (c, dir) => ({ ...(await base(c, dir)), pages });
    const { req, a, h } = await setup(() => ({ reply: "Added.", edits: { lines: [{ id: "0.0.0", text: "Owned the Word Splitter feature end to end, with teachers" }], answers: [] } }), renderer);
    pages = 2;
    const p = (await req("POST", `/api/extension/applications/${a.id}/chat`, { message: "add" }, h)).body;
    const r = (await req("POST", `/api/extension/applications/${a.id}/chat/apply`, { edits: p.edits }, h)).body;
    expect(r.status).toBe("draft"); // "Needs a fix" in Applications
    expect(r.message).toContain("one page");
  });

  it("drafts a follow-up for a submitted application", async () => {
    const { db, req, a } = await setup(() => ({ reply: "", edits: { lines: [], answers: [] } }));
    expect((await req("POST", `/api/applications/${a.id}/follow-up/draft`)).status).toBe(409);
    db.update(applications).set({ status: "submitted", submittedAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(applications.id, a.id)).run();
    const r = (await req("POST", `/api/applications/${a.id}/follow-up/draft`)).body;
    expect(r.text).toBe("Following up on the Software Engineer role at Acme AI.");
    expect(r.warning).toBeNull();
  });

  it("summary counts what's waiting at each step", async () => {
    const { req } = await setup(() => ({ reply: "", edits: { lines: [], answers: [] } }));
    const s = (await req("GET", "/api/summary")).body;
    expect(s).toMatchObject({ approved: 1, review: 0, today: { submitted: 0, target: 10 }, week: { target: 70 } }); // 10 a day × 7 days (mentor prompt v2)
  });
});
