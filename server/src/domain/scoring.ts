import type { RequirementCheck, ScoreBreakdown, SponsorshipStated, Tier } from "../../../shared/types";

// Fit-score arithmetic from job-mentor-prompt.md, as pure functions.
// The AI supplies judgments (is each requirement met, how strong is the role
// signal and stack overlap). Everything that is counting or a company fact is
// done here, so the total is reproducible and explainable.

/** What the scoring model returns (see llm/scoreJob.ts for the schema). */
export type ModelJudgment = {
  requirements: RequirementCheck[];
  roleSignal: number;
  roleSignalReason: string;
  stackMatch: number;
  stackMatchReason: string;
  redFlags: string[];
  whyFits: string;
  gaps: string[];
};

export type CompanyFacts = { tags: string[]; h1bHistory: number | null; warmContact: boolean };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));

/**
 * A "yes" must point at an inventory fact. If the model says "yes" but gives
 * no evidence, it counts as "partial". This is the scoring-side half of the
 * no-fabrication rule; Phase 3's Truth Check is the resume-side half.
 */
export function normalizeRequirements(reqs: RequirementCheck[]): RequirementCheck[] {
  return reqs.map((r) =>
    r.met === "yes" && r.evidence.trim().length === 0 ? { ...r, met: "partial" } : r
  );
}

/** Requirements match, 0–4: share of must-haves met (partial = half). */
export function requirementsMatch(reqs: RequirementCheck[]): number {
  if (reqs.length === 0) return 2; // nothing extractable: neutral rather than zero
  const met = reqs.reduce((sum, r) => sum + (r.met === "yes" ? 1 : r.met === "partial" ? 0.5 : 0), 0);
  return clamp((4 * met) / reqs.length, 0, 4);
}

const AI_TAGS = ["ai-native", "fde-team"];
const DOMAIN_TAGS = ["ed-tech", "language-learning", "legal-tech", "gov-tech", "ai-policy"];

/** Strategic bonus, 0–2, from company facts only (no AI involved). */
export function strategicBonus(c: CompanyFacts): { bonus: number; reasons: string[] } {
  const tags = c.tags.map((t) => t.toLowerCase());
  const reasons: string[] = [];
  if (tags.some((t) => AI_TAGS.includes(t))) reasons.push("AI-native company or known FDE team");
  const domain = tags.find((t) => DOMAIN_TAGS.includes(t));
  if (domain) reasons.push(`${domain} company`);
  if ((c.h1bHistory ?? 0) > 0) reasons.push(`H-1B sponsorship history (${c.h1bHistory} filings)`);
  if (c.warmContact) reasons.push("You know someone there");
  return { bonus: Math.min(2, reasons.length), reasons };
}

/** Tier A = 8–10, B = 5–7, skip ≤ 4. "No sponsorship" caps at B. */
export function tierFor(total: number, sponsorship: SponsorshipStated): { tier: Tier; cap: string | null } {
  const raw: Tier = total >= 8 ? "A" : total >= 5 ? "B" : "skip";
  if (raw === "A" && sponsorship === "no") {
    return { tier: "B", cap: "Capped at Tier B: the posting says no visa sponsorship." };
  }
  return { tier: raw, cap: null };
}

const DAY_MS = 86_400_000;

export function daysSincePosted(postedAt: string | null, now: Date): number | null {
  if (!postedAt) return null;
  const t = Date.parse(`${postedAt}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / DAY_MS);
}

export function assembleScore(args: {
  judgment: ModelJudgment;
  company: CompanyFacts;
  sponsorship: SponsorshipStated;
  postedAt: string | null;
  model: string;
  now: Date;
}): { breakdown: ScoreBreakdown; fitScore: number; tier: Tier; redFlags: string[] } {
  const { judgment: j } = args;
  const requirements = normalizeRequirements(j.requirements);
  const req = requirementsMatch(requirements);
  const role = clamp(j.roleSignal, 0, 2);
  const stack = clamp(j.stackMatch, 0, 2);
  const strategic = strategicBonus(args.company);
  const total = clamp(req + role + stack + strategic.bonus, 1, 10);
  const { tier, cap } = tierFor(total, args.sponsorship);

  const redFlags = [...j.redFlags];
  const age = daysSincePosted(args.postedAt, args.now);
  if (age !== null && age > 30) redFlags.push(`Posted ${age} days ago: likely stale or a ghost job.`);

  return {
    fitScore: total,
    tier,
    redFlags,
    breakdown: {
      requirements,
      requirementsMatch: req,
      roleSignal: role,
      roleSignalReason: j.roleSignalReason,
      stackMatch: stack,
      stackMatchReason: j.stackMatchReason,
      strategicBonus: strategic.bonus,
      strategicReasons: strategic.reasons,
      total,
      tierCap: cap,
      whyFits: j.whyFits,
      gaps: j.gaps,
      model: args.model,
    },
  };
}
