import cron, { type ScheduledTask } from "node-cron";
import { desc, inArray } from "drizzle-orm";
import type { DB } from "./db/client";
import { pipelineRuns } from "./db/schema";
import { getSettings, localDate, localTime } from "./services/settings";
import { runPipeline, type PipelineDeps } from "./services/pipeline";
import { needsDailyCheckIn, needsWeeklyReview, runDailyCheckIn, runWeeklyReview, type CheckInDeps } from "./services/checkIns";
import { isMailCheckDue, MAIL_CHECK_AT, runMailCheck, type MailDeps } from "./services/mail";

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

export function startScheduler(db: DB, deps: PipelineDeps, checkIn: CheckInDeps, log: (msg: string) => void, mail: MailDeps = {}) {
  let task: ScheduledTask | null = null;
  let mailTask: ScheduledTask | null = null;

  // The check-in reads the shortlist the run just produced, so it follows the
  // pipeline rather than running on its own schedule. A failure here never
  // fails the run: the jobs still arrive, the check-in is a button away.
  const checkInAfterRun = async () => {
    if (!checkIn.getCheckIn) return;
    try {
      if (needsDailyCheckIn(db)) {
        await runDailyCheckIn(db, checkIn);
        log("Daily check-in written.");
      }
      if (needsWeeklyReview(db)) {
        await runWeeklyReview(db, checkIn);
        log("Weekly review written.");
      }
    } catch (err) {
      log(`Check-in skipped: ${(err as Error).message}`);
    }
  };

  const run = (trigger: "schedule" | "catch_up") =>
    runPipeline(db, deps, trigger)
      .then(async (r) => {
        log(`Pipeline ${trigger} run ${r.id}: ${r.status}${r.message ? ` (${r.message})` : ""}`);
        await checkInAfterRun();
      })
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

  // The inbox: once a day at 8pm, on its own schedule (it doesn't depend on the morning run).
  const checkMail = (trigger: "schedule" | "catch_up") =>
    runMailCheck(db, mail, trigger)
      .then((r) => log(`Inbox ${trigger} check: ${r.matched} job emails, ${r.suggestions} to confirm, ${r.recorded} recorded.`))
      .catch((err) => log(`Inbox check skipped: ${(err as Error).message}`));

  const scheduleMail = () => {
    void mailTask?.stop();
    mailTask = null;
    const src = mail.getSource?.();
    if (!src || "unavailable" in src) return log(`Inbox check off: ${src && "unavailable" in src ? src.unavailable : "not set up"}.`);
    const [h, m] = MAIL_CHECK_AT.split(":").map(Number);
    const tz = getSettings(db).pipeline.timezone;
    mailTask = cron.schedule(`${m} ${h} * * *`, () => checkMail("schedule"), { timezone: tz, name: "daily-inbox", noOverlap: true });
    log(`Inbox check scheduled for ${MAIL_CHECK_AT} ${tz}.`);
    if (isMailCheckDue(db)) {
      log("Missed the last 8pm inbox check; checking now.");
      void checkMail("catch_up");
    }
  };

  schedule();
  catchUpIfMissed();
  scheduleMail();
  return {
    reschedule: () => {
      schedule();
      scheduleMail();
    },
    stop: () => {
      void task?.stop();
      void mailTask?.stop();
    },
  };
}
