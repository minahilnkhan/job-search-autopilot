import { describe, expect, it } from "vitest";
import { extractFields, stripBoilerplate } from "../src/domain/extract";
import { FDE_JD } from "./helpers";

const ex = (description: string, title = "Software Engineer", location: string | null = "Chicago, IL") =>
  extractFields({ title, location, description });

describe("years of experience", () => {
  it.each([
    ["2+ years of professional software engineering experience", 2],
    ["3-5 years' experience building web apps", 3],
    ["Minimum of 4 years in software engineering", 4],
    ["5 yrs exp with Java", 5],
    ["0-2 years of experience", 0],
  ])("%s → %d", (text, years) => {
    expect(ex(text).yearsRequired).toBe(years);
  });

  it("takes the highest requirement in the JD", () => {
    expect(ex("2+ years of Python experience. 5+ years of software engineering experience.").yearsRequired).toBe(5);
  });

  it("ignores company-age numbers and returns null when nothing is stated", () => {
    expect(ex("We have been building software for 25 years of engineering excellence.").yearsRequired).toBeNull();
    expect(ex("Strong Python skills.").yearsRequired).toBeNull();
  });

  it("does not read 'years' as an export-control (EAR) mention", () => {
    // Regression: a case-insensitive /EAR/ matched inside "years".
    const f = ex("3 years of experience required.");
    expect(f.requiresClearance).toBe(false);
    expect(f.requiresCitizenship).toBe(false);
  });
});

describe("citizenship and clearance", () => {
  it("EEO boilerplate mentioning citizenship does NOT trigger the citizenship fail", () => {
    const f = ex(FDE_JD);
    expect(f.requiresCitizenship).toBe(false);
  });

  it("a real requirement still triggers even when EEO boilerplate is present", () => {
    const f = ex(`Must be a U.S. citizen.\n${FDE_JD}`);
    expect(f.requiresCitizenship).toBe(true);
    expect(f.evidence.requiresCitizenship).toContain("U.S. citizen");
  });

  it.each([
    "US citizenship required for this role.",
    "This position requires U.S. citizenship.",
    "Applicants must be U.S. persons as defined by ITAR.",
    "This role is subject to ITAR.",
    "This role involves export-controlled technology; candidates must be U.S. persons.",
    "Applicants must be U.S. citizens or green card holders.",
    "Open to US citizens or permanent residents only.",
    "Candidates must be a US Citizen/Green Card holder.",
    "Green card holders or U.S. citizens are eligible for this position.",
    "This position requires U.S. citizenship or permanent residency.",
    "Must hold a green card.",
    "We are only considering U.S. citizens at this time.",
    "Requirements: US citizen or Lawful Permanent Resident (LPR).",
    "Due to federal contract requirements, United States citizenship is required.",
  ])("flags citizenship: %s", (text) => {
    expect(ex(text).requiresCitizenship).toBe(true);
  });

  it.each(["Active Secret clearance required.", "Must be able to obtain a security clearance.", "TS/SCI preferred."])(
    "flags clearance: %s",
    (text) => {
      expect(ex(text).requiresClearance).toBe(true);
    }
  );

  it("doesn't split sentences on 'U.S.'", () => {
    expect(stripBoilerplate("Must be a U.S. citizen. Ship fast.")).toContain("Must be a U.S. citizen.");
  });

  it("catches a real requirement written in the same sentence as EEO text", () => {
    const f = ex("We are an equal opportunity employer, and applicants must be U.S. citizens or green card holders due to contract terms.");
    expect(f.requiresCitizenship).toBe(true);
  });

  it.each([
    "We consider all applicants without regard to race, religion, or U.S. citizenship status.",
    "Employees are eligible for green card sponsorship after one year.",
    "We sponsor visas and green cards for the right candidates.",
    "Benefits: 401k, health insurance, and immigration support for permanent residency.",
  ])("doesn't flag: %s", (text) => {
    expect(ex(text).requiresCitizenship).toBe(false);
  });

  it("strips EEO sentences but keeps the rest", () => {
    const out = stripBoilerplate("Build things. We consider applicants without regard to citizenship. Ship fast.");
    expect(out).toContain("Build things.");
    expect(out).toContain("Ship fast.");
    expect(out).not.toContain("citizenship");
  });
});

describe("sponsorship", () => {
  it.each([
    "We are unable to sponsor visas for this role.",
    "We do not offer visa sponsorship.",
    "Candidates must be authorized to work in the US without sponsorship now or in the future.",
    "Visa sponsorship is not available.",
    "No sponsorship.",
  ])("no: %s", (text) => {
    expect(ex(text).sponsorshipStated).toBe("no");
  });

  it.each(["Visa sponsorship is available.", "We sponsor H-1B visas.", "We offer visa sponsorship for this role."])(
    "yes: %s",
    (text) => {
      expect(ex(text).sponsorshipStated).toBe("yes");
    }
  );

  it("unstated when the JD says nothing", () => {
    expect(ex(FDE_JD).sponsorshipStated).toBe("unstated");
  });
});

describe("employment type", () => {
  it("separates 1099 / C2C (fails) from contract-to-hire (warn)", () => {
    expect(ex("This is a 1099 position.").employment.w1099).toBe(true);
    expect(ex("C2C only.").employment.c2c).toBe(true);
    const c2h = ex("This is a contract-to-hire role.").employment;
    expect(c2h.contractToHire).toBe(true);
    expect(c2h.c2c).toBe(false);
    expect(c2h.w1099).toBe(false);
  });

  it("detects staffing agencies, part-time, unpaid, commission-only", () => {
    expect(ex("Our client, a fintech startup, is seeking an engineer.").employment.staffingAgency).toBe(true);
    expect(ex("Part-time, 15 hours per week.").employment.partTime).toBe(true);
    expect(ex("This is an unpaid internship.").employment.unpaid).toBe(true);
    expect(ex("Commission-only compensation.").employment.commissionOnly).toBe(true);
  });

  it("a clean full-time JD has no employment flags", () => {
    expect(Object.values(ex(FDE_JD).employment).some(Boolean)).toBe(false);
  });
});

describe("remote and E-Verify", () => {
  it("detects remote-US from the location string", () => {
    const f = ex("Build things.", "Software Engineer", "Remote - United States");
    expect(f.remote).toBe(true);
    expect(f.remoteCountryStated).toBe(true);
  });

  it("remote with no country", () => {
    const f = ex("Build things.", "Software Engineer", "Remote");
    expect(f.remote).toBe(true);
    expect(f.remoteCountryStated).toBe(false);
  });

  it("'not remote' is not remote", () => {
    expect(ex("This role is not remote.").remote).toBe(false);
  });

  it("notices an E-Verify mention even though it sits in the boilerplate", () => {
    expect(ex(FDE_JD).eVerifyMentioned).toBe(true);
  });
});
