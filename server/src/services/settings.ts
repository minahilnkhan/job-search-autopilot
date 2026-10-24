import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { settings } from "../db/schema";
import { DEFAULT_SETTINGS } from "../domain/settingsDefaults";
import type { Settings } from "../../../shared/types";

export function getSettings(db: DB): Settings {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (!row) return DEFAULT_SETTINGS;
  const { id: _id, extensionToken: _t, ...rest } = row;
  // Fill keys added after the row was first saved (JSON columns don't migrate per key).
  // Keep only known keys (an older row may still carry minFitScore).
  const { tierAPicks, tierBPicks, maxAgeDays, preferredCityBoost } = { ...DEFAULT_SETTINGS.shortlist, ...rest.shortlist };
  return { ...rest, profile: { ...DEFAULT_SETTINGS.profile, ...rest.profile }, submit: { ...DEFAULT_SETTINGS.submit, ...rest.submit }, shortlist: { tierAPicks, tierBPicks, maxAgeDays, preferredCityBoost } };
}

/** YYYY-MM-DD for `now` in an IANA timezone (en-CA formats dates that way). */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** HH:MM for `now` in an IANA timezone. */
export function localTime(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
}
