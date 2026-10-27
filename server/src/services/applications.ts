import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { DB } from "../db/client";
import { applications, companies, jobs, resumeVersions } from "../db/schema";
import { config } from "../config";
import { removeLine, resumeLines, serializeResume, setLine } from "../domain/resumeFormat";
import { applyPlan, chooseBase, resumeForPrompt } from "../domain/tailorPlan";
import { applyTarget } from "../submit/applyUrl";
import { runTruthCheck, type CheckLine } from "../domain/truthCheck";
import { assertTransition } from "../domain/applicationStatus";
import type { InventoryFacts } from "../domain/inventory";
import type { Renderer } from "../render/renderer";
import type { Tailor } from "../llm/tailor";
import type { NoteWriter } from "../llm/note";
import { ScoreError } from "../llm/scoreJob";
import { accountProblem } from "../llm/errors";
import { ConflictError, NotFoundError, getJob } from "./jobs";
import { getSettings, localDate } from "./settings";
import { recordUsage } from "./usage";
import { getBaseRow, resumeCheckLines, withRenderIssues } from "./resumes";
import type {
  NoteBasis,
  Answer,
  ApplicationDetail,
  ApplicationStatus,
  ApplicationSummary,
  ResumeChange,
  Settings,
} from "../../../shared/types";

export type PrepDeps = {
  getTailor: (s: Settings) => { tailor: Tailor } | { unavailable: string };
  getNoteWriter?: (s: Settings) => { writer: NoteWriter } | { unavailable: string };
  renderer: Renderer;
  facts: () => InventoryFacts;
  generatedDir?: string;
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
    { lines: [...resumeCheckLines(version.content), ...checkableAnswers(app.answers ?? [])], recruiterNote: app.recruiterNote },
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

async function draftNote(
  db: DB,
  args: {
    jobId: number;
    companyName: string;
    title: string;
    description: string;
    content: import("../../../shared/types").ResumeContent;
    currentNote?: string | null;
    instructions?: string | null;
  },
  settings: Settings,
  deps: PrepDeps,
  now: Date
): Promise<{ note: string; basis: NoteBasis } | { problem: string }> {
  const w = deps.getNoteWriter?.(settings);
  if (!w) return { problem: "note writing isn't set up" };
  if ("unavailable" in w) return { problem: w.unavailable };
  try {
    const company = db.select({ notes: companies.notes }).from(companies).innerJoin(jobs, eq(jobs.companyId, companies.id)).where(eq(jobs.id, args.jobId)).get();
    const r = await w.writer({
      companyName: args.companyName,
      title: args.title,
      description: args.description,
      resumeText: serializeResume(args.content),
      companyNotes: company?.notes ?? null,
      currentNote: args.currentNote ?? null,
      instructions: args.instructions ?? null,
    });
    recordUsage(db, { purpose: "note", model: r.model, usage: r.usage, jobId: args.jobId, now });
    return { note: r.note, basis: r.basis };
  } catch (err) {
    if (err instanceof ScoreError && err.usage) recordUsage(db, { purpose: "note", model: settings.models.tailoring, usage: err.usage, jobId: args.jobId, now });
    return { problem: accountProblem(err) ?? (err as Error).message };
  }
}

/**
 * "Suggest an edit": rewrite the note the way you describe. Returns a proposal
 * with its Truth Check result; nothing is saved until you press Use this.
 */
export async function suggestNote(db: DB, id: number, instructions: string, currentNote: string | null, deps: PrepDeps, now = new Date()) {
  loadEditable(db, id);
  const detail = getApplication(db, id);
  const n = await draftNote(
    db,
    {
      jobId: detail.jobId,
      companyName: detail.companyName,
      title: detail.jobTitle,
      description: detail.job.description,
      content: detail.resume,
      currentNote: currentNote ?? detail.recruiterNote,
      instructions,
    },
    getSettings(db),
    deps,
    now
  );
  if ("problem" in n) throw new ConflictError(`Couldn't rewrite the note: ${n.problem}`);
  const issues = runTruthCheck({ lines: [], recruiterNote: n.note }, deps.facts()).issues.filter((i) => i.severity === "fail");
  return { note: n.note, basis: n.basis, issues: issues.map((i) => i.message) };
}

/** "Write it again": a fresh recruiter note, then the usual re-check. */
export async function redraftNote(db: DB, id: number, deps: PrepDeps, now = new Date()) {
  const app = loadEditable(db, id);
  const detail = getApplication(db, id);
  const n = await draftNote(
    db,
    { jobId: app.jobId, companyName: detail.companyName, title: detail.jobTitle, description: detail.job.description, content: detail.resume },
    getSettings(db),
    deps,
    now
  );
  if ("problem" in n) throw new ConflictError(`Couldn't write a note: ${n.problem}`);
  db.update(applications).set({ noteBasis: n.basis }).where(eq(applications.id, id)).run();
  return editApplication(db, id, { recruiterNote: n.note }, deps, now);
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
  let recruiterNote: string | null = null;
  let noteBasis: NoteBasis | null = null;
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
        };
      } catch (err) {
        if (err instanceof ScoreError && err.usage) recordUsage(db, { purpose: "tailoring", model: settings.models.tailoring, usage: err.usage, jobId, now });
        const fatal = accountProblem(err);
        notes.push(`Tailoring failed (${fatal ?? (err as Error).message}); using the base resume. You can edit lines below.`);
      }
    }
  }

  // Every application gets a recruiter note you can edit, from one writer
  // with one brief (llm/note.ts), whatever the tier.
  {
    const n = await draftNote(db, { jobId, companyName: job.companyName, title: job.title, description: job.description, content }, settings, deps, now);
    if ("note" in n) ({ note: recruiterNote, basis: noteBasis } = n);
    else notes.push(`No recruiter note yet (${n.problem}). Use "Write a note" below.`);
  }

  const answers: Answer[] = [
    ...generated,
    ...settings.standardAnswers.map((a) => ({ ...a, source: "standard" as const })),
    ...fixedAnswers(settings),
  ];

  const version = db.insert(resumeVersions).values({ baseType, parentId: base.id, jobId, content, diffFromBase: changes }).returning().get();
  const app = db
    .insert(applications)
    .values({ jobId, tier, resumeVersionId: version.id, recruiterNote, noteBasis, answers, status: "draft", prepNotes: notes, tailoring, lastActivityAt: now })
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
    recruiterNote: row.app.recruiterNote,
    noteBasis: row.app.noteBasis ?? null,
    prefillReport: row.app.prefillReport ?? null,
    applyUrl: applyTarget(row.job, row.companyToken)?.url ?? null,
    submittedAt: row.app.submittedAt?.getTime() ?? null,
    followUpDue: row.app.followUpDue ?? null,
    answers: row.app.answers ?? [],
    truth: row.app.truthReport ?? { pass: false, issues: [], checkedAt: 0 },
    pdfPages: version.pdfPages,
    hasPdf: !!version.filePathPdf && fs.existsSync(version.filePathPdf),
    hasDocx: !!version.filePathDocx && fs.existsSync(version.filePathDocx),
    prepNotes: row.app.prepNotes ?? [],
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
  recruiterNote?: string | null;
  noteBasis?: NoteBasis | null;
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
      recruiterNote: patch.recruiterNote !== undefined ? patch.recruiterNote?.trim() || null : app.recruiterNote,
      ...(patch.noteBasis !== undefined ? { noteBasis: patch.noteBasis } : {}),
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
