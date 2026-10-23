import { createDb, runMigrations } from "../src/db/client";
import { seed } from "../src/db/seed";
import type { EmploymentFlags, ExtractedFields } from "../../shared/types";

/** Fresh in-memory DB with migrations and the settings row (no companies). */
export function makeTestDb() {
  const db = createDb(":memory:");
  runMigrations(db);
  seed(db, "/nonexistent.csv");
  return db;
}

export const NO_EMPLOYMENT_FLAGS: EmploymentFlags = {
  w1099: false,
  c2c: false,
  freelance: false,
  unpaid: false,
  commissionOnly: false,
  contract: false,
  contractToHire: false,
  staffingAgency: false,
  partTime: false,
};

/** A clean, passing set of fields; override what a test cares about. */
export function fields(overrides: Partial<ExtractedFields> = {}): ExtractedFields {
  return {
    yearsRequired: 2,
    remote: false,
    remoteCountryStated: false,
    sponsorshipStated: "unstated",
    employment: { ...NO_EMPLOYMENT_FLAGS },
    requiresClearance: false,
    requiresCitizenship: false,
    eVerifyMentioned: false,
    evidence: {},
    ...overrides,
  };
}

export const FDE_JD = `About the role
We're hiring a Forward Deployed Engineer to work directly with customers, integrating our LLM platform into their workflows.

What you'll do
- Build integrations with customer APIs and data pipelines in Python and TypeScript.
- Turn ambiguous customer problems into shipped code.

What we're looking for
- 2+ years of professional software engineering experience.
- Experience with LLM APIs, prompt design, and structured outputs.

We are an equal opportunity employer. All qualified applicants will receive consideration for employment without regard to race, color, religion, sex, national origin, citizenship, disability, or protected veteran status.
This employer participates in E-Verify.`;
