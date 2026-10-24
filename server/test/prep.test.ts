import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { applications, apiUsage, companies, jobs, settings } from "../src/db/schema";
import { DEFAULT_SETTINGS } from "../src/domain/settingsDefaults";
import { applicationHistory } from "../src/services/history";
import { parseResume, serializeResume } from "../src/domain/resumeFormat";
import { applyPlan, chooseBase, summaryTitle } from "../src/domain/tailorPlan";
import type { DB } from "../src/db/client";
import { FDE_JD, FIXTURE_RESUME, OFFLINE_PIPELINE, fakeRenderer, fakeTailor, makeTestDb, prepDeps } from "./helpers";
import type { PrepDeps } from "../src/services/applications";

let db: DB;
let app: ReturnType<typeof buildApp>;
let deps: PrepDeps;

const req = async (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as object });
  return { status: res.statusCode, body: res.json() };
};

const FILLED_ANSWERS = [
  { question: "How did you hear about this role?", answer: "Their careers page." },
  { question: "When can you start?", answer: "Two weeks after an offer." },
];

function setup(over: Partial<PrepDeps> = {}) {
  db = makeTestDb();
  // Defaults contain placeholders on purpose; most tests want them filled in.
  db.update(settings).set({ standardAnswers: FILLED_ANSWERS }).run();
  deps = prepDeps(over);
  app = buildApp(db, { pipeline: OFFLINE_PIPELINE, prep: deps });
}

async function addJob(title: string, tier: "A" | "B", fitScore = tier === "A" ? 9 : 6) {
  const { body } = await req("POST", "/api/jobs", { companyName: "Acme AI", title, location: "Chicago, IL", description: FDE_JD });
  db.update(jobs).set({ tier, fitScore }).where(eq(jobs.id, body.job.id)).run();
  return body.job.id as number;
}

async function saveBases() {
  expect((await req("PUT", "/api/resumes/bases/fde", { text: FIXTURE_RESUME })).status).toBe(200);
  expect((await req("PUT", "/api/resumes/bases/swe", { text: FIXTURE_RESUME })).status).toBe(200);
}

beforeEach(() => setup());

describe("tailoring plan: summary, added and removed bullets", () => {
  it("puts a summary first under a clean headline, shifts ids, adds and drops bullets by the ids the model saw", () => {
    const base = parseResume(FIXTURE_RESUME);
    const { content, changes } = applyPlan(base, {
      summary: { headline: "Software Engineer shipping production LLM features", text: "Software Engineer who built a production Claude pipeline." },
      bulletOrder: [{ entry: "0.0", order: [2, 0, 1] }],
      lineEdits: [{ id: "0.0.0", after: "Owned the Word Splitter LLM feature end to end", reason: "LLM" }],
      removeBullets: [{ id: "0.0.1", reason: "Weakest for this job" }],
      addBullets: [{ entry: "0.0", position: 0, text: "Worked with teachers to check the engine's output", reason: "SME collaboration" }],
    });
    expect(content.sections[0]).toEqual({ title: "Software Engineer shipping production LLM features", entries: [], lines: ["Software Engineer who built a production Claude pipeline."] });
    expect(content.sections[1]!.entries[0]!.bullets).toEqual([
      "Worked with teachers to check the engine's output",
      "Integrated submit/poll APIs and caching designed by a senior engineer",
      "Owned the Word Splitter LLM feature end to end",
    ]);
    expect(changes.map((c) => c.id)).toEqual(["0.L0", "1.0.order", "1.0.2", "1.0.1.removed", "1.0.0"]);
    expect(changes.find((c) => c.id === "1.0.1.removed")).toMatchObject({ before: "Built the Claude pipeline with prompts, structured output and validation", after: "(removed)" });
  });

  it("falls back to 'Professional Overview' for a long or symbol-laden headline, and never empties a role", () => {
    expect(summaryTitle("Engineer | AI ★")).toBe("Professional Overview");
    expect(summaryTitle("One two three four five six seven eight nine ten")).toBe("Professional Overview");
    expect(summaryTitle("Forward Deployed Engineer")).toBe("Forward Deployed Engineer");
    const base = parseResume(FIXTURE_RESUME);
    const { notes } = applyPlan(base, { lineEdits: [], bulletOrder: [], removeBullets: [{ id: "1.0.0", reason: "x" }] });
    expect(notes).toEqual(['Ignored removing "1.0.0".']); // Education has one entry with one bullet at most
  });
});

describe("resume format", () => {
  it("round-trips through text", () => {
    const r = parseResume(FIXTURE_RESUME);
    expect(r.name).toBe("Test Person");
    expect(r.sections.map((s) => s.title)).toEqual(["Experience", "Education", "Skills"]);
    expect(r.sections[0]!.entries[0]).toMatchObject({ org: "Acme Learning", location: "Remote", role: "Software Engineer", dates: "June 2025 – Present" });
    expect(r.sections[2]!.lines).toEqual(["Languages: TypeScript, Python, PHP"]);
    expect(parseResume(serializeResume(r))).toEqual(r);
  });

  it("picks the FDE base for customer-facing titles and SWE otherwise", () => {
    expect(chooseBase("Forward Deployed Engineer")).toBe("fde");
    expect(chooseBase("Solutions Engineer")).toBe("fde");
    expect(chooseBase("Software Engineer, Backend")).toBe("swe");
  });

  it("applies line edits and reorders by id, ignoring edits to lines that don't exist", () => {
    const base = parseResume(FIXTURE_RESUME);
    const { content, changes, notes } = applyPlan(base, {
      bulletOrder: [{ entry: "0.0", order: [1, 0, 2] }],
      lineEdits: [
        { id: "0.0.0", after: "Owned the Word Splitter LLM feature end to end", reason: "LLM focus" },
        { id: "9.9.9", after: "Made up", reason: "?" },
      ],
    });
    expect(content.sections[0]!.entries[0]!.bullets).toEqual([
      "Built the Claude pipeline with prompts, structured output and validation",
      "Owned the Word Splitter LLM feature end to end", // edit followed its bullet to its new spot
      "Integrated submit/poll APIs and caching designed by a senior engineer",
    ]);
    expect(changes.map((c) => c.id)).toEqual(["0.0.order", "0.0.1"]);
    expect(notes[0]).toContain("9.9.9");
  });
});

describe("Phase 3 acceptance: a planted DO NOT CLAIM line is blocked with the reason shown", () => {
  it("tailoring that writes 'Cut latency 60%' never reaches the review queue", async () => {
    const { tailor } = fakeTailor({ lineEdits: [{ id: "0.0.1", after: "Cut latency 60% by tightening Claude prompts", reason: "Performance" }] });
    setup({ getTailor: () => ({ tailor }) });
    await saveBases();
    const jobId = await addJob("Forward Deployed Engineer", "A");

    const { status, body } = await req("POST", "/api/applications", { jobId });
    expect(status).toBe(201);
    expect(body.status).toBe("draft");
    expect(body.truth.pass).toBe(false);
    const issue = body.truth.issues.find((i: { kind: string }) => i.kind === "do_not_claim");
    expect(issue.text).toBe("Cut latency 60% by tightening Claude prompts");
    expect(issue.where).toBe("Resume › Experience › Acme Learning › bullet 2");
    expect(issue.message).toContain("DO NOT CLAIM");

    // Blocked: not in the queue, can't be approved.
    expect((await req("GET", "/api/applications?view=review")).body).toEqual([]);
    expect((await req("GET", "/api/applications?view=blocked")).body).toHaveLength(1);
    expect((await req("POST", `/api/applications/${body.id}/approve`)).status).toBe(409);

    // Fix the line → it moves to the queue → approve.
    const fixed = await req("PATCH", `/api/applications/${body.id}`, {
      lines: [{ id: issue.lineId, text: "Cut response latency by tightening Claude prompts" }],
    });
    expect(fixed.body).toMatchObject({ status: "ready_for_review", truthPass: true });
    const approved = await req("POST", `/api/applications/${body.id}/approve`);
    expect(approved.body.status).toBe("approved");
  });
});

describe("preparing", () => {
  it("Tier A: tailors, logs cost, writes a note and answers, keeps work-auth answers fixed", async () => {
    const { tailor, calls } = fakeTailor({ lineEdits: [{ id: "0.0.0", after: "Owned the Word Splitter LLM feature end to end", reason: "LLM" }] });
    setup({ getTailor: () => ({ tailor }) });
    await saveBases();
    const jobId = await addJob("Forward Deployed Engineer", "A");
    const { body } = await req("POST", "/api/applications", { jobId });

    expect(calls[0]!.baseResume).toContain("[0.0.0] Owned the Word Splitter feature end to end");
    expect(body).toMatchObject({ status: "ready_for_review", tier: "A", baseType: "fde" });
    expect(body.changes).toEqual([expect.objectContaining({ before: "Owned the Word Splitter feature end to end", after: "Owned the Word Splitter LLM feature end to end" })]);
    expect(body.recruiterNote).toContain("Claude pipeline");
    expect(body.noteBasis).toMatchObject({ companyValue: "Customer focus" });
    const sources = body.answers.map((a: { source: string }) => a.source);
    expect(sources.filter((s: string) => s === "generated")).toHaveLength(2);
    expect(body.answers.filter((a: { source: string }) => a.source === "fixed")).toEqual([
      expect.objectContaining({ answer: "Yes", question: expect.stringContaining("authorized") }),
      expect.objectContaining({ answer: "Yes", question: expect.stringContaining("sponsorship") }),
    ]);
    expect(db.select().from(apiUsage).all()).toEqual([
      expect.objectContaining({ purpose: "tailoring", model: "claude-sonnet-5-5" }),
      expect.objectContaining({ purpose: "note", model: "claude-sonnet-5-5" }),
    ]);
    const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
    expect(job.status).toBe("shortlisted");
  });

  it("Tier B: base resume and standard answers, no tailoring; placeholders in standard answers block it", async () => {
    const { tailor, calls } = fakeTailor();
    setup({ getTailor: () => ({ tailor }), getNoteWriter: undefined });
    db.update(settings).set({ standardAnswers: DEFAULT_SETTINGS.standardAnswers }).run();
    await saveBases();
    const jobId = await addJob("Software Engineer", "B");
    const { body } = await req("POST", "/api/applications", { jobId });
    expect(calls).toHaveLength(0);
    expect(body).toMatchObject({ tier: "B", baseType: "swe", changes: [], recruiterNote: null });
    // The default standard answers include "[your start date or notice period]".
    expect(body.status).toBe("draft");
    const placeholder = body.truth.issues.find((i: { kind: string }) => i.kind === "placeholder");
    expect(placeholder.where).toBe("Answer › When can you start?");

    // Fill the placeholders in place → passes.
    const idx = (q: string) => body.answers.findIndex((a: { question: string }) => a.question.startsWith(q));
    const res = await req("PATCH", `/api/applications/${body.id}`, {
      answers: [
        { index: idx("When can you start"), answer: "Two weeks after an offer." },
        { index: idx("What are your salary"), answer: "Open to discussing the range for the role." },
      ],
    });
    expect(res.body.status).toBe("ready_for_review");
  });

  it("refuses to edit fixed work-authorization answers", async () => {
    await saveBases();
    const jobId = await addJob("Software Engineer", "B");
    const { body } = await req("POST", "/api/applications", { jobId });
    const fixedIdx = body.answers.findIndex((a: { source: string }) => a.source === "fixed");
    const res = await req("PATCH", `/api/applications/${body.id}`, { answers: [{ index: fixedIdx, answer: "No" }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Settings");
  });

  it("without an API key, Tier A falls back to the base resume and says so", async () => {
    setup({ getTailor: () => ({ unavailable: "no ANTHROPIC_API_KEY in .env" }) });
    await saveBases();
    const jobId = await addJob("Forward Deployed Engineer", "A");
    const { body } = await req("POST", "/api/applications", { jobId });
    expect(body.prepNotes[0]).toContain("Not tailored (no ANTHROPIC_API_KEY");
    expect(body.changes).toEqual([]);
  });

  it("needs a base resume first", async () => {
    const jobId = await addJob("Forward Deployed Engineer", "A");
    const res = await req("POST", "/api/applications", { jobId });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("FDE base resume");
  });

  it("is idempotent per job", async () => {
    await saveBases();
    const jobId = await addJob("Software Engineer", "B");
    const a = await req("POST", "/api/applications", { jobId });
    const b = await req("POST", "/api/applications", { jobId });
    expect(b.body.id).toBe(a.body.id);
  });
});

describe("PDF problems block approval and can't be overridden", () => {
  it("a two-page resume is held back", async () => {
    // Base renders on one page; the tailored application spills onto two.
    const one = fakeRenderer({ pages: 1 });
    const two = fakeRenderer({ pages: 2 });
    setup({ renderer: (content, dir) => (dir.includes("applications") ? two(content, dir) : one(content, dir)) });
    await saveBases();
    const jobId = await addJob("Forward Deployed Engineer", "A");
    const { body } = await req("POST", "/api/applications", { jobId });
    expect(body.status).toBe("draft");
    expect(body.truth.issues.find((i: { kind: string }) => i.kind === "render").message).toContain("2 pages");
    const o = await req("POST", `/api/applications/${body.id}/override`, { reason: "I checked every line myself and they're true." });
    expect(o.body.status).toBe("draft"); // still blocked
  });

  it("no Chromium → clear setup message", async () => {
    setup({ renderer: fakeRenderer({ pdfError: 'Run "npm run setup:pdf"' }) });
    await saveBases();
    const base = (await req("GET", "/api/resumes/bases")).body[0];
    expect(base.truth.issues[0].message).toContain("npm run setup:pdf");
  });
});

describe("override, reject, snooze", () => {
  async function blockedApp() {
    const { tailor } = fakeTailor({ lineEdits: [{ id: "0.0.1", after: "Built the Claude pipeline used by 12 teams", reason: "scale" }] });
    setup({ getTailor: () => ({ tailor }) });
    await saveBases();
    const jobId = await addJob("Forward Deployed Engineer", "A");
    return (await req("POST", "/api/applications", { jobId })).body;
  }

  it("override needs a real reason, then lets it into the queue; any edit clears it", async () => {
    const a = await blockedApp();
    expect(a.truth.issues[0]).toMatchObject({ kind: "unverified_number", message: expect.stringContaining('"12"') });
    expect((await req("POST", `/api/applications/${a.id}/override`, { reason: "ok" })).status).toBe(409);
    const o = await req("POST", `/api/applications/${a.id}/override`, { reason: "12 teams is from my manager's email; adding it to the inventory." });
    expect(o.body).toMatchObject({ status: "ready_for_review", truthPass: false, truthOverride: { reason: expect.stringContaining("12 teams") } });
    const edited = await req("PATCH", `/api/applications/${a.id}`, { recruiterNote: "Short note." });
    expect(edited.body).toMatchObject({ truthOverride: null, status: "draft" });
  });

  it("reject needs a reason, dismisses the job, and doesn't count as an application", async () => {
    await saveBases();
    const jobId = await addJob("Software Engineer", "B");
    const a = (await req("POST", "/api/applications", { jobId })).body;
    expect((await req("POST", `/api/applications/${a.id}/reject`, { reason: " " })).status).toBe(409);
    const r = await req("POST", `/api/applications/${a.id}/reject`, { reason: "Mostly on-call infra work" });
    expect(r.body).toMatchObject({ status: "withdrawn", reviewReason: "Mostly on-call infra work" });
    expect(db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status).toBe("dismissed");
    const company = db.select().from(companies).get()!;
    expect(applicationHistory(db, { companyId: company.id, title: "Software Engineer", now: new Date() })).toEqual({ alreadyApplied: false, companyAppsLast30Days: 0 });
  });

  it("snooze hides it from the queue until the date", async () => {
    await saveBases();
    const jobId = await addJob("Forward Deployed Engineer", "A");
    const a = (await req("POST", "/api/applications", { jobId })).body;
    await req("POST", `/api/applications/${a.id}/snooze`, { until: "2099-01-01" });
    expect((await req("GET", "/api/applications?view=review")).body).toEqual([]);
    expect((await req("GET", "/api/applications?view=snoozed")).body).toHaveLength(1);
  });

  it("approval is per application and refuses anything not in review", async () => {
    await saveBases();
    const jobId = await addJob("Forward Deployed Engineer", "A");
    const a = (await req("POST", "/api/applications", { jobId })).body;
    expect((await req("POST", `/api/applications/${a.id}/approve`)).body.status).toBe("approved");
    expect((await req("POST", `/api/applications/${a.id}/approve`)).status).toBe(409);
    expect((await req("PATCH", `/api/applications/${a.id}`, { recruiterNote: "x" })).status).toBe(409);
    const row = db.select().from(applications).where(eq(applications.id, a.id)).get()!;
    expect(row.approvedAt).not.toBeNull();
  });
});

describe("base resume first, notes for every application, restart, background prep", () => {
  it("won't prepare from a base resume that still has problems, and says what to fix", async () => {
    await req("PUT", "/api/resumes/bases/fde", { text: FIXTURE_RESUME.replace("test@example.com", "[email]") });
    const jobId = await addJob("Forward Deployed Engineer", "A");
    const res = await req("POST", "/api/applications", { jobId });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("FDE base resume has 1 problem");
    expect(res.body.error).toContain("Fill in [email]");
  });

  it("Tier B gets a recruiter note too; 'Write a note' redrafts it", async () => {
    let n = 0;
    setup({
      getNoteWriter: () => ({
        writer: async () => ({ note: `Note number ${++n} about the Word Splitter feature.`, basis: { companyValue: `Value ${n}`, valueSource: "", story: "s", standout: "x" }, model: "claude-sonnet-5-5", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
      }),
    });
    await saveBases();
    const jobId = await addJob("Software Engineer", "B");
    const a = (await req("POST", "/api/applications", { jobId })).body;
    expect(a.recruiterNote).toBe("Note number 1 about the Word Splitter feature.");
    const again = await req("POST", `/api/applications/${a.id}/note`);
    expect(again.body.recruiterNote).toBe("Note number 2 about the Word Splitter feature.");
    expect(again.body.noteBasis.companyValue).toBe("Value 2");
  });

  it("the contact line can be fixed right in the application", async () => {
    await saveBases();
    const jobId = await addJob("Software Engineer", "B");
    const a = (await req("POST", "/api/applications", { jobId })).body;
    const res = await req("PATCH", `/api/applications/${a.id}`, { contact: "Chicago, IL | me@example.com" });
    expect(res.body.resume.contact).toBe("Chicago, IL | me@example.com");
  });

  it("emptying lines deletes them (bullets from the bottom up, an emptied section goes), but not the contact line", async () => {
    await saveBases();
    const jobId = await addJob("Software Engineer", "B");
    const a = (await req("POST", "/api/applications", { jobId })).body;
    const res = await req("PATCH", `/api/applications/${a.id}`, {
      lines: [
        { id: "0.0.0", text: "" },
        { id: "0.0.2", text: "" },
        { id: "0.0.1", text: "Built the Claude pipeline end to end" },
        { id: "2.L0", text: "  " },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.resume.sections[0].entries[0].bullets).toEqual(["Built the Claude pipeline end to end"]);
    expect(res.body.resume.sections.map((s: { title: string }) => s.title)).toEqual(["Experience", "Education"]);
    expect(res.body.changes.filter((c: { after: string }) => c.after === "(removed)")).toHaveLength(3);
    expect((await req("PATCH", `/api/applications/${a.id}`, { lines: [{ id: "contact", text: "" }] })).status).toBe(409);
  });

  it("restart rebuilds from the current base and closes the old application", async () => {
    await saveBases();
    const jobId = await addJob("Software Engineer", "B");
    const a = (await req("POST", "/api/applications", { jobId })).body;
    await req("PUT", "/api/resumes/bases/swe", { text: FIXTURE_RESUME.replace("Test Person", "Test Q. Person") });
    const b = (await req("POST", `/api/applications/${a.id}/restart`)).body;
    expect(b.id).not.toBe(a.id);
    expect(b.resume.name).toBe("Test Q. Person");
    expect((await req("GET", `/api/applications/${a.id}`)).body.status).toBe("withdrawn");
  });

  it("background prepare returns at once and shows up as in progress", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { tailor } = fakeTailor();
    setup({ getTailor: () => ({ tailor: async (i) => (await gate, tailor(i)) }) });
    await saveBases();
    const jobId = await addJob("Forward Deployed Engineer", "A");
    const res = await req("POST", "/api/applications", { jobId, background: true });
    expect(res.status).toBe(202);
    expect((await req("GET", "/api/applications/preparing")).body).toEqual([expect.objectContaining({ jobId, error: null })]);
    expect(db.select().from(jobs).where(eq(jobs.id, jobId)).get()!.status).toBe("shortlisted");
    release();
    for (let i = 0; i < 50 && (await req("GET", "/api/applications/preparing")).body.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await req("GET", "/api/applications?view=review")).body).toHaveLength(1);
  });
});
