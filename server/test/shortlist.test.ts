import { describe, expect, it } from "vitest";
import { rankShortlist, type Candidate } from "../src/domain/shortlist";

const NOW = new Date("2026-10-23T12:00:00Z");
let nextId = 1;
const c = (o: Partial<Candidate>): Candidate => ({
  jobId: nextId++,
  companyId: 1,
  fitScore: 6,
  tier: "B",
  postedAt: "2026-10-20",
  location: "New York, NY",
  remote: false,
  warmContact: false,
  companyAppsLast30Days: 0,
  ...o,
});
const rank = (cs: Candidate[], size = 13) => rankShortlist(cs, { size, preferredLocations: ["Chicago, IL", "Remote (US)"], now: NOW });

describe("rankShortlist", () => {
  it("orders by score, highest first, and drops skip-tier jobs", () => {
    const a = c({ fitScore: 6, companyId: 1 });
    const b = c({ fitScore: 9, tier: "A", companyId: 2 });
    const skip = c({ fitScore: 3, tier: "skip", companyId: 3 });
    expect(rank([a, b, skip])).toEqual([b.jobId, a.jobId]);
  });

  it("breaks ties by freshness, then Chicago/remote, then warm contact", () => {
    const old = c({ postedAt: "2026-10-01", companyId: 1 });
    const fresh = c({ postedAt: "2026-10-21", companyId: 2 });
    expect(rank([old, fresh])).toEqual([fresh.jobId, old.jobId]);

    const ny = c({ companyId: 3 });
    const chicago = c({ location: "Chicago, IL", companyId: 4 });
    const remote = c({ remote: true, location: "Remote", companyId: 5 });
    expect(rank([ny, chicago]).at(0)).toBe(chicago.jobId);
    expect(rank([ny, remote]).at(0)).toBe(remote.jobId);

    const warm = c({ warmContact: true, companyId: 6 });
    expect(rank([ny, warm]).at(0)).toBe(warm.jobId);
  });

  it("puts stale (30+ day) postings below fresh ones even with a higher score", () => {
    const stale = c({ fitScore: 9, tier: "A", postedAt: "2026-08-01", companyId: 1 });
    const ok = c({ fitScore: 6, companyId: 2 });
    expect(rank([stale, ok])).toEqual([ok.jobId, stale.jobId]);
  });

  it("allows at most 2 per company, fewer if you've applied there recently", () => {
    const three = [c({ companyId: 7 }), c({ companyId: 7 }), c({ companyId: 7 })];
    expect(rank(three)).toHaveLength(2);
    const recent = [c({ companyId: 8, companyAppsLast30Days: 1 }), c({ companyId: 8, companyAppsLast30Days: 1 })];
    expect(rank(recent)).toHaveLength(1);
    const capped = [c({ companyId: 9, companyAppsLast30Days: 2 })];
    expect(rank(capped)).toHaveLength(0);
  });

  it("stops at the requested size", () => {
    const many = Array.from({ length: 20 }, (_, i) => c({ companyId: 100 + i }));
    expect(rank(many, 13)).toHaveLength(13);
  });
});

describe("Today's picks thresholds", () => {
  const opts = { size: 13, preferredLocations: [], now: NOW };
  it("keeps only jobs at or above the minimum fit score", () => {
    const seven = c({ fitScore: 7, companyId: 1 });
    const eight = c({ fitScore: 8, tier: "A", companyId: 2 });
    const nine = c({ fitScore: 9, tier: "A", companyId: 3 });
    expect(rankShortlist([seven, eight, nine], { ...opts, minFitScore: 8 })).toEqual([nine.jobId, eight.jobId]);
  });

  it("drops postings older than the age limit but keeps unknown dates", () => {
    const fresh = c({ postedAt: "2026-10-20", companyId: 1 });
    const old = c({ postedAt: "2026-10-01", companyId: 2 }); // 22 days
    const undated = c({ postedAt: null, companyId: 3 });
    const picked = rankShortlist([fresh, old, undated], { ...opts, maxAgeDays: 14 });
    expect(picked).toContain(fresh.jobId);
    expect(picked).toContain(undated.jobId);
    expect(picked).not.toContain(old.jobId);
  });
});

describe("preferred-city (Chicago) boost", () => {
  const opts = { size: 13, preferredLocations: ["Chicago, IL", "Remote (US)"], now: NOW, minFitScore: 8, preferredCityBoost: 1 };
  it("lets a Chicago 7 clear an 8 minimum, while a 7 elsewhere doesn't", () => {
    const chi7 = c({ fitScore: 7, location: "Chicago, IL", companyId: 1 });
    const ny7 = c({ fitScore: 7, location: "New York, NY", companyId: 2 });
    expect(rankShortlist([chi7, ny7], opts)).toEqual([chi7.jobId]);
  });
  it("ranks a Chicago 8 level with an out-of-town 9, and first on the tie", () => {
    const chi8 = c({ fitScore: 8, tier: "A", location: "Chicago, IL", companyId: 1 });
    const ny9 = c({ fitScore: 9, tier: "A", location: "New York, NY", companyId: 2 });
    const ny8 = c({ fitScore: 8, tier: "A", location: "New York, NY", companyId: 3 });
    expect(rankShortlist([ny8, ny9, chi8], opts)).toEqual([chi8.jobId, ny9.jobId, ny8.jobId]);
  });
  it("remote still breaks ties between non-Chicago jobs", () => {
    const ny = c({ fitScore: 8, tier: "A", location: "New York, NY", companyId: 1 });
    const remote = c({ fitScore: 8, tier: "A", location: "Remote - US", remote: true, companyId: 2 });
    expect(rankShortlist([ny, remote], opts)[0]).toBe(remote.jobId);
  });
  it("boost 0 turns it off", () => {
    const chi7 = c({ fitScore: 7, location: "Chicago, IL", companyId: 1 });
    expect(rankShortlist([chi7], { ...opts, preferredCityBoost: 0 })).toEqual([]);
  });
});

describe("per-tier picks (Today's deck)", () => {
  const opts = { size: 10, preferredLocations: ["Chicago, IL"], now: NOW, perTier: { A: 5, B: 5 }, preferredCityBoost: 1 };
  it("takes up to 5 of each tier, Tier A first", () => {
    const as = Array.from({ length: 7 }, (_, i) => c({ fitScore: 8 + (i % 3 === 0 ? 1 : 0), tier: "A", companyId: 200 + i }));
    const bs = Array.from({ length: 7 }, (_, i) => c({ fitScore: 5 + (i % 3), tier: "B", companyId: 300 + i }));
    const picked = rankShortlist([...bs, ...as], opts);
    expect(picked).toHaveLength(10);
    expect(picked.slice(0, 5).every((id) => as.some((a) => a.jobId === id))).toBe(true);
    expect(picked.slice(5).every((id) => bs.some((b) => b.jobId === id))).toBe(true);
  });
  it("a boosted Chicago 7 stays a Tier B pick (the boost only reorders)", () => {
    const chi7 = c({ fitScore: 7, tier: "B", location: "Chicago, IL", companyId: 1 });
    const b6 = c({ fitScore: 7, tier: "B", location: "Austin, TX", companyId: 2 });
    const picked = rankShortlist([b6, chi7], { ...opts, perTier: { A: 5, B: 1 } });
    expect(picked).toEqual([chi7.jobId]);
  });
  it("shows fewer when there aren't enough", () => {
    expect(rankShortlist([c({ fitScore: 9, tier: "A", companyId: 9 })], opts)).toHaveLength(1);
  });
});
