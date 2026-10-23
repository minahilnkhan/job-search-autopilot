import { describe, expect, it } from "vitest";
import { runHardFilters, type FilterInput } from "../src/domain/hardFilters";
import { fields, NO_EMPLOYMENT_FLAGS } from "./helpers";

const base = (overrides: Partial<FilterInput> = {}): FilterInput => ({
  title: "Forward Deployed Engineer",
  location: "Chicago, IL",
  fields: fields(),
  company: { eVerify: "confirmed" },
  history: { alreadyApplied: false, companyAppsLast30Days: 0 },
  ...overrides,
});

const codes = (input: FilterInput) => {
  const r = runHardFilters(input);
  return {
    pass: r.pass,
    fails: r.reasons.filter((x) => x.severity === "fail").map((x) => x.code),
    warns: r.reasons.filter((x) => x.severity === "warn").map((x) => x.code),
  };
};

describe("runHardFilters", () => {
  it("a clean job passes with no reasons", () => {
    expect(codes(base())).toEqual({ pass: true, fails: [], warns: [] });
  });

  it("reports EVERY failing rule, not just the first", () => {
    const r = codes(
      base({
        title: "Senior Software Engineer",
        location: "London, UK",
        fields: fields({ yearsRequired: 6, requiresClearance: true }),
      })
    );
    expect(r.pass).toBe(false);
    expect(r.fails).toEqual(expect.arrayContaining(["experience_4plus", "title_senior", "location_non_us", "clearance"]));
  });

  describe("experience", () => {
    it.each([
      [3, true],
      [4, false],
    ])("%d years → pass=%s (cutoff is 4+)", (years, pass) => {
      expect(codes(base({ fields: fields({ yearsRequired: years }) })).pass).toBe(pass);
    });

    it("missing years is a warning, not a fail", () => {
      const r = codes(base({ fields: fields({ yearsRequired: null }) }));
      expect(r).toEqual({ pass: true, fails: [], warns: ["years_missing"] });
    });

    it.each(["Senior Engineer", "Sr. Software Engineer", "Staff Engineer", "Tech Lead", "Principal Engineer", "Head of Solutions"])(
      "fails senior title: %s",
      (title) => {
        expect(codes(base({ title })).fails).toContain("title_senior");
      }
    );

    it("III in the title is a warning", () => {
      expect(codes(base({ title: "Software Engineer III" })).warns).toContain("title_level_3");
    });

    it("pure sales titles fail; solutions/sales engineers don't", () => {
      expect(codes(base({ title: "Account Executive" })).fails).toContain("pure_sales");
      expect(codes(base({ title: "SDR" })).fails).toContain("pure_sales");
      expect(codes(base({ title: "Solutions Engineer" })).pass).toBe(true);
      expect(codes(base({ title: "Sales Engineer" })).pass).toBe(true);
    });
  });

  describe("location", () => {
    it.each(["San Francisco, CA", "New York, NY", "Remote - US", "Austin, Texas", "United States"])("US: %s", (location) => {
      expect(codes(base({ location })).pass).toBe(true);
    });

    it.each(["London, UK", "Toronto, Canada", "Bengaluru, IN", "Remote - EMEA", "Berlin"])("non-US fails: %s", (location) => {
      expect(codes(base({ location })).fails).toContain("location_non_us");
    });

    it("multi-location with a US option passes", () => {
      expect(codes(base({ location: "New York or London" })).pass).toBe(true);
    });

    it("remote with no country is a warning", () => {
      expect(codes(base({ location: "Remote", fields: fields({ remote: true }) })).warns).toContain("remote_no_country");
    });

    it("missing location is a warning", () => {
      expect(codes(base({ location: null })).warns).toContain("location_missing");
    });
  });

  describe("STEM OPT employment rules", () => {
    const withFlag = (flag: keyof typeof NO_EMPLOYMENT_FLAGS) =>
      codes(base({ fields: fields({ employment: { ...NO_EMPLOYMENT_FLAGS, [flag]: true } }) }));

    it.each([
      ["w1099", "employment_1099"],
      ["c2c", "employment_c2c"],
      ["freelance", "employment_freelance"],
      ["unpaid", "employment_unpaid"],
      ["commissionOnly", "employment_commission"],
    ] as const)("%s fails", (flag, code) => {
      expect(withFlag(flag).fails).toContain(code);
    });

    it.each([
      ["contract", "employment_contract"],
      ["contractToHire", "employment_c2h"],
      ["staffingAgency", "staffing_agency"],
      ["partTime", "part_time"],
    ] as const)("%s only warns", (flag, code) => {
      const r = withFlag(flag);
      expect(r.pass).toBe(true);
      expect(r.warns).toContain(code);
    });

    it("unknown E-Verify warns and links to the employer search", () => {
      const r = runHardFilters(base({ company: { eVerify: "unknown" } }));
      expect(r.pass).toBe(true);
      expect(r.reasons[0]?.message).toContain("e-verify.gov");
    });
  });

  it("clearance and citizenship fail", () => {
    expect(codes(base({ fields: fields({ requiresClearance: true }) })).fails).toContain("clearance");
    expect(codes(base({ fields: fields({ requiresCitizenship: true }) })).fails).toContain("citizenship");
  });

  it("'no sponsorship' warns but does not fail (Tier B cap comes in Phase 2)", () => {
    const r = codes(base({ fields: fields({ sponsorshipStated: "no" }) }));
    expect(r).toEqual({ pass: true, fails: [], warns: ["no_sponsorship"] });
  });

  describe("history", () => {
    it("already applied fails", () => {
      expect(codes(base({ history: { alreadyApplied: true, companyAppsLast30Days: 1 } })).fails).toEqual(["already_applied"]);
    });

    it.each([
      [1, true],
      [2, false],
    ])("%d apps at the company in 30 days → pass=%s", (n, pass) => {
      expect(codes(base({ history: { alreadyApplied: false, companyAppsLast30Days: n } })).pass).toBe(pass);
    });
  });

  it("attaches the JD snippet as evidence", () => {
    const r = runHardFilters(
      base({ fields: fields({ yearsRequired: 5, evidence: { yearsRequired: "…5+ years of experience…" } }) })
    );
    expect(r.reasons[0]?.evidence).toBe("…5+ years of experience…");
  });
});
