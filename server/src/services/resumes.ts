import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DB } from "../db/client";
import { resumeVersions } from "../db/schema";
import { config } from "../config";
import { parseResume, resumeLines, serializeResume } from "../domain/resumeFormat";
import { runTruthCheck, type CheckLine } from "../domain/truthCheck";
import type { InventoryFacts } from "../domain/inventory";
import type { Renderer } from "../render/renderer";
import type { BaseResume, BaseType, ResumeContent, TruthIssue, TruthReport } from "../../../shared/types";

export type ResumeDeps = { renderer: Renderer; facts: () => InventoryFacts; generatedDir?: string };

/** Resume lines to check. The contact line is checked for placeholders only. */
export function resumeCheckLines(r: ResumeContent): CheckLine[] {
  return [
    // Contact line: only placeholders matter (no number check on phone numbers).
    { where: "Resume › Contact line", text: r.contact, checkNumbers: false },
    ...resumeLines(r).map((l) => ({ where: `Resume › ${l.where}`, text: l.text, lineId: l.kind === "header" ? undefined : l.id })),
  ];
}

/** Truth Check plus render problems (no PDF, or more than one page) as blocking issues. */
export function withRenderIssues(report: TruthReport, render: { pages: number | null; pdfError: string | null }): TruthReport {
  const extra: TruthIssue[] = [];
  if (render.pdfError) extra.push({ kind: "render", severity: "fail", where: "Resume PDF", text: "", message: render.pdfError });
  else if (render.pages !== null && render.pages > 1) {
    extra.push({ kind: "render", severity: "fail", where: "Resume PDF", text: "", message: `The resume runs to ${render.pages} pages. Cut or shorten bullets until it fits on one.` });
  }
  return extra.length ? { ...report, pass: false, issues: [...report.issues, ...extra] } : report;
}

function latestBaseRow(db: DB, type: BaseType) {
  return db
    .select()
    .from(resumeVersions)
    .where(and(eq(resumeVersions.baseType, type), isNull(resumeVersions.jobId), isNull(resumeVersions.parentId)))
    .orderBy(desc(resumeVersions.id))
    .limit(1)
    .get();
}

/** Saves a new version of a base resume (history is kept), checks it and renders it. */
export async function saveBase(db: DB, type: BaseType, text: string, deps: ResumeDeps, now = new Date()) {
  const content = parseResume(text);
  const truth = runTruthCheck({ lines: resumeCheckLines(content) }, deps.facts(), now);
  const row = db.insert(resumeVersions).values({ baseType: type, content, truthCheckStatus: truth.pass ? "pass" : "fail" }).returning().get();
  const out = path.join(deps.generatedDir ?? config.generatedDir, "base", `${type}-${row.id}`);
  const render = await deps.renderer(content, out);
  const report = withRenderIssues(truth, render);
  db.update(resumeVersions)
    .set({
      filePathPdf: render.pdfPath,
      filePathDocx: render.docxPath,
      pdfPages: render.pages,
      truthReport: report,
      truthCheckStatus: report.pass ? "pass" : "fail",
    })
    .where(eq(resumeVersions.id, row.id))
    .run();
  return getBase(db, type);
}

/** First run: import data/private/resume_<type>.md if the database has no base yet. */
export async function importBasesIfMissing(db: DB, deps: ResumeDeps, dir = config.privateDir) {
  for (const type of ["fde", "swe"] as const) {
    const file = path.join(dir, `resume_${type}.md`);
    if (!latestBaseRow(db, type) && fs.existsSync(file)) {
      try {
        await saveBase(db, type, fs.readFileSync(file, "utf8"), deps);
      } catch {
        // a malformed file shouldn't stop the server; the Resumes page shows the error on save
      }
    }
  }
}

export function getBaseRow(db: DB, type: BaseType) {
  return latestBaseRow(db, type);
}

export function getBase(db: DB, type: BaseType): BaseResume {
  const row = latestBaseRow(db, type);
  if (!row) return { baseType: type, id: null, text: "", truth: null, pdfPages: null, hasPdf: false };
  return {
    baseType: type,
    id: row.id,
    text: serializeResume(row.content),
    truth: row.truthReport ?? null,
    pdfPages: row.pdfPages,
    hasPdf: !!row.filePathPdf && fs.existsSync(row.filePathPdf),
  };
}
