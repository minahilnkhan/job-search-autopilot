import type { DB } from "../db/client";
import { applications } from "../db/schema";
import { isNotNull } from "drizzle-orm";
import { listApplications } from "./applications";
import { listTracked } from "./submissions";
import { getSettings, localDate } from "./settings";

/** The numbers Today's four steps show: what's waiting at each step, and progress against your targets. */
export function daySummary(db: DB, now = new Date()) {
  const s = getSettings(db);
  const tz = s.pipeline.timezone;
  const today = localDate(now, tz);
  // Monday of this week, in your timezone.
  const d = new Date(`${today}T12:00:00Z`);
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);

  const submittedDays = db
    .select({ at: applications.submittedAt })
    .from(applications)
    .where(isNotNull(applications.submittedAt))
    .all()
    .map((r) => localDate(r.at!, tz));
  const tracked = listTracked(db);
  const due = tracked.filter((t) => t.followUpDue && t.followUpDue <= today);
  return {
    date: today,
    today: { submitted: submittedDays.filter((x) => x === today).length, target: s.targets.appsPerDay },
    week: { submitted: submittedDays.filter((x) => x >= weekStart).length, target: s.targets.appsPerDay * s.targets.daysPerWeek },
    review: listApplications(db, "review", now).length,
    blocked: listApplications(db, "blocked", now).length,
    snoozed: listApplications(db, "snoozed", now).length,
    approved: listApplications(db, "approved", now).length,
    followUps: { due: due.length, next: due[0] ? { id: due[0].id, companyName: due[0].companyName, jobTitle: due[0].jobTitle } : null },
    pipeline: {
      submitted: tracked.filter((t) => t.status === "submitted").length,
      screen: tracked.filter((t) => t.status === "screen").length,
      interview: tracked.filter((t) => t.status === "interview").length,
      offer: tracked.filter((t) => t.status === "offer").length,
    },
  };
}
