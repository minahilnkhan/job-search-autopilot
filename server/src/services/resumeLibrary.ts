import fs from "node:fs";
import { asc, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { resumeLibrary, resumeVersions } from "../db/schema";
import { parseResume, serializeResume } from "../domain/resumeFormat";
import { getBaseRow, saveBase, saveVersionRow, type ResumeDeps } from "./resumes";
import { ConflictError, NotFoundError } from "./jobs";
import type { BaseType, ResumeDoc, RoleTag } from "../../../shared/types";

// The Resumes tab: the two bases plus any named versions you keep beside them
// (e.g. one for Applied AI roles, one for technical education). A version is a
// tag and a name on top of ordinary resume_versions rows, so it goes through
// the same Truth Check and the same one-page PDF as a base.
//
// What a version does NOT do: send itself anywhere. Applications still start
// from the FDE or SWE base. A version is somewhere to keep and polish a resume
// for a role type, and to copy from when you rework a base.

export const BASE_NAMES: Record<BaseType, string> = { fde: "FDE / Solutions base", swe: "Software engineering base" };

type VersionRow = typeof resumeVersions.$inferSelect;

function toDoc(row: VersionRow | undefined, d: Omit<ResumeDoc, "versionId" | "text" | "truth" | "pdfPages" | "hasPdf" | "updatedAt">, updatedAt?: Date): ResumeDoc {
  return {
    ...d,
    versionId: row?.id ?? null,
    text: row ? serializeResume(row.content) : "",
    truth: row?.truthReport ?? null,
    pdfPages: row?.pdfPages ?? null,
    hasPdf: !!row?.filePathPdf && fs.existsSync(row.filePathPdf),
    updatedAt: (updatedAt ?? row?.createdAt)?.getTime() ?? null,
  };
}

const versionRow = (db: DB, id: number) => db.select().from(resumeVersions).where(eq(resumeVersions.id, id)).get();

function libraryRow(db: DB, id: number) {
  const row = db.select().from(resumeLibrary).where(eq(resumeLibrary.id, id)).get();
  if (!row) throw new NotFoundError(`Resume version ${id} not found`);
  return row;
}

function baseDoc(db: DB, type: BaseType): ResumeDoc {
  return toDoc(getBaseRow(db, type), { key: `base:${type}`, kind: "base", name: BASE_NAMES[type], roleTag: type, baseType: type });
}

function libraryDoc(db: DB, lib: typeof resumeLibrary.$inferSelect): ResumeDoc {
  const row = versionRow(db, lib.versionId);
  return toDoc(row, { key: `lib:${lib.id}`, kind: "version", name: lib.name, roleTag: lib.roleTag as RoleTag, baseType: row?.baseType ?? "swe" }, lib.updatedAt);
}

/** Bases first, then your versions in the order you made them. */
export function listResumeDocs(db: DB): ResumeDoc[] {
  const libs = db.select().from(resumeLibrary).orderBy(asc(resumeLibrary.id)).all();
  return [baseDoc(db, "fde"), baseDoc(db, "swe"), ...libs.map((l) => libraryDoc(db, l))];
}

export function getResumeDoc(db: DB, key: string): ResumeDoc {
  const m = /^(?:base:(fde|swe)|lib:(\d+))$/.exec(key);
  if (!m) throw new NotFoundError(`Unknown resume "${key}"`);
  return m[1] ? baseDoc(db, m[1] as BaseType) : libraryDoc(db, libraryRow(db, Number(m[2])));
}

/** A new version, starting as a copy of a base or of another version. */
export async function createVersion(db: DB, input: { name: string; roleTag: RoleTag; from: string }, deps: ResumeDeps) {
  const source = getResumeDoc(db, input.from);
  if (!source.versionId) throw new NotFoundError(`${source.name} has nothing in it to copy yet`);
  const src = versionRow(db, source.versionId)!;
  const versionId = await saveVersionRow(db, { baseType: src.baseType, parentId: src.id, content: src.content }, deps, "library");
  const lib = db.insert(resumeLibrary).values({ name: input.name, roleTag: input.roleTag, versionId }).returning().get();
  return libraryDoc(db, lib);
}

/** Saves edited text. Each save is a new row, so earlier wording is never lost. */
export async function saveResumeDoc(db: DB, key: string, text: string, deps: ResumeDeps, now = new Date()): Promise<ResumeDoc> {
  const doc = getResumeDoc(db, key);
  if (doc.kind === "base") {
    await saveBase(db, doc.baseType, text, deps, now);
    return baseDoc(db, doc.baseType);
  }
  const id = Number(key.slice(4));
  const versionId = await saveVersionRow(db, { baseType: doc.baseType, parentId: doc.versionId, content: parseResume(text) }, deps, "library", now);
  db.update(resumeLibrary).set({ versionId, updatedAt: now }).where(eq(resumeLibrary.id, id)).run();
  return libraryDoc(db, libraryRow(db, id));
}

/** Rename or retag a version. The bases keep their names and tags: the app relies on them. */
export function updateVersionMeta(db: DB, key: string, patch: { name?: string; roleTag?: RoleTag }): ResumeDoc {
  const doc = getResumeDoc(db, key);
  if (doc.kind === "base") throw new ConflictError("The two bases keep their names and tags, since applications are built from them.");
  const id = Number(key.slice(4));
  db.update(resumeLibrary)
    .set({ ...(patch.name !== undefined && { name: patch.name }), ...(patch.roleTag !== undefined && { roleTag: patch.roleTag }) })
    .where(eq(resumeLibrary.id, id))
    .run();
  return libraryDoc(db, libraryRow(db, id));
}

/** Removes a version from the tab. Its saved rows stay in the database as history. */
export function deleteVersion(db: DB, key: string) {
  const doc = getResumeDoc(db, key);
  if (doc.kind === "base") throw new ConflictError("The bases can't be deleted. Edit them instead.");
  db.delete(resumeLibrary).where(eq(resumeLibrary.id, Number(key.slice(4)))).run();
}

/** The PDF or DOCX behind a resume in the tab. */
export function resumeDocFile(db: DB, key: string, kind: "pdf" | "docx") {
  const doc = getResumeDoc(db, key);
  const row = doc.versionId ? versionRow(db, doc.versionId) : undefined;
  const p = kind === "pdf" ? row?.filePathPdf : row?.filePathDocx;
  if (!row || !p || !fs.existsSync(p)) throw new NotFoundError(`No ${kind.toUpperCase()} for ${doc.name} yet`);
  const slug = doc.name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return { path: p, filename: `${row.content.name.replace(/[^A-Za-z0-9]+/g, "_")}_Resume_${slug}.${kind}` };
}

