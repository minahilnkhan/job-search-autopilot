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
