import type { Tier } from "../../../shared/types";
import { daysSincePosted } from "./scoring";

// Ranking for the daily shortlist, as a pure function.

export type Candidate = {
  jobId: number;
  companyId: number;
  fitScore: number;
  tier: Tier;
  postedAt: string | null;
  location: string | null;
  remote: boolean;
  warmContact: boolean;
  /** Approved-or-later applications at this company in the last 30 days. */
  companyAppsLast30Days: number;
};

const MAX_PER_COMPANY_30D = 2;

/** Chicago or remote breaks ties (mentor prompt). */
function preferredLocation(c: Candidate, preferred: string[]): boolean {
  if (c.remote) return true;
  const loc = (c.location ?? "").toLowerCase();
  return preferred.some((p) => {
    const city = p.split(",")[0]!.trim().toLowerCase();
    return city.length > 0 && !city.startsWith("remote") && loc.includes(city);
  });
}

export function rankShortlist(
  candidates: Candidate[],
  opts: {
    size: number;
    preferredLocations: string[];
    now: Date;
    /** Only jobs scoring at least this make the list (Settings → Today's picks). */
    minFitScore?: number;
    /** Only postings at most this many days old. Unknown dates are kept. */
    maxAgeDays?: number;
  }
): number[] {
  const eligible = candidates.filter((c) => {
    if (c.tier !== "A" && c.tier !== "B") return false;
    if (c.fitScore < (opts.minFitScore ?? 5)) return false;
    const age = daysSincePosted(c.postedAt, opts.now);
    return opts.maxAgeDays === undefined || age === null || age <= opts.maxAgeDays;
  });
  const key = (c: Candidate) => {
    const age = daysSincePosted(c.postedAt, opts.now);
    return {
      score: c.fitScore,
      fresh: age !== null && age <= 7 ? 1 : 0, // prefer postings under a week old
      notStale: age === null || age <= 30 ? 1 : 0,
      pref: preferredLocation(c, opts.preferredLocations) ? 1 : 0,
      warm: c.warmContact ? 1 : 0,
      age: age ?? 9999,
    };
  };
  const sorted = [...eligible].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return (
      kb.notStale - ka.notStale ||
      kb.score - ka.score ||
      kb.fresh - ka.fresh ||
      kb.pref - ka.pref ||
      kb.warm - ka.warm ||
      ka.age - kb.age ||
      a.jobId - b.jobId
    );
  });

  // Respect "max 2 applications per company per 30 days": a company that
  // already has 1 recent application gets at most 1 slot today.
  const taken = new Map<number, number>();
  const picked: number[] = [];
  for (const c of sorted) {
    if (picked.length >= opts.size) break;
    const allowed = MAX_PER_COMPANY_30D - c.companyAppsLast30Days;
    const used = taken.get(c.companyId) ?? 0;
    if (used >= allowed) continue;
    taken.set(c.companyId, used + 1);
    picked.push(c.jobId);
  }
  return picked;
}
