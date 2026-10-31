// Week maths for the targets and the cap, kept pure so the dashboard, the
// check-in and the weekly review all count the same way.
//
// A "local date" here is always YYYY-MM-DD in your timezone (Settings →
// Pipeline), never a UTC date: applying at 9pm Chicago shouldn't count toward
// tomorrow. The mentor prompt's week runs Monday to Sunday.

export type Bucket = "applications" | "projects" | "prep";
export const BUCKETS: Bucket[] = ["applications", "projects", "prep"];

/** The Monday of the week containing `localDate`, as YYYY-MM-DD. */
export function weekStart(localDate: string): string {
  const d = new Date(`${localDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** `localDate` shifted by `days`, as YYYY-MM-DD. */
export function addDays(localDate: string, days: number): string {
  const d = new Date(`${localDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday → Sunday of the week containing `localDate`. */
export function weekDays(localDate: string): string[] {
  const start = weekStart(localDate);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

export const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

/**
 * Days in a row, ending today or yesterday, where you hit `target`. Today
 * counts only once it's hit, so a streak isn't broken before the day is over:
 * at 9am with 0 of 10 done, yesterday's streak still stands.
 */
export function streakDays(countsByDate: Map<string, number>, today: string, target: number): number {
  let streak = 0;
  let day = (countsByDate.get(today) ?? 0) >= target ? today : addDays(today, -1);
  while ((countsByDate.get(day) ?? 0) >= target) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}
