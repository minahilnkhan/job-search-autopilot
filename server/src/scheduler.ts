import cron, { type ScheduledTask } from "node-cron";
import { desc, inArray } from "drizzle-orm";
import type { DB } from "./db/client";
import { pipelineRuns } from "./db/schema";
import { getSettings, localDate, localTime } from "./services/settings";
import { runPipeline, type PipelineDeps } from "./services/pipeline";

/**
 * Catch-up rule, pure so it's testable: if today's scheduled time has passed
 * and nothing has completed today (say the laptop was asleep at 7:00), run
 * now. Times compare as "HH:MM" strings, which sort correctly.
 */
export function shouldCatchUp(args: {
  enabled: boolean;
  today: string; // YYYY-MM-DD, local
  timeNow: string; // HH:MM, local
  dailyTime: string; // HH:MM
  lastCompletedRunDate: string | null; // local date of the last ok/partial run
}): boolean {
  return args.enabled && args.timeNow >= args.dailyTime && args.lastCompletedRunDate !== args.today;
}

export function startScheduler(db: DB, deps: PipelineDeps, log: (msg: string) => void) {
  let task: ScheduledTask | null = null;

  const run = (trigger: "schedule" | "catch_up") =>
    runPipeline(db, deps, trigger)
      .then((r) => log(`Pipeline ${trigger} run ${r.id}: ${r.status}${r.message ? ` (${r.message})` : ""}`))
      .catch((err) => log(`Pipeline ${trigger} run skipped: ${(err as Error).message}`));

  const schedule = () => {
    void task?.stop();
    task = null;
    const p = getSettings(db).pipeline;
    if (!p.enabled) return log("Daily pipeline is turned off in Settings.");
    const [h, m] = p.dailyTime.split(":").map(Number);
    task = cron.schedule(`${m} ${h} * * *`, () => run("schedule"), { timezone: p.timezone, name: "daily-pipeline", noOverlap: true });
    log(`Daily pipeline scheduled for ${p.dailyTime} ${p.timezone}.`);
  };

  const catchUpIfMissed = () => {
    const p = getSettings(db).pipeline;
    const now = new Date();
    const last = db
      .select({ startedAt: pipelineRuns.startedAt })
      .from(pipelineRuns)
      .where(inArray(pipelineRuns.status, ["ok", "partial"]))
      .orderBy(desc(pipelineRuns.id))
      .limit(1)
      .get();
    if (
      shouldCatchUp({
        enabled: p.enabled,
        today: localDate(now, p.timezone),
        timeNow: localTime(now, p.timezone),
        dailyTime: p.dailyTime,
        lastCompletedRunDate: last ? localDate(last.startedAt, p.timezone) : null,
      })
    ) {
      log("Missed today's scheduled run; catching up now.");
      void run("catch_up");
    }
  };

  schedule();
  catchUpIfMissed();
  return { reschedule: schedule, stop: () => void task?.stop() };
}
