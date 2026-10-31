import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { checkIns } from "../db/schema";
import { getSettings, localDate } from "./settings";
import { trackerState, trackerStateText } from "./tracker";
import { getShortlist } from "./pipeline";
import { replaceMentorTasks } from "./tasks";
import { recordUsage } from "./usage";
import { ConflictError } from "./jobs";
import { ScoreError } from "../llm/scoreJob";
import { accountProblem } from "../llm/errors";
import type { CheckInWriter, DailyCheckIn, WeeklyReview } from "../llm/checkIn";
import type { CheckInRecord, Settings, TrackerState } from "../../../shared/types";
import { weekStart } from "../domain/week";

// The mentor's two scheduled jobs. Each one: read the state, ask for the
// judgment parts, save the result, and turn its priorities into tasks.

export type CheckInDeps = { getCheckIn?: (s: Settings) => { writer: CheckInWriter } | { unavailable: string } };

/** The day's shortlist as a short table, so the mentor can see what it's planning around. */
function todayPicksText(db: DB, date: string): string {
  const list = getShortlist(db, date) ?? getShortlist(db);
  if (!list?.entries.length) return "";
  return list.entries
    .map((e) => `${e.rank}. ${e.job.companyName} — ${e.job.title} (${e.job.location ?? "location not stated"}), score ${e.job.fitScore ?? "?"}, tier ${e.job.tier ?? "?"}${e.warmContact ? ", warm contact" : ""}`)
    .join("\n");
}

const skillsText = (t: TrackerState) => t.skillsToBuild.map((k) => `${k.skill} (asked for in ${k.postings} posting${k.postings === 1 ? "" : "s"})`).join("\n");

async function run(db: DB, type: "daily" | "weekly", deps: CheckInDeps, now: Date) {
  const settings = getSettings(db);
  const w = deps.getCheckIn?.(settings);
  if (!w) throw new ConflictError("Check-ins aren't set up.");
  if ("unavailable" in w) throw new ConflictError(`The check-in can't run: ${w.unavailable}`);

  const state = trackerState(db, now);
  const input = { trackerState: trackerStateText(state), todayPicks: todayPicksText(db, state.date), skillsToBuild: skillsText(state) };
  try {
    const r = type === "daily" ? await w.writer.daily(input) : await w.writer.weekly(input);
    recordUsage(db, { purpose: `check_in_${type}`, model: r.model, usage: r.usage, now });
    return { state, output: r.output };
  } catch (err) {
    if (err instanceof ScoreError && err.usage) recordUsage(db, { purpose: `check_in_${type}`, model: settings.models.checkIns, usage: err.usage, now });
    throw new ConflictError(accountProblem(err) ?? (err as Error).message);
  }
}

/** Today's check-in. Running it again on the same day replaces it rather than stacking a second one. */
export async function runDailyCheckIn(db: DB, deps: CheckInDeps, now = new Date()): Promise<CheckInRecord> {
  const { state, output } = await run(db, "daily", deps, now);
  const daily = output as DailyCheckIn;
  replaceMentorTasks(
    db,
    state.date,
    daily.priorities.slice(0, 3).map((p) => ({ title: p.title, bucket: p.bucket, estimateMinutes: p.estimateMinutes }))
  );
  return save(db, "daily", state.date, state, daily);
}

/** The Sunday review. Its tasks are due at the end of the coming week, not today. */
export async function runWeeklyReview(db: DB, deps: CheckInDeps, now = new Date()): Promise<CheckInRecord> {
  const { state, output } = await run(db, "weekly", deps, now);
  const weekly = output as WeeklyReview;
  const due = state.date;
  replaceMentorTasks(db, due, [
    ...weekly.tasks.map((t) => ({ title: t.title, bucket: t.bucket, estimateMinutes: t.estimateMinutes })),
    { title: `GitHub: ${weekly.githubTask}`, bucket: "projects" as const, estimateMinutes: 60 },
  ]);
  return save(db, "weekly", state.date, state, weekly);
}

function save(db: DB, type: "daily" | "weekly", date: string, state: TrackerState, output: unknown): CheckInRecord {
  const existing = db.select().from(checkIns).where(and(eq(checkIns.date, date), eq(checkIns.type, type))).get();
  const row = existing
    ? db.update(checkIns).set({ inputState: state, mentorOutput: output }).where(eq(checkIns.id, existing.id)).returning().get()
    : db.insert(checkIns).values({ date, type, inputState: state, mentorOutput: output }).returning().get();
  return toRecord(row);
}

const toRecord = (row: typeof checkIns.$inferSelect): CheckInRecord => ({
  id: row.id,
  date: row.date,
  type: row.type,
  state: row.inputState as TrackerState,
  output: row.mentorOutput,
  createdAt: row.createdAt.getTime(),
});

export function latestCheckIn(db: DB, type: "daily" | "weekly"): CheckInRecord | null {
  const row = db.select().from(checkIns).where(eq(checkIns.type, type)).orderBy(desc(checkIns.date), desc(checkIns.id)).limit(1).get();
  return row ? toRecord(row) : null;
}

/** True when today's check-in hasn't run yet (the scheduler's catch-up rule). */
export function needsDailyCheckIn(db: DB, now = new Date()): boolean {
  const today = localDate(now, getSettings(db).pipeline.timezone);
  return !db.select().from(checkIns).where(and(eq(checkIns.date, today), eq(checkIns.type, "daily"))).get();
}

/** True on Sunday, when this week's review hasn't run yet. */
export function needsWeeklyReview(db: DB, now = new Date()): boolean {
  const today = localDate(now, getSettings(db).pipeline.timezone);
  if (new Date(`${today}T12:00:00Z`).getUTCDay() !== 0) return false;
  const last = latestCheckIn(db, "weekly");
  return !last || weekStart(last.date) !== weekStart(today);
}
