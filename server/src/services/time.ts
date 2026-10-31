import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import type { DB } from "../db/client";
import { timeLogs } from "../db/schema";
import { getSettings, localDate } from "./settings";
import { ConflictError, NotFoundError } from "./jobs";
import { addDays, BUCKETS, hours, weekStart, type Bucket } from "../domain/week";
import type { RunningTimer, TimeEntry, WeekHours } from "../../../shared/types";

// Hours are the other half of the targets: the mentor prompt asks for hours
// as well as counts, because 10 applications in 2 hours and 10 in 6 hours are
// different weeks. One timer runs at a time; everything else is manual entry.

/** The mentor prompt's rule: a timer left running for two hours is probably forgotten, not worked. */
export const IDLE_LIMIT_MINUTES = 120;

const minutesBetween = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));

export function runningTimer(db: DB, now = new Date()): RunningTimer | null {
  const row = db.select().from(timeLogs).where(isNull(timeLogs.endedAt)).orderBy(desc(timeLogs.id)).limit(1).get();
  if (!row) return null;
  const elapsed = minutesBetween(row.startedAt, now);
  return {
    id: row.id,
    bucket: row.bucket,
    note: row.note,
    startedAt: row.startedAt.getTime(),
    elapsedMinutes: elapsed,
    // Past the limit the app stops counting and asks you what really happened,
    // rather than quietly logging an eight-hour "applications" session.
    needsConfirm: elapsed > IDLE_LIMIT_MINUTES,
  };
}

/** Starts the clock on a bucket. A timer already running is stopped first, so the two never overlap. */
export function startTimer(db: DB, bucket: Bucket, note: string | null, now = new Date()): RunningTimer {
  const open = runningTimer(db, now);
  if (open) {
    if (open.needsConfirm) throw new ConflictError(`A ${open.bucket} timer has been running for ${hours(open.elapsedMinutes)} hours. Say how long you actually worked first.`);
    stopTimer(db, open.id, now);
  }
  const row = db.insert(timeLogs).values({ bucket, startedAt: now, note: note?.trim() || null }).returning().get();
  return { id: row.id, bucket: row.bucket, note: row.note, startedAt: row.startedAt.getTime(), elapsedMinutes: 0, needsConfirm: false };
}

/** Stops a running timer. `minutes` overrides the elapsed time (what you confirm after a long gap). */
export function stopTimer(db: DB, id: number, now = new Date(), minutes?: number): TimeEntry {
  const row = db.select().from(timeLogs).where(eq(timeLogs.id, id)).get();
  if (!row) throw new NotFoundError(`Time log ${id} not found`);
  if (row.endedAt) throw new ConflictError("That timer is already stopped.");
  const logged = minutes ?? minutesBetween(row.startedAt, now);
  const endedAt = minutes === undefined ? now : new Date(row.startedAt.getTime() + minutes * 60_000);
  db.update(timeLogs).set({ endedAt, minutes: logged }).where(eq(timeLogs.id, id)).run();
  return toEntry(db, { ...row, endedAt, minutes: logged });
}

/** Discards a forgotten timer: no hours logged, nothing to explain later. */
export function discardTimer(db: DB, id: number) {
  const row = db.select().from(timeLogs).where(eq(timeLogs.id, id)).get();
  if (!row) throw new NotFoundError(`Time log ${id} not found`);
  if (row.endedAt) throw new ConflictError("That timer is already stopped.");
  db.delete(timeLogs).where(eq(timeLogs.id, id)).run();
}

/** Hours you worked but didn't time, entered after the fact. `date` defaults to today. */
export function logTime(db: DB, args: { bucket: Bucket; minutes: number; date?: string; note?: string | null }, now = new Date()): TimeEntry {
  if (args.minutes <= 0) throw new ConflictError("Minutes have to be more than zero.");
  const tz = getSettings(db).pipeline.timezone;
  const date = args.date ?? localDate(now, tz);
  // Noon local-ish: the entry lands on the day you picked whatever the hour.
  const startedAt = new Date(`${date}T12:00:00`);
  if (Number.isNaN(startedAt.getTime())) throw new ConflictError(`"${args.date}" isn't a date (use YYYY-MM-DD).`);
  const row = db
    .insert(timeLogs)
    .values({ bucket: args.bucket, startedAt, endedAt: new Date(startedAt.getTime() + args.minutes * 60_000), minutes: args.minutes, note: args.note?.trim() || null })
    .returning()
    .get();
  return toEntry(db, row);
}

export function deleteTimeEntry(db: DB, id: number) {
  const row = db.select().from(timeLogs).where(eq(timeLogs.id, id)).get();
  if (!row) throw new NotFoundError(`Time log ${id} not found`);
  db.delete(timeLogs).where(eq(timeLogs.id, id)).run();
}

function toEntry(db: DB, row: typeof timeLogs.$inferSelect): TimeEntry {
  const tz = getSettings(db).pipeline.timezone;
  return { id: row.id, bucket: row.bucket, date: localDate(row.startedAt, tz), minutes: row.minutes ?? 0, note: row.note };
}

/** Finished entries between two local dates, inclusive. */
export function listTime(db: DB, fromDate: string, toDate: string): TimeEntry[] {
  const tz = getSettings(db).pipeline.timezone;
  return db
    .select()
    .from(timeLogs)
    .where(and(gte(timeLogs.startedAt, new Date(`${fromDate}T00:00:00`)), lt(timeLogs.startedAt, new Date(`${addDays(toDate, 1)}T00:00:00`))))
    .orderBy(desc(timeLogs.startedAt))
    .all()
    .filter((r) => r.endedAt)
    .map((r) => toEntry(db, r));
}

/**
 * Hours this week against the cap. Overflow is the mentor prompt's rule:
 * project hours past the 6 in the cap are your approved choice, not a
 * violation, so they're reported separately instead of as a breach.
 */
export function weekHours(db: DB, now = new Date()): WeekHours {
  const s = getSettings(db);
  const today = localDate(now, s.pipeline.timezone);
  const start = weekStart(today);
  const entries = listTime(db, start, today);
  const byBucket = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  for (const e of entries) byBucket[e.bucket] += e.minutes;
  const budget = s.targets.bucketHours;
  const projectOverflow = Math.max(0, hours(byBucket.projects) - budget.projects);
  const core = hours(byBucket.applications + byBucket.prep) + Math.min(hours(byBucket.projects), budget.projects);
  return {
    weekStart: start,
    buckets: BUCKETS.map((b) => ({ bucket: b, hours: hours(byBucket[b]), target: budget[b] })),
    total: hours(byBucket.applications + byBucket.projects + byBucket.prep),
    cap: s.targets.hoursPerWeekCap,
    coreHours: Math.round(core * 10) / 10,
    projectOverflow: Math.round(projectOverflow * 10) / 10,
  };
}
