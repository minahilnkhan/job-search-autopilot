import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { applications } from "../db/schema";
import { resumeLines } from "../domain/resumeFormat";
import { runTruthCheck } from "../domain/truthCheck";
import type { ChatTurn } from "../llm/chat";
import { ScoreError } from "../llm/scoreJob";
import { accountProblem } from "../llm/errors";
import { approveApplication, editApplication, getApplication, unapproveApplication, type PrepDeps } from "./applications";
import { ConflictError } from "./jobs";
import { getSettings, localDate } from "./settings";
import type { SubmitDeps } from "./submissions";
import { recordUsage } from "./usage";
import type { Answer } from "../../../shared/types";

// Chat edits from the extension: Claude proposes, the Truth Check filters,
// you press Apply. Applying to an approved application re-approves it only
// if it still passes the Truth Check and fits on one page; otherwise it goes
// back to Review with the reason.

export type ProposedEdit = { kind: "line" | "answer"; key: string; label: string; before: string; after: string };
export type ChatProposal = { reply: string; edits: ProposedEdit[]; blocked: { label: string; reason: string }[] };

const EDITABLE = ["draft", "ready_for_review", "approved"];

export async function proposeChat(
  db: DB,
  id: number,
  deps: SubmitDeps,
  input: { message: string; history: ChatTurn[]; formQuestions: string[] }
): Promise<ChatProposal> {
  const app = getApplication(db, id);
  if (!EDITABLE.includes(app.status)) throw new ConflictError(`This application is ${app.status.replace(/_/g, " ")}; it can't be changed now.`);
  const settings = getSettings(db);
  const w = deps.getChat?.(settings);
  if (!w) throw new ConflictError("Chat isn't set up.");
  if ("unavailable" in w) throw new ConflictError(`Chat can't run: ${w.unavailable}`);

  const lines = resumeLines(app.resume).filter((l) => l.kind !== "header");
  let result;
  try {
    result = await w.writer({
      companyName: app.companyName,
      title: app.jobTitle,
      description: app.job.description,
      resumeLines: lines.map((l) => `[${l.id}] ${l.where}: ${l.text}`).join("\n"),
      answers: app.answers.map((a) => ({ question: a.question, answer: a.answer })),
      formQuestions: input.formQuestions,
      history: input.history,
      message: input.message,
    });
    recordUsage(db, { purpose: "chat", model: result.model, usage: result.usage, jobId: app.jobId, now: new Date() });
  } catch (err) {
    if (err instanceof ScoreError && err.usage) recordUsage(db, { purpose: "chat", model: settings.models.tailoring, usage: err.usage, jobId: app.jobId, now: new Date() });
    throw new ConflictError(accountProblem(err) ?? (err as Error).message);
  }

  const facts = deps.facts?.();
  const fail = (where: string, text: string) => {
    if (!facts || !text.trim()) return null;
    const r = runTruthCheck({ lines: [{ where, text }] }, facts);
    return r.issues.find((i) => i.severity === "fail")?.message ?? null;
  };
  const edits: ProposedEdit[] = [];
  const blocked: ChatProposal["blocked"] = [];

  for (const e of result.edits.lines) {
    const line = lines.find((l) => l.id === e.id);
    if (!line || line.text === e.text.trim()) continue;
    const problem = fail(line.where, e.text);
    if (problem) blocked.push({ label: line.where, reason: problem });
    else edits.push({ kind: "line", key: e.id, label: `Resume › ${line.where}`, before: line.text, after: e.text.trim() });
  }
  for (const e of result.edits.answers) {
    const current = app.answers.find((a) => a.question === e.question);
    if (current?.source === "fixed" || /sponsor|authori[sz]ed to work/i.test(e.question)) {
      blocked.push({ label: e.question, reason: "Work-authorization answers are fixed in Settings." });
      continue;
    }
    if (current?.answer === e.answer.trim() || !e.answer.trim()) continue;
    const problem = fail(`Answer › ${e.question}`, e.answer);
    if (problem) blocked.push({ label: e.question, reason: problem });
    else edits.push({ kind: "answer", key: e.question, label: e.question, before: current?.answer ?? "", after: e.answer.trim() });
  }
  return { reply: result.reply, edits, blocked };
}

export async function applyChatEdits(db: DB, id: number, prep: PrepDeps, edits: Pick<ProposedEdit, "kind" | "key" | "after">[], now = new Date()) {
  const app = getApplication(db, id);
  if (!EDITABLE.includes(app.status)) throw new ConflictError(`This application is ${app.status.replace(/_/g, " ")}; it can't be changed now.`);
  const wasApproved = app.status === "approved";
  if (wasApproved) unapproveApplication(db, id, now);

  // Answers to form questions the application didn't have yet are added first.
  const answers: Answer[] = [...app.answers];
  for (const e of edits.filter((x) => x.kind === "answer")) {
    if (!answers.some((a) => a.question === e.key)) answers.push({ question: e.key, answer: e.after, source: "generated" });
  }
  if (answers.length !== app.answers.length) db.update(applications).set({ answers }).where(eq(applications.id, id)).run();

  await editApplication(
    db,
    id,
    {
      lines: edits.filter((e) => e.kind === "line").map((e) => ({ id: e.key, text: e.after })),
      answers: edits
        .filter((e) => e.kind === "answer")
        .map((e) => ({ index: answers.findIndex((a) => a.question === e.key), answer: e.after }))
        .filter((a) => a.index >= 0 && answers[a.index]!.source !== "fixed"),
    },
    prep,
    now
  );

  let after = getApplication(db, id);
  let message: string | null = null;
  if (wasApproved) {
    if (after.status === "ready_for_review" && after.hasPdf && after.pdfPages === 1) after = approveApplication(db, id, now);
    else
      message =
        after.pdfPages && after.pdfPages > 1
          ? "Applied, but the resume now runs past one page, so it's back in Review. Trim a line there, then approve it again."
          : "Applied, but the Truth Check flagged something, so it's back in Review. Fix it there, then approve it again.";
  }
  return { application: after, resumeChanged: edits.some((e) => e.kind === "line"), message };
}

/** A short follow-up for a Tier A application that hasn't heard back. */
export async function draftFollowUp(db: DB, id: number, deps: SubmitDeps, now = new Date()) {
  const app = getApplication(db, id);
  if (!app.submittedAt) throw new ConflictError("This application hasn't been submitted yet.");
  const settings = getSettings(db);
  const w = deps.getFollowUp?.(settings);
  if (!w) throw new ConflictError("Follow-up drafts aren't set up.");
  if ("unavailable" in w) throw new ConflictError(`Can't draft a follow-up: ${w.unavailable}`);
  const days = Math.max(0, Math.round((now.getTime() - app.submittedAt) / 86_400_000));
  try {
    const r = await w.writer({ companyName: app.companyName, title: app.jobTitle, daysSince: days });
    recordUsage(db, { purpose: "follow_up", model: r.model, usage: r.usage, jobId: app.jobId, now });
    const facts = deps.facts?.();
    const issue = facts ? runTruthCheck({ lines: [{ where: "Follow-up", text: r.text }] }, facts).issues.find((i) => i.severity === "fail") : undefined;
    return { text: r.text, warning: issue?.message ?? null, date: localDate(now, settings.pipeline.timezone) };
  } catch (err) {
    if (err instanceof ScoreError && err.usage) recordUsage(db, { purpose: "follow_up", model: settings.models.tailoring, usage: err.usage, jobId: app.jobId, now });
    throw new ConflictError(accountProblem(err) ?? (err as Error).message);
  }
}
