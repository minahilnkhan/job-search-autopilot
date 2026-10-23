import { describe, expect, it } from "vitest";
import { assembleScore, normalizeRequirements, requirementsMatch, strategicBonus, tierFor } from "../src/domain/scoring";
import { isTargetRole } from "../src/domain/roleFamily";
import { GOOD_JUDGMENT } from "./helpers";

const NOW = new Date("2026-10-23T12:00:00Z");
const req = (met: "yes" | "partial" | "no", evidence = "fact") => ({ requirement: "x", met, evidence });

describe("requirements match (0–4)", () => {
  it("is the share met, with partial worth half", () => {
    expect(requirementsMatch([req("yes"), req("yes"), req("yes"), req("yes")])).toBe(4);
    expect(requirementsMatch([req("yes"), req("no")])).toBe(2);
    expect(requirementsMatch([req("partial"), req("partial"), req("no"), req("no")])).toBe(1);
    expect(requirementsMatch([req("no"), req("no")])).toBe(0);
  });

  it("is neutral (2) when no requirements came back", () => {
    expect(requirementsMatch([])).toBe(2);
  });

  it("downgrades a 'yes' with no inventory evidence to 'partial'", () => {
    expect(normalizeRequirements([req("yes", "  ")])[0]!.met).toBe("partial");
    expect(requirementsMatch(normalizeRequirements([req("yes", ""), req("yes", "")]))).toBe(2);
  });
});

describe("strategic bonus (0–2), from company facts only", () => {
  it("adds AI-native, domain, H-1B and warm contact, capped at 2", () => {
    expect(strategicBonus({ tags: [], h1bHistory: null, warmContact: false }).bonus).toBe(0);
    expect(strategicBonus({ tags: ["ai-native"], h1bHistory: null, warmContact: false }).bonus).toBe(1);
    expect(strategicBonus({ tags: ["ai-native", "legal-tech"], h1bHistory: 40, warmContact: true }).bonus).toBe(2);
    expect(strategicBonus({ tags: [], h1bHistory: 0, warmContact: false }).bonus).toBe(0);
  });
});

describe("tiers", () => {
  it.each([
    [10, "A"], [8, "A"], [7, "B"], [5, "B"], [4, "skip"], [1, "skip"],
  ] as const)("%d → %s", (score, tier) => {
    expect(tierFor(score, "unstated").tier).toBe(tier);
  });

  it("caps 'no sponsorship' postings at B and says why", () => {
    expect(tierFor(9, "no")).toEqual({ tier: "B", cap: expect.stringContaining("no visa sponsorship") });
    expect(tierFor(6, "no").cap).toBeNull();
  });
});

describe("assembleScore", () => {
  const base = { company: { tags: ["ai-native"], h1bHistory: null, warmContact: false }, sponsorship: "unstated" as const, model: "claude-haiku-5-5", now: NOW };

  it("adds the parts: requirements 4×(3.5/4)=4 (rounded) + role 2 + stack 2 + bonus 1 → capped at 10 → 9", () => {
    const r = assembleScore({ ...base, judgment: GOOD_JUDGMENT, postedAt: "2026-10-20" });
    expect(r.breakdown.requirementsMatch).toBe(4); // 3.5 of 4 met → 3.5 → rounds to 4
    expect(r.fitScore).toBe(9);
    expect(r.tier).toBe("A");
    expect(r.breakdown.strategicReasons).toEqual(["AI-native company or known FDE team"]);
  });

  it("clamps out-of-range model numbers", () => {
    const r = assembleScore({ ...base, judgment: { ...GOOD_JUDGMENT, roleSignal: 7, stackMatch: -3 }, postedAt: null });
    expect(r.breakdown.roleSignal).toBe(2);
    expect(r.breakdown.stackMatch).toBe(0);
  });

  it("flags postings older than 30 days as stale", () => {
    const r = assembleScore({ ...base, judgment: GOOD_JUDGMENT, postedAt: "2026-09-01" });
    expect(r.redFlags.join(" ")).toMatch(/52 days ago/);
  });
});

describe("role family screen (job-board postings)", () => {
  it.each([
    "Forward Deployed Engineer",
    "Solutions Engineer",
    "Software Engineer, New Grad",
    "Deployment Strategist",
    "Applied AI Engineer",
    "Full-Stack Developer",
    "Customer Engineer",
  ])("keeps %s", (t) => expect(isTargetRole(t)).toBe(true));

  it.each([
    "Account Executive",
    "Accountant",
    "Technical Recruiter",
    "Research Scientist",
    "Engineering Manager",
    "Hardware Engineer",
    "Product Designer",
  ])("drops %s", (t) => expect(isTargetRole(t)).toBe(false));
});
