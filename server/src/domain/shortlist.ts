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

/** In one of your preferred cities (Settings → Location), e.g. Chicago. */
export function inPreferredCity(location: string | null, preferred: string[]): boolean {
  const loc = (location ?? "").toLowerCase();
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
    /**
     * Extra ranking points for jobs in a preferred city. With 1, a Chicago 7
     * clears an 8 minimum and ranks alongside other 8s. The fit score itself
     * (and its tier) is unchanged; this only affects Today's picks.
     */
    preferredCityBoost?: number;
    /**
     * Picks per tier, e.g. { A: 5, B: 5 }. A job fills a slot of its real
     * tier; the city boost only changes order within a tier. When set, `size`
     * is the sum of the two.
     */
    perTier?: { A: number; B: number };
  }
): number[] {
  const boost = opts.preferredCityBoost ?? 0;
  const rankScore = (c: Candidate) => c.fitScore + (inPreferredCity(c.location, opts.preferredLocations) ? boost : 0);
  const eligible = candidates.filter((c) => {
    if (c.tier !== "A" && c.tier !== "B") return false;
    if (rankScore(c) < (opts.minFitScore ?? 5)) return false;
    const age = daysSincePosted(c.postedAt, opts.now);
    return opts.maxAgeDays === undefined || age === null || age <= opts.maxAgeDays;
  });
  const key = (c: Candidate) => {
    const age = daysSincePosted(c.postedAt, opts.now);
    const city = inPreferredCity(c.location, opts.preferredLocations);
    return {
      rank: rankScore(c),
      city: city ? 1 : 0,
      score: c.fitScore,
      // Mentor prompt v2: eligible up to 14 days, preferred up to 7, and under
      // 72 hours is best (fewer applicants yet).
      fresh: age !== null && age <= 7 ? 1 : 0,
      veryFresh: age !== null && age <= 3 ? 1 : 0,
      notStale: age === null || age <= 14 ? 1 : 0,
      remote: c.remote ? 1 : 0,
      warm: c.warmContact ? 1 : 0,
      age: age ?? 9999,
    };
  };
  const sorted = [...eligible].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return (
      kb.notStale - ka.notStale ||
      kb.rank - ka.rank || // fit score plus the preferred-city boost
      kb.city - ka.city || // on a tie, the preferred city wins
      kb.score - ka.score ||
      kb.fresh - ka.fresh ||
      kb.veryFresh - ka.veryFresh ||
      kb.remote - ka.remote || // then remote (mentor prompt: Chicago or remote breaks a tie)
      kb.warm - ka.warm ||
      ka.age - kb.age ||
      a.jobId - b.jobId
    );
  });

  // Respect "max 2 applications per company per 30 days": a company that
  // already has 1 recent application gets at most 1 slot today.
  const taken = new Map<number, number>();
  const picked: { id: number; tier: "A" | "B" }[] = [];
  const tierCount = { A: 0, B: 0 };
  const size = opts.perTier ? opts.perTier.A + opts.perTier.B : opts.size;
  for (const c of sorted) {
    if (picked.length >= size) break;
    const tier = c.tier as "A" | "B";
    if (opts.perTier && tierCount[tier] >= opts.perTier[tier]) continue;
    const allowed = MAX_PER_COMPANY_30D - c.companyAppsLast30Days;
    const used = taken.get(c.companyId) ?? 0;
    if (used >= allowed) continue;
    taken.set(c.companyId, used + 1);
    tierCount[tier]++;
    picked.push({ id: c.jobId, tier });
  }
  // Tier A first, each tier in rank order.
  return opts.perTier ? [...picked.filter((p) => p.tier === "A"), ...picked.filter((p) => p.tier === "B")].map((p) => p.id) : picked.map((p) => p.id);
}
