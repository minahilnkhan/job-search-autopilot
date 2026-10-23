import { createDb, runMigrations } from "../src/db/client";
import { seed } from "../src/db/seed";
import type { EmploymentFlags, ExtractedFields } from "../../shared/types";
import type { PipelineDeps } from "../src/services/pipeline";
import type { ModelJudgment } from "../src/domain/scoring";
import type { ScoreInput, Scorer } from "../src/llm/scoreJob";

/** Pipeline deps that never touch the network: no boards, no scorer. */
export const OFFLINE_PIPELINE: PipelineDeps = {
  fetchBoard: async () => [],
  getScorer: () => ({ unavailable: "offline test" }),
};

export const GOOD_JUDGMENT: ModelJudgment = {
  requirements: [
    { requirement: "2+ years software engineering", met: "partial", evidence: "~1.5 years professional SWE" },
    { requirement: "LLM API experience", met: "yes", evidence: "Shipped production Claude API feature at Yabla" },
    { requirement: "Python", met: "yes", evidence: "Python/FastAPI projects" },
    { requirement: "TypeScript", met: "yes", evidence: "JavaScript/TypeScript" },
  ],
  roleSignal: 2,
  roleSignalReason: "Customer-facing deployment of LLM software.",
  stackMatch: 2,
  stackMatchReason: "Python, TypeScript, LLM APIs.",
  redFlags: [],
  whyFits: "Customer-facing LLM integration work matching her Yabla experience.",
  gaps: ["Slightly under 2 years"],
};

/** A fake scorer that records what it was asked and returns a fixed judgment. */
export function fakeScorer(judgment: ModelJudgment = GOOD_JUDGMENT, opts: { failFor?: string } = {}) {
  const calls: ScoreInput[] = [];
  const scorer: Scorer = async (input) => {
    calls.push(input);
    if (opts.failFor && input.title.includes(opts.failFor)) throw new Error("model overloaded");
    return {
      judgment,
      model: "claude-haiku-5-5",
      usage: { inputTokens: 1200, outputTokens: 400, cacheWriteTokens: 0, cacheReadTokens: 5000 },
    };
  };
  return { scorer, calls };
}

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
