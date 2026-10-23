import { and, desc, eq, inArray, isNotNull, isNull, ne, notInArray } from "drizzle-orm";
import type { DB } from "../db/client";
import { applications, companies, jobs, pipelineRuns, shortlists } from "../db/schema";
import { extractFields } from "../domain/extract";
import { dedupeKey } from "../domain/normalize";
import { assembleScore, daysSincePosted } from "../domain/scoring";
import { rankShortlist, type Candidate } from "../domain/shortlist";
import type { FetchBoard, NormalizedPosting } from "../sources/types";
import type { Scorer } from "../llm/scoreJob";
import { ScoreError } from "../llm/scoreJob";
import { accountProblem } from "../llm/errors";
import { applicationHistory } from "./history";
import { filterJob, toJob, updateJob, NotFoundError } from "./jobs";
import { getSettings, localDate } from "./settings";
import { recordUsage } from "./usage";
import type { Job, PipelineProgress, PipelineRun, RunStats, Settings, Shortlist } from "../../../shared/types";

// The daily pipeline: fetch → dedupe → hard filters → AI scoring → shortlist.
// Deterministic steps come first so the paid step only sees jobs that can
// actually be applied to.

export type ScorerFactory = (settings: Settings) => { scorer: Scorer } | { unavailable: string };

export type PipelineDeps = {
  fetchBoard: FetchBoard;
  getScorer: ScorerFactory;
  now?: () => Date;
};

type CompanyRow = typeof companies.$inferSelect;

const SCORING_CONCURRENCY = 4;

// ---- 1. Fetch and store ---------------------------------------------------------

/** The board's employment type and remote flag go on top of the text so the regex extraction sees them. */
function describe(p: NormalizedPosting): string {
  const header = [
    p.employmentType ? `Employment type: ${p.employmentType}` : null,
    p.remote ? "Workplace: Remote" : null,
  ].filter(Boolean);
  return header.length ? `${header.join("\n")}\n\n${p.description}` : p.description;
}

export function ingestPostings(
  db: DB,
  company: CompanyRow,
  postings: NormalizedPosting[],
  now: Date
): { newJobs: number; passed: number } {
  let newJobs = 0;
  let passed = 0;
  for (const p of postings) {
    const key = dedupeKey(company.name, p.title, p.location);
    const existing = db.select({ id: jobs.id }).from(jobs).where(eq(jobs.dedupeKey, key)).get();
    if (existing) {
      // Seen before: just record that it's still open. Never re-score here.
      db.update(jobs).set({ lastSeenAt: now }).where(eq(jobs.id, existing.id)).run();
      continue;
    }
    const description = describe(p);
    const fields = extractFields({ title: p.title, location: p.location, description });
    const source = company.atsType ?? "board";
    const result = filterJob(db, { company, title: p.title, location: p.location, fields, source, now });
    const inserted = db
      .insert(jobs)
      .values({
        companyId: company.id,
        title: p.title,
        url: p.url,
        location: p.location,
        remote: fields.remote,
        postedAt: p.postedAt,
        fetchedAt: now,
        lastSeenAt: now,
        description,
        source,
        externalId: p.externalId,
        yearsRequired: fields.yearsRequired,
        sponsorshipStated: fields.sponsorshipStated,
        hardFilterPass: result.pass,
        filterFailReasons: result.reasons,
        extractedFields: fields,
        dedupeKey: key,
      })
      .onConflictDoNothing() // two postings in one feed that normalize to the same key
      .run();
    if (inserted.changes === 0) continue;
    newJobs++;
    if (result.pass) passed++;
  }
  return { newJobs, passed };
}

async function fetchAll(db: DB, deps: PipelineDeps, now: Date) {
  const boards = db
    .select()
    .from(companies)
    .where(and(inArray(companies.atsType, ["greenhouse", "lever", "ashby"]), isNotNull(companies.atsBoardToken)))
    .all();
  const stats = { companies: boards.length, companiesFailed: 0, postingsSeen: 0, newJobs: 0, passedFilters: 0 };
  if (progress) Object.assign(progress, { phase: "fetching", companiesTotal: boards.length, companiesDone: 0 });
  // One company at a time: polite to the job boards, and fast enough for ~a dozen.
  for (const c of boards) {
    if (stopRequested()) break;
    if (progress) progress.companiesDone++;
    try {
      const postings = await deps.fetchBoard({ atsType: c.atsType as "greenhouse" | "lever" | "ashby", token: c.atsBoardToken! });
      const r = ingestPostings(db, c, postings, now);
      stats.postingsSeen += postings.length;
      stats.newJobs += r.newJobs;
      stats.passedFilters += r.passed;
      db.update(companies).set({ atsLastCheckedAt: now, atsLastStatus: `ok: ${postings.length} postings` }).where(eq(companies.id, c.id)).run();
    } catch (err) {
      stats.companiesFailed++;
      db.update(companies)
        .set({ atsLastCheckedAt: now, atsLastStatus: `failed: ${(err as Error).message}` })
        .where(eq(companies.id, c.id))
        .run();
    }
  }
  return stats;
}

// ---- 2. Score ---------------------------------------------------------------------

export async function scoreJob(db: DB, jobId: number, scorer: Scorer, now: Date): Promise<{ costUsd: number }> {
  const row = db
    .select({ job: jobs, company: companies })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(jobs.id, jobId))
    .get();
  if (!row) throw new NotFoundError(`Job ${jobId} not found`);
  const { job, company } = row;

  let result;
  try {
    result = await scorer({
      companyName: company.name,
      title: job.title,
      location: job.location,
      postedAt: job.postedAt,
      employmentType: null, // already in the description header for board postings
      description: job.description,
    });
  } catch (err) {
    // Failed calls still cost tokens when they got a response; log those too.
    if (err instanceof ScoreError && err.usage) {
      recordUsage(db, { purpose: "scoring", model: getSettings(db).models.scoring, usage: err.usage, jobId, now });
    }
    throw err;
  }

  const cost = recordUsage(db, { purpose: "scoring", model: result.model, usage: result.usage, jobId, now }) ?? 0;
  const scored = assembleScore({
    judgment: result.judgment,
    company: { tags: company.tags, h1bHistory: company.h1bHistory, warmContact: company.warmContact },
    sponsorship: job.sponsorshipStated,
    postedAt: job.postedAt,
    model: result.model,
    now,
  });
  db.update(jobs)
    .set({ fitScore: scored.fitScore, tier: scored.tier, scoreBreakdown: scored.breakdown, redFlags: scored.redFlags, scoredAt: now })
    .where(eq(jobs.id, jobId))
    .run();
  return { costUsd: cost };
}

/** Postings older than this aren't scored: the mentor prompt treats them as likely stale or ghost jobs. */
export const MAX_SCORE_AGE_DAYS = 30;

/**
 * Re-check unscored job-board postings against the current rules, so a rule
 * change (like a tighter role screen) applies to the backlog before anything
 * is paid for. Pure code, no API calls.
 */
export function refilterUnscored(db: DB, now: Date): number {
  const ids = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(isNull(jobs.scoredAt), ne(jobs.source, "manual")))
    .all();
  for (const { id } of ids) updateJob(db, id, {}, now);
  return ids.length;
}

/** Unscored, recent jobs that passed the filters, newest postings first, up to the per-run cap. */
async function scorePending(db: DB, scorer: Scorer, max: number, now: Date) {
  const unscored = db
    .select({ id: jobs.id, postedAt: jobs.postedAt })
    .from(jobs)
    .where(and(eq(jobs.hardFilterPass, true), isNull(jobs.scoredAt), ne(jobs.status, "dismissed")))
    .orderBy(desc(jobs.postedAt), desc(jobs.id))
    .all();
  // Unknown posting dates are kept: no date isn't evidence of staleness.
  const fresh = unscored.filter((r) => (daysSincePosted(r.postedAt, now) ?? 0) <= MAX_SCORE_AGE_DAYS);
  const pending = fresh.map((r) => r.id);
  const batch = pending.slice(0, max);
  const out = {
    scored: 0,
    scoreErrors: 0,
    skippedStale: unscored.length - fresh.length,
    skippedOverCap: pending.length - batch.length,
    costUsd: 0,
    firstError: null as string | null,
    stoppedBecause: null as string | null,
    stoppedByYou: false,
    notAttempted: 0,
  };
  if (progress) Object.assign(progress, { phase: "scoring", toScore: batch.length, scored: 0 });

  const scoreOne = async (id: number) => {
    if (out.stoppedBecause) return;
    if (stopRequested()) {
      out.stoppedByYou = true;
      return;
    }
    try {
      out.costUsd += (await scoreJob(db, id, scorer, now)).costUsd;
      out.scored++;
      if (progress) Object.assign(progress, { scored: out.scored, costUsd: out.costUsd });
    } catch (err) {
      // No credits / bad key fails every call the same way: stop instead of
      // sending the rest of the batch just to collect the same error.
      const fatal = accountProblem(err);
      if (fatal) {
        out.stoppedBecause ??= fatal;
        return;
      }
      out.scoreErrors++;
      out.firstError ??= (err as Error).message;
    }
  };

  // The first call writes the prompt cache; run it alone so the parallel calls
  // after it read the cache instead of each writing their own copy.
  let next = 0;
  if (batch.length) await scoreOne(batch[next++]!);

  // Then a small worker pool: a few calls in flight keeps the run short without
  // tripping rate limits. The SDK retries 429s and 5xx on its own.
  const worker = async () => {
    while (next < batch.length) await scoreOne(batch[next++]!);
  };
  await Promise.all(Array.from({ length: SCORING_CONCURRENCY }, worker));
  out.notAttempted = batch.length - out.scored - out.scoreErrors;
  return out;
}

// ---- 3. Shortlist -------------------------------------------------------------------

export function buildShortlist(db: DB, settings: Settings, now: Date): number[] {
  const applied = db.select({ jobId: applications.jobId }).from(applications).all().map((r) => r.jobId);
  const rows = db
    .select({ job: jobs, company: companies })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(
      and(
        eq(jobs.hardFilterPass, true),
        eq(jobs.status, "new"), // shortlisted = already accepted; dismissed = no
        inArray(jobs.tier, ["A", "B"]),
        applied.length ? notInArray(jobs.id, applied) : undefined
      )
    )
    .all();

  const historyByCompany = new Map<number, number>();
  const candidates: Candidate[] = rows.map(({ job, company }) => {
    if (!historyByCompany.has(company.id)) {
      historyByCompany.set(company.id, applicationHistory(db, { companyId: company.id, title: "", now }).companyAppsLast30Days);
    }
    return {
      jobId: job.id,
      companyId: company.id,
      fitScore: job.fitScore ?? 0,
      tier: job.tier!,
      postedAt: job.postedAt,
      location: job.location,
      remote: job.remote,
      warmContact: company.warmContact,
      companyAppsLast30Days: historyByCompany.get(company.id)!,
    };
  });

  // Daily target plus a few spares, so you can drop some (mentor prompt: 12–13).
  const size = settings.targets.appsPerDay + 3;
  return rankShortlist(candidates, { size, preferredLocations: settings.locationPrefs.preferred, now });
}

// ---- Orchestration ------------------------------------------------------------------

let running = false;
export const isPipelineRunning = () => running;

// Live progress of the current run, for the UI's counter and Stop button.
let progress: PipelineProgress | null = null;
export const getPipelineProgress = () => progress;

/** Ask the current run to stop after the calls already in flight (at most a few). */
export function requestStop(): boolean {
  if (!running || !progress) return false;
  progress.stopRequested = true;
  return true;
}
const stopRequested = () => progress?.stopRequested === true;

/** Runs left "running" by an app that quit mid-run would otherwise look busy forever. */
export function markInterruptedRuns(db: DB): number {
  return db
    .update(pipelineRuns)
    .set({ status: "failed", finishedAt: new Date(), message: "Interrupted: the app stopped during this run. Anything scored before that was kept." })
    .where(eq(pipelineRuns.status, "running"))
    .run().changes;
}

export class PipelineBusyError extends Error {}

function toRun(r: typeof pipelineRuns.$inferSelect): PipelineRun {
  return {
    id: r.id,
    trigger: r.trigger,
    startedAt: r.startedAt.getTime(),
    finishedAt: r.finishedAt?.getTime() ?? null,
    status: r.status,
    stats: r.stats ?? null,
    message: r.message,
  };
}

export async function runPipeline(db: DB, deps: PipelineDeps, trigger: PipelineRun["trigger"]): Promise<PipelineRun> {
  if (running) throw new PipelineBusyError("A run is already in progress.");
  running = true;
  progress = { phase: "fetching", companiesDone: 0, companiesTotal: 0, scored: 0, toScore: 0, costUsd: 0, stopRequested: false };
  const now = deps.now?.() ?? new Date();
  const settings = getSettings(db);
  const run = db.insert(pipelineRuns).values({ trigger, startedAt: now }).returning().get();
  const notes: string[] = [];
  const stats: RunStats = {
    companies: 0, companiesFailed: 0, postingsSeen: 0, newJobs: 0, passedFilters: 0,
    scored: 0, scoreErrors: 0, skippedStale: 0, skippedOverCap: 0, shortlisted: 0, costUsd: 0,
  };

  try {
    Object.assign(stats, await fetchAll(db, deps, now));
    refilterUnscored(db, now);
    if (stats.companiesFailed) notes.push(`${stats.companiesFailed} job board(s) failed; see Companies.`);

    const s = deps.getScorer(settings);
    if (stopRequested()) {
      notes.push("Stopped by you before scoring started. Unscored jobs will be scored on the next run.");
    } else if ("unavailable" in s) {
      notes.push(`Scoring skipped: ${s.unavailable}`);
    } else {
      const r = await scorePending(db, s.scorer, settings.pipeline.maxScoresPerRun, now);
      stats.scored = r.scored;
      stats.scoreErrors = r.scoreErrors;
      stats.skippedOverCap = r.skippedOverCap;
      stats.skippedStale = r.skippedStale;
      stats.costUsd = r.costUsd;
      if (r.stoppedByYou) notes.push(`Stopped by you after ${r.scored} job(s). ${r.notAttempted} job(s) are waiting and will be scored on the next run.`);
      if (r.stoppedBecause) notes.push(`Scoring stopped: ${r.stoppedBecause} ${r.notAttempted} job(s) are waiting and will be scored on the next run.`);
      if (r.scoreErrors) notes.push(`${r.scoreErrors} job(s) failed to score. First error: ${r.firstError}`);
      if (r.skippedOverCap) notes.push(`${r.skippedOverCap} job(s) left for the next run (per-run scoring cap).`);
    }

    const ids = buildShortlist(db, settings, now);
    stats.shortlisted = ids.length;
    const date = localDate(now, settings.pipeline.timezone);
    db.insert(shortlists)
      .values({ date, runId: run.id, jobIds: ids })
      .onConflictDoUpdate({ target: shortlists.date, set: { runId: run.id, jobIds: ids } })
      .run();

    const failedEverything = stats.companies > 0 && stats.companiesFailed === stats.companies;
    const status = failedEverything ? "failed" : notes.length ? "partial" : "ok";
    const done = db
      .update(pipelineRuns)
      .set({ finishedAt: deps.now?.() ?? new Date(), status, stats, message: notes.join(" ") || null })
      .where(eq(pipelineRuns.id, run.id))
      .returning()
      .get();
    return toRun(done);
  } catch (err) {
    const done = db
      .update(pipelineRuns)
      .set({ finishedAt: new Date(), status: "failed", stats, message: (err as Error).message })
      .where(eq(pipelineRuns.id, run.id))
      .returning()
      .get();
    return toRun(done);
  } finally {
    running = false;
    progress = null;
  }
}

export function listRuns(db: DB, limit = 10): PipelineRun[] {
  return db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.id)).limit(limit).all().map(toRun);
}

/** Today's shortlist (or the most recent one), with each job's current state. */
export function getShortlist(db: DB, date?: string): Shortlist | null {
  const row = date
    ? db.select().from(shortlists).where(eq(shortlists.date, date)).get()
    : db.select().from(shortlists).orderBy(desc(shortlists.date)).limit(1).get();
  if (!row) return null;
  const run = row.runId ? db.select().from(pipelineRuns).where(eq(pipelineRuns.id, row.runId)).get() : undefined;
  const found = row.jobIds.length
    ? db
        .select({ job: jobs, company: companies })
        .from(jobs)
        .innerJoin(companies, eq(jobs.companyId, companies.id))
        .where(inArray(jobs.id, row.jobIds))
        .all()
    : [];
  const byId = new Map(found.map((r) => [r.job.id, r]));
  const entries = row.jobIds
    .map((id, i) => {
      const r = byId.get(id);
      if (!r) return null;
      const job: Job = toJob(r.job, r.company.name);
      return { rank: i + 1, job, eVerify: r.company.eVerify, warmContact: r.company.warmContact };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
  return { date: row.date, run: run ? toRun(run) : null, entries };
}
