import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { DB } from "../db/client";
import { applications, companies, jobs, resumeVersions } from "../db/schema";
import { config } from "../config";
import { removeLine, resumeLines, serializeResume, setLine } from "../domain/resumeFormat";
import { applyPlan, chooseBase, findPinnedLine, pendingQuestions, resumeForPrompt } from "../domain/tailorPlan";
import { applyTarget } from "../submit/applyUrl";
import { runTruthCheck, type CheckLine } from "../domain/truthCheck";
import { extractNumbers, numberKey } from "../domain/inventory";
import { ADDITIONS_FILE } from "../llm/context";
import { assertTransition } from "../domain/applicationStatus";
import type { InventoryFacts } from "../domain/inventory";
import type { Renderer } from "../render/renderer";
import type { Tailor } from "../llm/tailor";
import { ScoreError } from "../llm/scoreJob";
import { accountProblem } from "../llm/errors";
import { ConflictError, NotFoundError, getJob } from "./jobs";
import { getSettings, localDate } from "./settings";
import { recordUsage } from "./usage";
import { getBaseRow, resumeCheckLines, withRenderIssues } from "./resumes";
import type {
  Answer,
  ApplicationDetail,
  ApplicationStatus,
  ApplicationSummary,
  ResumeChange,
  Settings,
} from "../../../shared/types";

export type PrepDeps = {
  getTailor: (s: Settings) => { tailor: Tailor } | { unavailable: string };
  renderer: Renderer;
  facts: () => InventoryFacts;
  generatedDir?: string;
  /** Where confirmed_additions.md lives (tests point this at a temp folder). */
  privateDir?: string;
};

// Questions the tailoring model answers for Tier A. Your saved standard
// answers and the fixed work-authorization answers are added as-is.
const GENERATED_QUESTIONS = (company: string) => [
  `Why are you interested in this role at ${company}?`,
  "Tell us about a project or experience most relevant to this role.",
];

/** Work authorization comes from Settings, never from the model (hard constraint). */
export function fixedAnswers(s: Settings): Answer[] {
  return [
    { question: "Are you legally authorized to work in the United States?", answer: s.workAuth.authorizedToWorkInUS, source: "fixed" },
    {
      question: "Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)?",
      answer: s.workAuth.requiresSponsorshipNowOrFuture,
      source: "fixed",
    },
  ];
}

type AppRow = typeof applications.$inferSelect;

function appDir(id: number, deps: Pick<PrepDeps, "generatedDir">) {
  return path.join(deps.generatedDir ?? config.generatedDir, "applications", String(id));
}

const checkableAnswers = (answers: Answer[]): CheckLine[] =>
  answers.filter((a) => a.source !== "fixed").map((a) => ({ where: `Answer › ${a.question}`, text: a.answer }));

/**
 * Truth Check + render, then decide where the application sits: in the
 * review queue if it passes (or you overrode the Truth Check), otherwise
 * held as a draft with the reasons. Runs after prep and after every edit.
 */
export async function finalizeApplication(db: DB, id: number, deps: PrepDeps, now = new Date()) {
  const app = db.select().from(applications).where(eq(applications.id, id)).get();
  if (!app || !app.resumeVersionId) throw new NotFoundError(`Application ${id} not found`);
  const version = db.select().from(resumeVersions).where(eq(resumeVersions.id, app.resumeVersionId)).get()!;

  const truth = runTruthCheck(
    { lines: [...resumeCheckLines(version.content), ...checkableAnswers(app.answers ?? [])] },
    deps.facts(),
    now
  );
  const render = await deps.renderer(version.content, appDir(id, deps));
  const report = withRenderIssues(truth, render);

  // An override covers Truth Check findings you've judged fine. It can't
  // cover a missing or two-page PDF: there'd be nothing sound to submit.
  const renderBlocked = report.issues.some((i) => i.kind === "render");
  const passes = report.pass || (!!app.truthOverride && !renderBlocked);

  db.update(resumeVersions)
    .set({ filePathPdf: render.pdfPath, filePathDocx: render.docxPath, pdfPages: render.pages, truthCheckStatus: report.pass ? "pass" : app.truthOverride ? "overridden" : "fail" })
    .where(eq(resumeVersions.id, version.id))
    .run();

  let status: ApplicationStatus = app.status;
  if (app.status === "draft" && passes) status = "ready_for_review";
  if (app.status === "ready_for_review" && !passes) status = "draft";
  db.update(applications).set({ truthReport: report, status, lastActivityAt: now }).where(eq(applications.id, id)).run();
}

/**
 * Start this application over from the current base resume (e.g. after you
 * fixed [email] there). The old one is closed, not deleted; Tier A is tailored
 * again (a few cents).
 */
export async function restartApplication(db: DB, id: number, deps: PrepDeps, now = new Date()) {
  const app = loadEditable(db, id);
  db.update(applications).set({ status: "withdrawn", reviewReason: "Rebuilt from the updated base resume", lastActivityAt: now }).where(eq(applications.id, id)).run();
  try {
    return getApplication(db, await prepareApplication(db, app.jobId, deps, now));
  } catch (err) {
    // Put the old one back if the rebuild couldn't start (e.g. base still has problems).
    db.update(applications).set({ status: app.status, reviewReason: null }).where(eq(applications.id, id)).run();
    throw err;
  }
}

/** Accept → prepare. Idempotent: an open application for the job is returned as-is. */
export async function prepareApplication(db: DB, jobId: number, deps: PrepDeps, now = new Date()): Promise<number> {
  const job = getJob(db, jobId);
  if (!job.hardFilterPass) throw new ConflictError("This job fails a hard filter. Correct its fields first.");
  const open = db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.jobId, jobId), ne(applications.status, "withdrawn")))
    .get();
  if (open) return open.id;

  const baseType = chooseBase(job.title);
  const base = getBaseRow(db, baseType);
  if (!base) throw new ConflictError(`Add your ${baseType.toUpperCase()} base resume on the Resumes page first.`);
  // Fix shared problems (like [email]) once in the base, not in every application.
  const baseFails = base.truthReport?.issues.filter((i) => i.severity === "fail") ?? [];
  if (baseFails.length) {
    throw new ConflictError(
      `Your ${baseType.toUpperCase()} base resume has ${baseFails.length} ${baseFails.length === 1 ? "problem" : "problems"} to fix first on the Resumes page (for example: ${baseFails[0]!.message}). Every application starts from it.`
    );
  }

  const settings = getSettings(db);
  const tier = job.tier === "A" ? "A" : "B";
  const notes: string[] = [];
  let content = base.content;
  let changes: ResumeChange[] = [];
  let generated: Answer[] = [];
  let tailoring: AppRow["tailoring"] = null;

  if (tier === "A") {
    const t = deps.getTailor(settings);
    if ("unavailable" in t) {
      notes.push(`Not tailored (${t.unavailable}); using the ${baseType.toUpperCase()} base resume.`);
    } else {
      try {
        const result = await t.tailor({
          companyName: job.companyName,
          title: job.title,
          location: job.location,
          description: job.description,
          baseResume: resumeForPrompt(base.content),
          questions: GENERATED_QUESTIONS(job.companyName),
        });
        recordUsage(db, { purpose: "tailoring", model: result.model, usage: result.usage, jobId, now });
        const applied = applyPlan(base.content, result.plan);
        content = applied.content;
        changes = applied.changes;
        notes.push(...applied.notes);
        generated = result.plan.answers.map((a) => ({ ...a, source: "generated" as const }));
        tailoring = {
          keywordsCovered: result.plan.keywordsCovered,
          keywordsMissing: result.plan.keywordsMissing,
          honestGaps: result.plan.honestGaps,
          mustHaves: result.plan.mustHaves,
          suggestions: result.plan.suggestions,
          ...pendingQuestions(base.content, result.plan),
        };
      } catch (err) {
        if (err instanceof ScoreError && err.usage) recordUsage(db, { purpose: "tailoring", model: settings.models.tailoring, usage: err.usage, jobId, now });
        const fatal = accountProblem(err);
        notes.push(`Tailoring failed (${fatal ?? (err as Error).message}); using the base resume. You can edit lines below.`);
      }
    }
  }

  const answers: Answer[] = [
    ...generated,
    ...settings.standardAnswers.map((a) => ({ ...a, source: "standard" as const })),
    ...fixedAnswers(settings),
  ];

  const version = db.insert(resumeVersions).values({ baseType, parentId: base.id, jobId, content, diffFromBase: changes }).returning().get();
  const app = db
    .insert(applications)
    .values({ jobId, tier, resumeVersionId: version.id, answers, status: "draft", prepNotes: notes, tailoring, lastActivityAt: now })
    .returning()
    .get();
  db.update(jobs).set({ status: "shortlisted" }).where(eq(jobs.id, jobId)).run();
  await finalizeApplication(db, app.id, deps, now);
  return app.id;
}

// ---- Reading ------------------------------------------------------------------

function summarize(row: { app: AppRow; job: typeof jobs.$inferSelect; companyName: string }): ApplicationSummary {
  const report = row.app.truthReport;
  return {
    id: row.app.id,
    jobId: row.job.id,
    jobTitle: row.job.title,
    companyName: row.companyName,
    tier: row.app.tier,
    fitScore: row.job.fitScore,
    status: row.app.status,
    truthPass: report?.pass ?? false,
    truthOverride: row.app.truthOverride ?? null,
    failCount: report?.issues.filter((i) => i.severity === "fail").length ?? 0,
    snoozedUntil: row.app.snoozedUntil,
    createdAt: row.app.createdAt.getTime(),
  };
}

export type QueueView = "review" | "blocked" | "snoozed" | "approved" | "closed";

export function listApplications(db: DB, view: QueueView, now = new Date()): ApplicationSummary[] {
  const today = localDate(now, getSettings(db).pipeline.timezone);
  const statuses: Record<QueueView, ApplicationStatus[]> = {
    review: ["ready_for_review"],
    snoozed: ["ready_for_review"],
    blocked: ["draft"],
    approved: ["approved"],
    closed: ["withdrawn"],
  };
  return db
    .select({ app: applications, job: jobs, companyName: companies.name })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(inArray(applications.status, statuses[view]))
    .orderBy(desc(applications.id))
    .all()
    .filter((r) => {
      const snoozed = !!r.app.snoozedUntil && r.app.snoozedUntil > today;
      return view === "review" ? !snoozed : view === "snoozed" ? snoozed : true;
    })
    .map(summarize);
}

export function getApplication(db: DB, id: number): ApplicationDetail {
  const row = db
    .select({ app: applications, job: jobs, companyName: companies.name, companyToken: companies.atsBoardToken })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(applications.id, id))
    .get();
  if (!row) throw new NotFoundError(`Application ${id} not found`);
  const version = db.select().from(resumeVersions).where(eq(resumeVersions.id, row.app.resumeVersionId!)).get()!;
  return {
    ...summarize(row),
    job: getJob(db, row.job.id),
    baseType: version.baseType,
    resume: version.content,
    resumeText: serializeResume(version.content),
    changes: version.diffFromBase ?? [],
    prefillReport: row.app.prefillReport ?? null,
    applyUrl: applyTarget(row.job, row.companyToken)?.url ?? null,
    submittedAt: row.app.submittedAt?.getTime() ?? null,
    followUpDue: row.app.followUpDue ?? null,
    answers: row.app.answers ?? [],
    truth: row.app.truthReport ?? { pass: false, issues: [], checkedAt: 0 },
    pdfPages: version.pdfPages,
    hasPdf: !!version.filePathPdf && fs.existsSync(version.filePathPdf),
    hasDocx: !!version.filePathDocx && fs.existsSync(version.filePathDocx),
    prepNotes: (row.app.prepNotes ?? []).filter((n) => !/recruiter note/i.test(n)), // old rows may mention the removed note
    reviewReason: row.app.reviewReason,
    tailoring: row.app.tailoring ?? null,
  };
}

export function applicationFile(db: DB, id: number, kind: "pdf" | "docx"): { path: string; filename: string } {
  const app = db.select().from(applications).where(eq(applications.id, id)).get();
  if (!app?.resumeVersionId) throw new NotFoundError(`Application ${id} not found`);
  const v = db.select().from(resumeVersions).where(eq(resumeVersions.id, app.resumeVersionId)).get()!;
  const p = kind === "pdf" ? v.filePathPdf : v.filePathDocx;
  if (!p || !fs.existsSync(p)) throw new NotFoundError(`No ${kind.toUpperCase()} yet for application ${id}`);
  return { path: p, filename: `${v.content.name.replace(/[^A-Za-z0-9]+/g, "_")}_Resume.${kind}` };
}

// ---- Review actions -------------------------------------------------------------

function loadEditable(db: DB, id: number) {
  const app = db.select().from(applications).where(eq(applications.id, id)).get();
  if (!app) throw new NotFoundError(`Application ${id} not found`);
  if (app.status !== "draft" && app.status !== "ready_for_review") {
    throw new ConflictError(`This application is ${app.status.replace(/_/g, " ")}; it can't be edited.`);
  }
  return app;
}

export type ApplicationPatch = {
  contact?: string;
  answers?: { index: number; answer: string }[];
  lines?: { id: string; text: string }[];
};

/** Any edit clears a Truth Check override: you approved the old text, not this one. */
export async function editApplication(db: DB, id: number, patch: ApplicationPatch, deps: PrepDeps, now = new Date()) {
  const app = loadEditable(db, id);
  if (patch.contact !== undefined) patch = { ...patch, lines: [...(patch.lines ?? []), { id: "contact", text: patch.contact }] };
  if (patch.lines?.length) {
    const version = db.select().from(resumeVersions).where(eq(resumeVersions.id, app.resumeVersionId!)).get()!;
    let content = version.content;
    const changes = [...(version.diffFromBase ?? [])];
    const current = new Map(resumeLines(content).map((l) => [l.id, l]));
    current.set("contact", { id: "contact", where: "Contact line", text: content.contact, kind: "line" });
    // Emptied lines are deletions, done after the edits and from the bottom up,
    // so earlier ids still point at the right lines.
    const removals = patch.lines.filter((l) => !l.text.trim() && current.has(l.id));
    if (removals.some((l) => l.id === "contact")) throw new ConflictError("The contact line can't be empty.");
    for (const { id: lineId, text } of patch.lines) {
      const before = current.get(lineId);
      if (!before || !text.trim() || before.text === text.trim()) continue;
      content = setLine(content, lineId, text.trim());
      const existing = changes.find((c) => c.id === lineId);
      if (existing) Object.assign(existing, { after: text.trim(), reason: "Edited by you" });
      else changes.push({ id: lineId, where: before.where, before: before.text, after: text.trim(), reason: "Edited by you" });
    }
    const order = (id: string) => id.split(/[.L]+/).filter(Boolean).map(Number);
    removals.sort((a, b) => {
      const [x, y] = [order(a.id), order(b.id)];
      for (let k = 0; k < Math.max(x.length, y.length); k++) if ((x[k] ?? -1) !== (y[k] ?? -1)) return (y[k] ?? -1) - (x[k] ?? -1);
      return 0;
    });
    for (const { id: lineId } of removals) {
      const before = current.get(lineId)!;
      content = removeLine(content, lineId);
      const i = changes.findIndex((c) => c.id === lineId);
      const removed = { id: `${lineId}.removed`, where: before.where, before: i === -1 ? before.text : changes[i]!.before, after: "(removed)", reason: "Deleted by you" };
      if (i === -1) changes.push(removed);
      else changes.splice(i, 1, removed);
    }
    db.update(resumeVersions).set({ content, diffFromBase: changes }).where(eq(resumeVersions.id, version.id)).run();
  }
  const answers = [...(app.answers ?? [])];
  for (const { index, answer } of patch.answers ?? []) {
    const a = answers[index];
    if (!a) continue;
    if (a.source === "fixed") throw new ConflictError("Work-authorization answers come from Settings and can't be edited here.");
    answers[index] = { ...a, answer: answer.trim() };
  }
  db.update(applications)
    .set({
      answers,
      truthOverride: null,
      lastActivityAt: now,
    })
    .where(eq(applications.id, id))
    .run();
  await finalizeApplication(db, id, deps, now);
  return getApplication(db, id);
}

export async function overrideTruthCheck(db: DB, id: number, reason: string, deps: PrepDeps, now = new Date()) {
  loadEditable(db, id);
  if (reason.trim().length < 10) throw new ConflictError("Say why the flagged lines are true (at least a short sentence).");
  db.update(applications).set({ truthOverride: { reason: reason.trim(), at: now.getTime() } }).where(eq(applications.id, id)).run();
  await finalizeApplication(db, id, deps, now);
  return getApplication(db, id);
}

/** Per application, never bulk (hard constraint). */
export function approveApplication(db: DB, id: number, now = new Date()) {
  const detail = getApplication(db, id);
  assertTransition(detail.status, "approved");
  if (!detail.hasPdf || detail.pdfPages !== 1) throw new ConflictError("Approve needs a one-page PDF. Fix the PDF issue first.");
  if (!detail.truth.pass && !detail.truthOverride) throw new ConflictError("The Truth Check hasn't passed. Fix the flagged lines or override with a reason.");
  db.update(applications).set({ status: "approved", approvedAt: now, lastActivityAt: now, snoozedUntil: null }).where(eq(applications.id, id)).run();
  return getApplication(db, id);
}

export function unapproveApplication(db: DB, id: number, now = new Date()) {
  const app = getApplication(db, id);
  assertTransition(app.status, "ready_for_review");
  db.update(applications).set({ status: "ready_for_review", approvedAt: null, lastActivityAt: now }).where(eq(applications.id, id)).run();
  return getApplication(db, id);
}

/** "Not applying": the reason is kept for tuning scoring later; the job is dismissed. */
export function rejectApplication(db: DB, id: number, reason: string, now = new Date()) {
  const app = getApplication(db, id);
  assertTransition(app.status, "withdrawn");
  if (!reason.trim()) throw new ConflictError("Add a short reason; it's used to tune scoring later.");
  db.update(applications).set({ status: "withdrawn", reviewReason: reason.trim(), lastActivityAt: now }).where(eq(applications.id, id)).run();
  db.update(jobs).set({ status: "dismissed" }).where(eq(jobs.id, app.jobId)).run();
  return getApplication(db, id);
}

export function snoozeApplication(db: DB, id: number, until: string | null, now = new Date()) {
  const app = getApplication(db, id);
  if (app.status !== "ready_for_review") throw new ConflictError("Only applications waiting for review can be snoozed.");
  db.update(applications).set({ snoozedUntil: until, lastActivityAt: now }).where(eq(applications.id, id)).run();
  return getApplication(db, id);
}

// ---- Assumption protocol (mentor prompt v2) -------------------------------------

export type TailoringReply = {
  kind: "assumption" | "skill";
  index: number;
  confirmed: boolean;
  /** Your answer in your words ("Yes, pytest, covering validation and language checks"). */
  answer?: string;
  /** The line to use, if you edited the draft. */
  text?: string;
};

const clean = (t: string) => t.replace(/\s*\[(CONFIRM|HER ESTIMATE)\]\s*/gi, " ").replace(/\s+/g, " ").trim();

/** Appends one confirmed fact to data/private/confirmed_additions.md (created on first use). */
function appendAddition(dir: string, line: string) {
  const p = path.join(dir, ADDITIONS_FILE);
  const head = fs.existsSync(p)
    ? ""
    : "# Confirmed additions\nYour answers to assumption questions, written by the app when you confirm one. Edit or delete lines freely; the Truth Check and every prompt read this file as part of your inventory.\n\n";
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(p, `${head}${line.replace(/\s+/g, " ").trim()}\n`);
}

/**
 * Confirm or decline one assumption question or suggested skill. Confirming:
 * 1. checks the line against DO NOT CLAIM and ownership first (refused if it hits),
 * 2. requires any number in the line to come from your answer (tagged [HER ESTIMATE]),
 * 3. saves your answer to confirmed_additions.md, so it's inventory from now on,
 * 4. puts the line on this resume, which re-runs the Truth Check.
 * Declining changes nothing on the resume.
 */
export async function answerTailoringQuestion(db: DB, id: number, reply: TailoringReply, deps: PrepDeps, now = new Date()) {
  const app = loadEditable(db, id);
  const job = getJob(db, app.jobId);
  const tailoring = structuredClone(app.tailoring ?? null);
  const list = reply.kind === "assumption" ? tailoring?.assumptions : tailoring?.skillsAdded;
  const item = list?.[reply.index];
  if (!tailoring || !item) throw new NotFoundError("That question isn't on this application.");
  if (item.status !== "open") throw new ConflictError("You've already answered that one.");
  const save = (notes?: string[]) =>
    db.update(applications).set({ tailoring, lastActivityAt: now, ...(notes ? { prepNotes: notes } : {}) }).where(eq(applications.id, id)).run();

  if (!reply.confirmed) {
    item.status = "declined";
    save();
    return getApplication(db, id);
  }

  const version = db.select().from(resumeVersions).where(eq(resumeVersions.id, app.resumeVersionId!)).get()!;
  const dir = deps.privateDir ?? config.privateDir;
  const facts = deps.facts();
  let lineId: string | undefined;
  let newText: string;
  let addition: string;

  if (reply.kind === "assumption") {
    const q = item as NonNullable<typeof tailoring.assumptions>[number];
    const answer = (reply.answer ?? "").trim() || "Yes";
    newText = clean(reply.text ?? q.draft);
    if (!newText) throw new ConflictError("The line can't be empty.");
    const hard = runTruthCheck({ lines: [{ where: q.where, text: newText }, { where: "Your answer", text: answer, checkNumbers: false }] }, facts).issues.filter(
      (i) => i.kind === "do_not_claim" || i.kind === "ownership"
    );
    if (hard.length) throw new ConflictError(`Can't confirm this: ${hard[0]!.message}`);
    // A number only you can supply: it must be in your answer, and it's marked as your estimate.
    const given = new Set(extractNumbers(answer).map(numberKey));
    const unbacked = extractNumbers(newText).filter((n) => !facts.allowedNumbers.has(numberKey(n)) && !given.has(numberKey(n)));
    if (unbacked.length) throw new ConflictError(`The line says ${unbacked[0]!.raw}, which isn't in your inventory. Put the number in your answer (it'll be marked [HER ESTIMATE]) or take it out of the line.`);
    const estimate = extractNumbers(answer).some((n) => !facts.allowedNumbers.has(numberKey(n))) ? " [HER ESTIMATE]" : "";
    addition = `- ${q.where.split(" › ")[1] ?? q.where}: ${q.question} Her answer: ${answer}${estimate}. Confirmed line: "${newText}"`;
    q.answer = answer;
    lineId = findPinnedLine(version.content, q.targetText, "bullet")?.id;
  } else {
    const k = item as NonNullable<typeof tailoring.skillsAdded>[number];
    const line = findPinnedLine(version.content, k.targetText, "line");
    lineId = line?.id;
    newText = line ? (/[:]\s*$/.test(line.text) ? `${line.text} ${k.skill}` : `${line.text}, ${k.skill}`) : "";
    addition = `- Skill she has used and can describe: ${k.skill}`;
  }

  appendAddition(dir, addition);
  item.status = "confirmed";
  const notes = [...(app.prepNotes ?? [])];
  if (!lineId) notes.push(`Saved your answer, but the line it was for has changed since tailoring. Add it yourself: "${reply.kind === "skill" ? (item as { skill: string }).skill : newText}".`);
  save(notes);
  if (lineId) return editApplication(db, id, { lines: [{ id: lineId, text: newText }] }, deps, now);
  await finalizeApplication(db, id, deps, now);
  return getApplication(db, id);
}

/** Every skill tailoring suggested in the last `days`, most-asked first: what to build this week. */
export function skillsToBuild(db: DB, now = new Date(), days = 14) {
  const since = now.getTime() - days * 86_400_000;
  const rows = db
    .select({ tailoring: applications.tailoring, createdAt: applications.createdAt, company: companies.name })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .all();
  const by = new Map<string, { skill: string; count: number; companies: string[]; listed: boolean }>();
  for (const r of rows) {
    if (!r.tailoring?.skillsAdded?.length || (r.createdAt && new Date(r.createdAt).getTime() < since)) continue;
    for (const k of r.tailoring.skillsAdded) {
      const key = k.skill.toLowerCase();
      const e = by.get(key) ?? { skill: k.skill, count: 0, companies: [], listed: false };
      e.count++;
      if (!e.companies.includes(r.company)) e.companies.push(r.company);
      if (k.status === "confirmed") e.listed = true;
      by.set(key, e);
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));
}
