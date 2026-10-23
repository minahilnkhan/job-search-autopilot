import { desc, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { companies, jobs } from "../db/schema";
import { extractFields } from "../domain/extract";
import { runHardFilters } from "../domain/hardFilters";
import { dedupeKey } from "../domain/normalize";
import { applicationHistory } from "./history";
import type {
  CreateJobRequest,
  CreateJobResponse,
  ExtractedFields,
  Job,
  JobStatus,
} from "../../../shared/types";

type JobRow = typeof jobs.$inferSelect;
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
    filterReasons: row.filterFailReasons,
    extractedFields: row.extractedFields,
    fitScore: row.fitScore,
    tier: row.tier,
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

function filterJob(
  db: DB,
  args: { company: CompanyRow; title: string; location: string | null; fields: ExtractedFields; jobId?: number; now: Date }
) {
  const history = applicationHistory(db, {
    companyId: args.company.id,
    title: args.title,
    excludeJobId: args.jobId,
    now: args.now,
  });
  return runHardFilters({
    title: args.title,
    location: args.location,
    fields: args.fields,
    company: { eVerify: args.company.eVerify },
    history,
  });
}

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

export function listJobs(db: DB): Job[] {
  return db
    .select({ job: jobs, companyName: companies.name })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .all()
    .map((r) => toJob(r.job, r.companyName));
}

/** Manual paste: dedupe → hard filters → insert. */
export function createJob(db: DB, req: CreateJobRequest, now = new Date()): CreateJobResponse {
  const company = findOrCreateCompany(db, req.companyName);
  const location = req.location?.trim() || null;
  const key = dedupeKey(company.name, req.title, location);

  const dup = db.select({ id: jobs.id }).from(jobs).where(eq(jobs.dedupeKey, key)).get();
  if (dup) return { duplicate: true, job: getJob(db, dup.id) };

  const fields = req.fields ?? extractFields({ title: req.title, location, description: req.description });
  const result = filterJob(db, { company, title: req.title, location, fields, now });

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
export function updateJob(db: DB, id: number, patch: JobPatch, now = new Date()): Job {
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

  const result = filterJob(db, { company, title, location, fields, jobId: id, now });
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
