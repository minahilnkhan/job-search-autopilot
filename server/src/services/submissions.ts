import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desc, eq, inArray } from "drizzle-orm";
import type { Page } from "playwright";
import type { DB } from "../db/client";
import { applications, companies, jobs } from "../db/schema";
import { assertTransition } from "../domain/applicationStatus";
import { applyTarget } from "../submit/applyUrl";
import { isOutsideUS } from "../domain/hardFilters";
import { looksBlocked, looksSubmitted, siteKey } from "../submit/confirm";
import type { OpenPage } from "../submit/browser";
import { fillControl, prefillPage, readFormForCopy, type QuestionHandler } from "../submit/prefill";
import type { FormControl } from "../submit/plan";
import type { Frame } from "playwright";
import { runTruthCheck } from "../domain/truthCheck";
import type { InventoryFacts } from "../domain/inventory";
import type { AnswerWriter } from "../llm/answers";
import type { ChatWriter, FollowUpWriter } from "../llm/chat";
import { ScoreError } from "../llm/scoreJob";
import { accountProblem } from "../llm/errors";
import { recordUsage } from "./usage";
import { settings as settingsTable } from "../db/schema";
import { ConflictError, NotFoundError } from "./jobs";
import { applicationFile, getApplication } from "./applications";
import { getSettings, localDate } from "./settings";
import type { Answer, ApplicationStatus, PrefillReport, Settings, SubmitAsk, SubmitSession, TrackedApplication } from "../../../shared/types";

// Phase 4, assisted submit: open the real form in a browser window on your
// machine, fill what we can, and wait for you to press Submit. The app never
// clicks Submit; it only notices the confirmation page (or you tell it).

export type SubmitDeps = {
  /** Opens a visible browser tab at the URL. Tests pass a headless one. */
  openPage: OpenPage;
  /** Drafts answers to questions nothing prepared covers ("Why Anthropic?"). */
  getAnswerWriter?: (s: Settings) => { writer: AnswerWriter } | { unavailable: string };
  /** Inventory facts for the Truth Check on drafted answers. */
  facts?: () => InventoryFacts;
  /** The extension's chat, and Tracker follow-up drafts. */
  getChat?: (s: Settings) => { writer: ChatWriter } | { unavailable: string };
  getFollowUp?: (s: Settings) => { writer: FollowUpWriter } | { unavailable: string };
  watchEveryMs?: number;
};

type Live = {
  state: SubmitSession["state"];
  report: PrefillReport | null;
  page: Page | null;
  timer: NodeJS.Timeout | null;
  asks: Map<string, { frame: Frame; control: FormControl }>; // where to type each of your replies
};
const sessions = new Map<number, Live>();

/** Days until a Tier A follow-up, per the mentor prompt (7–10 days). Tier B gets none. */
export const FOLLOW_UP_DAYS = 7;

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function getSubmitSession(db: DB, id: number): SubmitSession {
  const live = sessions.get(id);
  if (live) return { applicationId: id, state: live.state, report: live.report };
  const app = getApplication(db, id);
  const r = app.prefillReport;
  // Reports saved before asks/notices existed.
  return { applicationId: id, state: app.status === "approved" ? "closed" : "submitted", report: r ? { ...r, asks: r.asks ?? [], notices: r.notices ?? [] } : null };
}

/** Copy the PDF to a temp folder under a proper name ("Minahil_Khan_Resume.pdf", not "resume.pdf"). */
function uploadCopy(db: DB, id: number): string {
  const f = applicationFile(db, id, "pdf");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `autopilot-upload-${id}-`));
  const out = path.join(dir, f.filename);
  fs.copyFileSync(f.path, out);
  return out;
}

export async function openAndPrefill(db: DB, id: number, deps: SubmitDeps): Promise<SubmitSession> {
  const app = getApplication(db, id);
  if (app.status !== "approved") throw new ConflictError("Approve the application first; only approved applications are opened for submitting.");
  const live = sessions.get(id);
  if (live?.page && !live.page.isClosed() && live.state !== "closed") {
    await live.page.bringToFront().catch(() => {});
    return getSubmitSession(db, id);
  }

  const row = db
    .select({ source: jobs.source, externalId: jobs.externalId, url: jobs.url, token: companies.atsBoardToken })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(jobs.id, app.jobId))
    .get()!;
  const target = applyTarget(row, row.token);
  if (!target) throw new ConflictError("This job has no application link. Use the copy panel and apply on the company's site.");
  const resumePath = uploadCopy(db, id);
  const settings = getSettings(db);

  const entry: Live = { state: "opening", report: null, page: null, timer: null, asks: new Map() };
  sessions.set(id, entry);
  const save = (report: PrefillReport) => {
    entry.report = report;
    db.update(applications).set({ prefillReport: report, lastActivityAt: new Date() }).where(eq(applications.id, id)).run();
  };

  const values = { profile: settings.profile, answers: app.answers, jobOutsideUS: isOutsideUS(app.job.location), resumeFileName: path.basename(resumePath) };
  const askFor = (label: string, required: boolean, question: string, draft: string | null, i: number): SubmitAsk => ({
    id: `ask-${i + 1}`,
    label: clean(label),
    question,
    draft,
    required,
    answer: null,
    filled: false,
  });

  // Sites that block automated browsers: read the form in a hidden window
  // (no filling, no submitting), prepare every answer, and you apply in your
  // own browser from the copy panel.
  if (settings.submit.ownBrowserFor.includes(siteKey(target.ats, target.url))) {
    void (async () => {
      let page: Page | null = null;
      try {
        page = await deps.openPage(target.url, { headless: true });
        const drafted: Answer[] = [];
        const r = await readFormForCopy(page, values, questionHandler(db, id, deps, settings, drafted));
        if (drafted.length) saveAnswers(db, id, drafted);
        save({
          ats: target.ats,
          url: target.url,
          mode: "copy",
          prepared: r.prepared,
          filled: [],
          leftForYou: r.leftForYou,
          resumeUploaded: false,
          notices: r.notices,
          asks: r.asks.map((a, i) => askFor(a.control.label, a.control.required, a.question, a.draft, i)),
          error: null,
          at: Date.now(),
        });
      } catch (err) {
        save({ ats: target.ats, url: target.url, mode: "copy", prepared: [], filled: [], leftForYou: [], resumeUploaded: false, notices: [], asks: [], error: `Couldn't read the form (${(err as Error).message.split("\n")[0]}). The copy panel still has your details and answers.`, at: Date.now() });
      } finally {
        await page?.close().catch(() => {});
        entry.state = "closed";
      }
    })();
    return getSubmitSession(db, id);
  }

  // Runs in the background; the UI polls the session.
  void (async () => {
    let page: Page;
    try {
      page = await deps.openPage(target.url);
      entry.page = page;
    } catch (err) {
      entry.state = "closed";
      save({ ats: target.ats, url: target.url, filled: [], leftForYou: [], resumeUploaded: false, notices: [], asks: [], error: `Couldn't open the form: ${(err as Error).message.split("\n")[0]}`, at: Date.now() });
      return;
    }
    page.on("close", () => {
      if (entry.state !== "submitted") entry.state = "closed";
      if (entry.timer) clearInterval(entry.timer);
    });
    try {
      const drafted: Answer[] = [];
      const onQuestions = questionHandler(db, id, deps, settings, drafted);
      const r = await prefillPage(page, values, resumePath, onQuestions);
      const { readError, asks, ...found } = r;
      const error = found.filled.length ? null : readError ? `Couldn't read the form (${readError}). Use the copy panel.` : "Found nothing to fill on this page. Use the copy panel.";
      const reportAsks: SubmitAsk[] = asks.map((a, i) => {
        const askId = `ask-${i + 1}`;
        entry.asks.set(askId, { frame: a.frame, control: a.control });
        return askFor(a.control.label, a.control.required, a.question, a.draft, i);
      });
      // Drafted answers join the application's answers, so they show in the copy panel and history.
      if (drafted.length) saveAnswers(db, id, drafted);
      save({ ats: target.ats, url: target.url, mode: "prefill", ...found, asks: reportAsks, error, at: Date.now() });
    } catch (err) {
      save({ ats: target.ats, url: target.url, filled: [], leftForYou: [], resumeUploaded: false, notices: [], asks: [], error: `Prefill stopped: ${(err as Error).message.split("\n")[0]}. Use the copy panel.`, at: Date.now() });
    }
    if (entry.state === "opening") entry.state = page.isClosed() ? "closed" : "open";
    // Watch for the "thank you for applying" page.
    entry.timer = setInterval(async () => {
      if (page.isClosed() || entry.state !== "open") return;
      try {
        for (const frame of page.frames()) {
          const body = await frame.locator("body").innerText({ timeout: 1000 }).catch(() => "");
          if (looksBlocked(body) && entry.report && !entry.report.notices.some((n) => n.startsWith("This site flagged"))) {
            // Don't fight it: remember the site and hand you the copy panel.
            const key = siteKey(target.ats, target.url);
            const current = getSettings(db).submit.ownBrowserFor;
            if (!current.includes(key)) db.update(settingsTable).set({ submit: { ownBrowserFor: [...current, key] } }).where(eq(settingsTable.id, 1)).run();
            save({
              ...entry.report,
              notices: [
                ...entry.report.notices,
                `This site flagged the app's window as automated. Don't submit again there: open the form in your own browser and paste from the copy panel. From now on, ${key} forms go straight to the copy panel (change it in Settings).`,
              ],
            });
            return;
          }
          if (looksSubmitted(frame.url(), body)) {
            markSubmitted(db, id);
            entry.state = "submitted";
            if (entry.timer) clearInterval(entry.timer);
            return;
          }
        }
      } catch {
        // page navigating; try again next tick
      }
    }, deps.watchEveryMs ?? 2000);
  })();

  return getSubmitSession(db, id);
}

/** Adds answers to the application, replacing any with the same question. */
function saveAnswers(db: DB, id: number, add: Answer[]) {
  const row = db.select({ answers: applications.answers }).from(applications).where(eq(applications.id, id)).get();
  const answers = [...(row?.answers ?? [])];
  for (const a of add) {
    const i = answers.findIndex((x) => x.question === a.question);
    if (i === -1) answers.push(a);
    else if (answers[i]!.source !== "fixed") answers[i] = a;
  }
  db.update(applications).set({ answers }).where(eq(applications.id, id)).run();
}

const clean = (label: string) => label.replace(/[✱*]\s*$/, "").replace(/\s+/g, " ").trim();

/**
 * Questions nothing prepared covers: the answer writer drafts what it can from
 * your inventory (each draft is Truth-Checked before it's typed), and turns
 * the rest into questions for you in the chat.
 */
function questionHandler(db: DB, id: number, deps: SubmitDeps, settings: Settings, drafted: Answer[]): QuestionHandler {
  return async (controls) => {
    const askAll = (why: string) => ({
      answers: [],
      asks: controls.filter((c) => c.required).map((c) => ({ controlId: c.id, question: `The form asks "${clean(c.label)}". What should I put? (${why})`, draft: null })),
    });
    const w = deps.getAnswerWriter?.(settings);
    if (!w) return askAll("drafting answers isn't set up");
    if ("unavailable" in w) return askAll(w.unavailable);
    const app = getApplication(db, id);
    let result;
    try {
      result = await w.writer({
        companyName: app.companyName,
        title: app.jobTitle,
        description: app.job.description,
        resumeText: app.resumeText,
        questions: controls.map((c) => ({ id: c.id, label: clean(c.label), kind: c.kind, options: c.options.map((o) => o.text), required: c.required })),
      });
      recordUsage(db, { purpose: "answers", model: result.model, usage: result.usage, jobId: app.jobId, now: new Date() });
    } catch (err) {
      if (err instanceof ScoreError && err.usage) recordUsage(db, { purpose: "answers", model: settings.models.tailoring, usage: err.usage, jobId: app.jobId, now: new Date() });
      return askAll(accountProblem(err) ?? "drafting failed");
    }
    const facts = deps.facts?.();
    const answers: { controlId: string; value: string }[] = [];
    const asks: { controlId: string; question: string; draft: string | null }[] = [];
    for (const item of result.items) {
      const c = controls.find((x) => x.id === item.id);
      if (!c) continue;
      const label = clean(c.label);
      if (item.action === "answer" && item.answer.trim()) {
        const report = facts ? runTruthCheck({ lines: [{ where: `Answer › ${label}`, text: item.answer }] }, facts) : null;
        const problem = report?.issues.find((i) => i.severity === "fail");
        if (problem) {
          asks.push({ controlId: c.id, question: `I drafted an answer to "${label}", but the Truth Check flagged it: ${problem.message} Edit it below or tell me what to say.`, draft: item.answer });
        } else {
          answers.push({ controlId: c.id, value: item.answer.trim() });
          drafted.push({ question: label, answer: item.answer.trim(), source: "generated" });
        }
      } else if (item.action === "ask" && item.ask.trim()) {
        asks.push({ controlId: c.id, question: item.ask.trim(), draft: null });
      }
    }
    return { answers, asks };
  };
}

/** Your reply to one of the app's questions: typed into the open form, saved on the application, and optionally kept for every application. */
export async function answerAsk(db: DB, id: number, askId: string, answer: string, remember: boolean, facts?: () => InventoryFacts): Promise<SubmitSession> {
  const live = sessions.get(id);
  const report = live?.report ?? getApplication(db, id).prefillReport;
  const ask = report?.asks.find((a) => a.id === askId);
  if (!report || !ask) throw new NotFoundError("That question isn't open any more. Press Open and prefill again.");
  const value = answer.trim();
  if (!value) throw new ConflictError("Type an answer first.");
  // A reply to a flagged draft is a claim about your work: it gets the same check.
  if (ask.draft !== null && facts) {
    const problem = runTruthCheck({ lines: [{ where: ask.label, text: value }] }, facts()).issues.find((i) => i.severity === "fail");
    if (problem) throw new ConflictError(`Still flagged by the Truth Check: ${problem.message}`);
  }

  const where = live?.asks.get(askId);
  let filled = false;
  if (where && live?.page && !live.page.isClosed()) filled = await fillControl(where.frame, where.control, value).catch(() => false);
  ask.answer = value;
  ask.filled = filled;
  if (filled) report.filled.push({ label: ask.label, value });
  if (report.mode === "copy") report.prepared = [...(report.prepared ?? []).filter((p) => p.label !== ask.label), { label: ask.label, value }];
  db.update(applications).set({ prefillReport: report, lastActivityAt: new Date() }).where(eq(applications.id, id)).run();
  if (live) live.report = report;
  saveAnswers(db, id, [{ question: ask.label, answer: value, source: "standard" }]);

  if (remember) {
    const s = getSettings(db);
    const standardAnswers = [...s.standardAnswers.filter((a) => a.question !== ask.label), { question: ask.label, answer: value }];
    db.update(settingsTable).set({ standardAnswers }).where(eq(settingsTable.id, 1)).run();
  }
  return getSubmitSession(db, id);
}

/** You pressed Submit on the real form (or the app saw the confirmation page). */
export function markSubmitted(db: DB, id: number, now = new Date()) {
  const app = db.select().from(applications).where(eq(applications.id, id)).get();
  if (!app) throw new NotFoundError(`Application ${id} not found`);
  if (app.status === "submitted") return getApplication(db, id);
  assertTransition(app.status, "submitted");
  const today = localDate(now, getSettings(db).pipeline.timezone);
  db.update(applications)
    .set({ status: "submitted", submittedAt: now, lastActivityAt: now, followUpDue: app.tier === "A" ? addDays(today, FOLLOW_UP_DAYS) : null })
    .where(eq(applications.id, id))
    .run();
  const live = sessions.get(id);
  if (live) live.state = "submitted";
  return getApplication(db, id);
}

/** Undo a "submitted" that was wrong (e.g. the confirmation check misfired). */
export function unmarkSubmitted(db: DB, id: number, now = new Date()) {
  const app = getApplication(db, id);
  assertTransition(app.status, "approved");
  db.update(applications).set({ status: "approved", submittedAt: null, followUpDue: null, lastActivityAt: now }).where(eq(applications.id, id)).run();
  const live = sessions.get(id);
  if (live && live.state === "submitted") live.state = live.page && !live.page.isClosed() ? "open" : "closed";
  return getApplication(db, id);
}

const TRACKED: ApplicationStatus[] = ["submitted", "screen", "interview", "offer", "rejected", "ghosted"];
const ENDED: ApplicationStatus[] = ["offer", "rejected", "ghosted", "withdrawn"];

/** Move a submitted application along: screen, interview, offer, rejected, ghosted, withdrawn. */
export function setTrackedStatus(db: DB, id: number, status: ApplicationStatus, now = new Date()) {
  const app = getApplication(db, id);
  if (!TRACKED.includes(app.status)) throw new ConflictError("Only submitted applications are tracked here.");
  assertTransition(app.status, status);
  db.update(applications)
    .set({ status, lastActivityAt: now, ...(ENDED.includes(status) || status === "screen" || status === "interview" ? { followUpDue: null } : {}) })
    .where(eq(applications.id, id))
    .run();
  return getApplication(db, id);
}

/** "Followed up" clears it; "later" pushes it out three days. */
export function updateFollowUp(db: DB, id: number, action: "done" | "later", now = new Date()) {
  const app = getApplication(db, id);
  if (!app.followUpDue) throw new ConflictError("This application has no follow-up due.");
  const today = localDate(now, getSettings(db).pipeline.timezone);
  db.update(applications)
    .set({ followUpDue: action === "done" ? null : addDays(today, 3), lastActivityAt: now })
    .where(eq(applications.id, id))
    .run();
  return getApplication(db, id);
}

export function listTracked(db: DB): TrackedApplication[] {
  const rows = db
    .select({ app: applications, job: jobs, companyName: companies.name })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(inArray(applications.status, [...TRACKED, "withdrawn"]))
    .orderBy(desc(applications.submittedAt))
    .all()
    .filter((r) => r.app.submittedAt); // withdrawn before submitting isn't tracked
  return rows.map((r) => ({
    id: r.app.id,
    jobId: r.job.id,
    jobTitle: r.job.title,
    companyName: r.companyName,
    tier: r.app.tier,
    fitScore: r.job.fitScore,
    status: r.app.status,
    truthPass: r.app.truthReport?.pass ?? false,
    truthOverride: r.app.truthOverride ?? null,
    failCount: 0,
    snoozedUntil: null,
    createdAt: r.app.createdAt.getTime(),
    submittedAt: r.app.submittedAt?.getTime() ?? null,
    followUpDue: r.app.followUpDue ?? null,
    lastActivityAt: r.app.lastActivityAt?.getTime() ?? null,
    jobUrl: r.job.url,
  }));
}

/** For tests: forget open sessions. */
export function resetSubmitSessions() {
  for (const s of sessions.values()) if (s.timer) clearInterval(s.timer);
  sessions.clear();
}

// ---- Chrome extension: filling in your own browser -----------------------------

/** Approved applications, best match for the page you're on first. */
export function matchApplications(db: DB, pageUrl: string) {
  const rows = db
    .select({ id: applications.id, status: applications.status, title: jobs.title, company: companies.name, source: jobs.source, externalId: jobs.externalId, url: jobs.url, token: companies.atsBoardToken })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(applications.status, "approved"))
    .orderBy(desc(applications.id))
    .all();
  let page: URL | null = null;
  try {
    page = new URL(pageUrl);
  } catch {
    page = null;
  }
  const score = (r: (typeof rows)[number]) => {
    if (!page) return 0;
    const urls = [applyTarget(r, r.token)?.url, r.url].filter((u): u is string => !!u);
    let best = 0;
    for (const u of urls) {
      let t: URL;
      try {
        t = new URL(u);
      } catch {
        continue;
      }
      const sameHost = t.hostname.replace(/^www\./, "") === page.hostname.replace(/^www\./, "");
      if (r.externalId && page.href.includes(r.externalId)) best = Math.max(best, sameHost ? 3 : 2);
      else if (sameHost && page.pathname.startsWith(t.pathname.replace(/\/(apply|application)\/?$/, ""))) best = Math.max(best, 2);
    }
    return best;
  };
  const scored = rows.map((r) => ({ id: r.id, jobTitle: r.title, companyName: r.company, score: score(r) })).sort((a, b) => b.score - a.score);
  const top = scored.filter((r) => r.score > 0 && r.score === scored[0]!.score);
  return { best: top.length === 1 ? top[0]!.id : null, applications: scored.map(({ score: _s, ...r }) => r) };
}

/** What the extension needs to fill the form: your details, prepared answers, note, and the resume file. */
export function extensionPayload(db: DB, id: number) {
  const app = getApplication(db, id);
  if (app.status !== "approved") throw new ConflictError("Approve the application in Review first.");
  const settings = getSettings(db);
  const f = applicationFile(db, id, "pdf");
  return {
    applicationId: id,
    jobTitle: app.jobTitle,
    companyName: app.companyName,
    values: { profile: settings.profile, answers: app.answers, jobOutsideUS: isOutsideUS(app.job.location), resumeFileName: f.filename },
    resume: { fileName: f.filename, base64: fs.readFileSync(f.path).toString("base64") },
  };
}

/**
 * Questions on the page nothing prepared covers: draft answers (Truth-Checked)
 * or turn them into questions for you. The questions also appear in the app's
 * "Questions for you" chat for this application.
 */
export async function extensionQuestions(db: DB, id: number, deps: SubmitDeps, controls: FormControl[], pageUrl: string) {
  const app = getApplication(db, id);
  if (app.status !== "approved") throw new ConflictError("Approve the application in Review first.");
  const drafted: Answer[] = [];
  const out = controls.length ? await questionHandler(db, id, deps, getSettings(db), drafted)(controls) : { answers: [], asks: [] };
  if (drafted.length) saveAnswers(db, id, drafted);
  const asks: SubmitAsk[] = out.asks.map((q, i) => {
    const c = controls.find((x) => x.id === q.controlId)!;
    return { id: `ask-${i + 1}`, label: clean(c.label), question: q.question, draft: q.draft, required: c.required, answer: null, filled: false, controlKey: c.id };
  });
  const report: PrefillReport = {
    ats: "other",
    url: pageUrl,
    mode: "extension",
    filled: [],
    leftForYou: [],
    resumeUploaded: false,
    notices: [],
    asks,
    error: null,
    at: Date.now(),
  };
  db.update(applications).set({ prefillReport: report, lastActivityAt: new Date() }).where(eq(applications.id, id)).run();
  sessions.delete(id); // the app's own window isn't involved
  return { answers: out.answers, asks };
}

/** The extension's account of what it filled, saved so Review shows it. */
export function saveExtensionReport(db: DB, id: number, r: Pick<PrefillReport, "filled" | "leftForYou" | "resumeUploaded" | "notices">) {
  const app = getApplication(db, id);
  const prev = app.prefillReport;
  const report: PrefillReport = {
    ats: prev?.ats ?? "other",
    url: prev?.url ?? "",
    mode: "extension",
    asks: prev?.mode === "extension" ? (prev.asks ?? []) : [],
    error: null,
    at: Date.now(),
    ...r,
  };
  db.update(applications).set({ prefillReport: report, lastActivityAt: new Date() }).where(eq(applications.id, id)).run();
  return report;
}
