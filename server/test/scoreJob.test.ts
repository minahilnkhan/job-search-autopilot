import { describe, expect, it } from "vitest";
import { buildUserMessage, JUDGMENT_JSON_SCHEMA, parseJudgment, ScoreError } from "../src/llm/scoreJob";
import { costUsd } from "../src/llm/pricing";
import { GOOD_JUDGMENT } from "./helpers";

const msg = (text: string, stop_reason: "end_turn" | "max_tokens" | "refusal" = "end_turn") =>
  ({ content: [{ type: "text", text, citations: null }], stop_reason }) as Parameters<typeof parseJudgment>[0];

describe("parseJudgment", () => {
  it("accepts a valid result and normalizes enum case", () => {
    const raw = { ...GOOD_JUDGMENT, requirements: [{ requirement: "Python", met: "YES", evidence: "FastAPI" }] };
    expect(parseJudgment(msg(JSON.stringify(raw))).requirements[0]!.met).toBe("yes");
  });

  it("rejects refusals and cut-off output instead of trusting them", () => {
    expect(() => parseJudgment(msg("{}", "max_tokens"))).toThrow(ScoreError);
    expect(() => parseJudgment(msg("{}", "refusal"))).toThrow(/refusal/);
  });

  it("rejects non-JSON and schema mismatches", () => {
    expect(() => parseJudgment(msg("not json"))).toThrow(/isn't JSON/);
    expect(() => parseJudgment(msg(JSON.stringify({ roleSignal: 1 })))).toThrow(/schema/);
  });
});

describe("prompt", () => {
  it("wraps the posting as data and truncates very long descriptions", () => {
    const m = buildUserMessage({ companyName: "Acme", title: "FDE", location: null, postedAt: null, employmentType: null, description: "x".repeat(20_000) });
    expect(m.startsWith("<job_posting>")).toBe(true);
    expect(m.endsWith("</job_posting>")).toBe(true);
    expect(m).toContain("Location: not stated");
    expect(m).toContain("[truncated]");
    expect(m.length).toBeLessThan(15_300);
  });

  it("schema follows the structured-output rules: every object closed, no min/max", () => {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (o.type === "object") expect(o.additionalProperties).toBe(false);
      expect(o).not.toHaveProperty("minimum");
      expect(o).not.toHaveProperty("maximum");
      Object.values(o).forEach(walk);
    };
    walk(JUDGMENT_JSON_SCHEMA);
  });
});

describe("pricing", () => {
  it("prices Haiku 5.5 and returns null for unknown models", () => {
    expect(costUsd("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 })).toBeCloseTo(0.1);
    expect(costUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0 })).toBeCloseTo(10);
    expect(costUsd("some-future-model", { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0 })).toBeNull();
  });
});

describe("mentor prompt slots", () => {
  const prompt = [
    "# TERMS",
    "<candidate_inventory>[inject candidate_inventory.md — verified facts and the DO NOT CLAIM list]</candidate_inventory>",
    "<current_resume>[inject current resume — structure/phrasing reference only]</current_resume>",
    "<tracker_state>[injected by app: applications today]</tracker_state>",
  ].join("\n");

  it("fills the inventory slot and marks the others as not used", async () => {
    const { scoringSystemPrompt } = await import("../src/llm/scoreJob");
    const out = scoringSystemPrompt({ mentorPrompt: prompt, inventory: "Yabla — Software Engineer" });
    expect(out).toContain("<candidate_inventory>\nYabla — Software Engineer\n</candidate_inventory>");
    expect(out).toContain("<current_resume>\n(Not used for job scoring.)\n</current_resume>");
    expect(out).not.toContain("[inject");
    expect(out.match(/<candidate_inventory>/g)).toHaveLength(1);
  });

  it("appends the inventory when the prompt has no slot for it", async () => {
    const { fillMentorPrompt } = await import("../src/llm/context");
    expect(fillMentorPrompt("Be helpful.", { candidate_inventory: "facts" })).toBe("Be helpful.\n\n<candidate_inventory>\nfacts\n</candidate_inventory>");
  });
});
