import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { applications, companies, jobs } from "../db/schema";
import { extractFields } from "../domain/extract";
import { runHardFilters } from "../domain/hardFilters";
import { dedupeKey } from "../domain/normalize";
import { applicationHistory } from "./history";
import { getSettings } from "./settings";
import type {
  CreateJobRequest,
  CreateJobResponse,
  ExtractedFields,
  Job,
  JobListItem,
  JobStatus,
} from "../../../shared/types";

export type JobRow = typeof jobs.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

function toJob(row: JobRow, companyName: string): Job {
  return {
    id: row.id,
    companyId: row.companyId,
    companyName,
    title: row.title,
    url: row.url,
    location: row.location,
    remote: row.remote,
    postedAt: row.postedAt,
    description: row.description,
    source: row.source,
    yearsRequired: row.yearsRequired,
    sponsorshipStated: row.sponsorshipStated,
    hardFilterPass: row.hardFilterPass,
    filterOverride: !!row.filterOverride,
    filterReasons: row.filterFailReasons,
    extractedFields: row.extractedFields,
    fitScore: row.fitScore,
    scoreBreakdown: row.scoreBreakdown ?? null,
    redFlags: row.redFlags ?? [],
    tier: row.tier,
    scoredAt: row.scoredAt?.getTime() ?? null,
    externalId: row.externalId,
    status: row.status,
    createdAt: row.createdAt.getTime(),
  };
}

export function findOrCreateCompany(db: DB, name: string): CompanyRow {
  const clean = name.trim();
  const existing = db
    .select()
    .from(companies)
    .where(sql`lower(${companies.name}) = lower(${clean})`)
    .get();
  if (existing) return existing;
  return db.insert(companies).values({ name: clean }).returning().get();
}

export function filterJob(
  db: DB,
  args: {
    company: CompanyRow;
    title: string;
    location: string | null;
    fields: ExtractedFields;
    source: string;
    jobId?: number;
    now: Date;
  }
) {
  const history = applicationHistory(db, {
    companyId: args.company.id,
    title: args.title,
    excludeJobId: args.jobId,
    now: args.now,
  });
  const result = runHardFilters({
    title: args.title,
    location: args.location,
    fields: args.fields,
    company: { eVerify: args.company.eVerify },
    history,
    requireTargetRole: args.source !== "manual",
    otherCountries: getSettings(db).locationPrefs.otherCountries,
  });
  // "Continue anyway" keeps a job going whatever its filters say; the reasons stay visible.
  const overridden = args.jobId ? !!db.select({ o: jobs.filterOverride }).from(jobs).where(eq(jobs.id, args.jobId)).get()?.o : false;
  return { ...result, pass: result.pass || overridden };
}

export { toJob };

export function getJob(db: DB, id: number): Job {
  const row = db
    .select({ job: jobs, companyName: companies.name })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(jobs.id, id))
    .get();
  if (!row) throw new NotFoundError(`Job ${id} not found`);
  return toJob(row.job, row.companyName);
}

/**
 * List view: no descriptions (the UI loads one when you expand a job), and
 * job-board postings screened out as off-target are left out unless asked for,
 * since a single company board can hold hundreds of them.
 */
export function listJobs(db: DB, opts: { includeOffTarget?: boolean } = {}): JobListItem[] {
  return db
    .select({ job: jobs, companyName: companies.name })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(isNull(jobs.deletedAt))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .all()
    .map((r) => {
      const { description: _d, ...rest } = toJob(r.job, r.companyName);
      return rest;
    })
    .filter((j) => opts.includeOffTarget || !j.filterReasons.some((r) => r.code === "off_target_role"));
}

/** Manual paste: dedupe → hard filters → insert. */
export function createJob(db: DB, req: CreateJobRequest, now = new Date()): CreateJobResponse {
  const company = findOrCreateCompany(db, req.companyName);
  const location = req.location?.trim() || null;
  const key = dedupeKey(company.name, req.title, location);

  const dup = db.select({ id: jobs.id }).from(jobs).where(eq(jobs.dedupeKey, key)).get();
  if (dup) {
    // Pasting a job you deleted brings it back.
    db.update(jobs).set({ deletedAt: null, status: "new" }).where(and(eq(jobs.id, dup.id), isNotNull(jobs.deletedAt))).run();
    return { duplicate: true, job: getJob(db, dup.id) };
  }

  const fields = req.fields ?? extractFields({ title: req.title, location, description: req.description });
  const result = filterJob(db, { company, title: req.title, location, fields, source: "manual", now });

  const inserted = db
    .insert(jobs)
    .values({
      companyId: company.id,
      title: req.title.trim(),
      url: req.url?.trim() || null, // stored as metadata only; never fetched in Phase 1
      location,
      remote: fields.remote,
      postedAt: req.postedAt || null,
      description: req.description,
      source: "manual",
      yearsRequired: fields.yearsRequired,
      sponsorshipStated: fields.sponsorshipStated,
      hardFilterPass: result.pass,
      filterFailReasons: result.reasons,
      extractedFields: fields,
      fieldsConfirmed: true, // you reviewed them on the Add a job page
      dedupeKey: key,
    })
    .returning()
    .get();
  return { duplicate: false, job: toJob(inserted, company.name) };
}

export type JobPatch = {
  title?: string;
  location?: string | null;
  url?: string | null;
  postedAt?: string | null;
  fields?: ExtractedFields;
  status?: JobStatus;
};

/** Edit a job's fields and re-run the filters on the new values. */
export function updateJob(db: DB, id: number, patch: JobPatch, now = new Date(), opts: { confirm?: boolean } = {}): Job {
  const current = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!current) throw new NotFoundError(`Job ${id} not found`);
  const company = db.select().from(companies).where(eq(companies.id, current.companyId)).get()!;

  const title = patch.title?.trim() ?? current.title;
  const location = patch.location !== undefined ? patch.location?.trim() || null : current.location;
  const fields = patch.fields ?? current.extractedFields;
  const key = dedupeKey(company.name, title, location);
  if (key !== current.dedupeKey) {
    const clash = db.select({ id: jobs.id }).from(jobs).where(eq(jobs.dedupeKey, key)).get();
    if (clash) throw new ConflictError(`That would duplicate job ${clash.id}`);
  }

  const result = filterJob(db, { company, title, location, fields, source: current.source, jobId: id, now });
  db.update(jobs)
    .set({
      title,
      location,
      url: patch.url !== undefined ? patch.url?.trim() || null : current.url,
      postedAt: patch.postedAt !== undefined ? patch.postedAt || null : current.postedAt,
      remote: fields.remote,
      yearsRequired: fields.yearsRequired,
      sponsorshipStated: fields.sponsorshipStated,
      extractedFields: fields,
      // Edits from the UI mark fields as confirmed; automatic re-extraction doesn't.
      fieldsConfirmed: patch.fields && opts.confirm !== false ? true : current.fieldsConfirmed,
      hardFilterPass: result.pass,
      filterFailReasons: result.reasons,
      dedupeKey: key,
      status: patch.status ?? current.status,
    })
    .where(eq(jobs.id, id))
    .run();
  return getJob(db, id);
}

/** Company facts (e.g. E-Verify) feed the filters, so re-run them when those change. */
export function refilterCompanyJobs(db: DB, companyId: number, now = new Date()): number {
  const ids = db.select({ id: jobs.id }).from(jobs).where(eq(jobs.companyId, companyId)).all();
  for (const { id } of ids) updateJob(db, id, {}, now);
  return ids.length;
}

const SUBMITTED_OR_LATER = ["submitted", "screen", "interview", "offer", "rejected", "ghosted"];

/**
 * Delete jobs from the Jobs page. Applications you haven't submitted are
 * withdrawn with them. Jobs you've submitted an application to are kept,
 * because the Tracker needs them. Deleted rows stay in the database (hidden),
 * so the daily fetch doesn't bring the same posting back.
 */
export function deleteJobs(db: DB, ids: number[], now = new Date()): { deleted: number; kept: { id: number; title: string; reason: string }[] } {
  if (!ids.length) return { deleted: 0, kept: [] };
  const rows = db.select({ id: jobs.id, title: jobs.title }).from(jobs).where(and(inArray(jobs.id, ids), isNull(jobs.deletedAt))).all();
  const apps = db.select({ id: applications.id, jobId: applications.jobId, status: applications.status }).from(applications).where(inArray(applications.jobId, ids)).all();
  const kept: { id: number; title: string; reason: string }[] = [];
  let deleted = 0;
  db.transaction((tx) => {
    for (const j of rows) {
      const mine = apps.filter((a) => a.jobId === j.id);
      if (mine.some((a) => SUBMITTED_OR_LATER.includes(a.status))) {
        kept.push({ id: j.id, title: j.title, reason: "You've submitted an application for it; it stays on the Tracker." });
        continue;
      }
      for (const a of mine) {
        if (a.status === "withdrawn") continue;
        tx.update(applications).set({ status: "withdrawn", reviewReason: "Job deleted", lastActivityAt: now }).where(eq(applications.id, a.id)).run();
      }
      tx.update(jobs).set({ deletedAt: now, status: "dismissed" }).where(eq(jobs.id, j.id)).run();
      deleted++;
    }
  });
  return { deleted, kept };
}

/** "Continue anyway": go ahead with a job despite a failed hard filter. Undo puts the filters back in charge. */
export function overrideFilters(db: DB, id: number, on: boolean, now = new Date()) {
  const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) throw new NotFoundError(`Job ${id} not found`);
  const failing = (job.filterFailReasons ?? []).some((r) => r.severity === "fail");
  db.update(jobs)
    .set({ filterOverride: on ? now : null, hardFilterPass: on || !failing, ...(on && job.status === "dismissed" ? { status: "new" as const } : {}) })
    .where(eq(jobs.id, id))
    .run();
  return getJob(db, id);
}
