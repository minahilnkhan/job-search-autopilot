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

describe("request settings (thinking counts toward max_tokens)", () => {
  const capture = () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchStub = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const req = body.output_config.format.schema.required as string[];
      const text = req.includes("lineEdits")
        ? JSON.stringify({ lineEdits: [], bulletOrder: [], answers: [], keywordsCovered: [], keywordsMissing: [], honestGaps: [] })
        : req.includes("items")
          ? JSON.stringify({ items: [{ id: "ap1", action: "ask", answer: "", ask: "What salary should I put?" }] })
          : req.includes("recruiterNote")
          ? JSON.stringify({ companyValue: "Ownership", valueSource: "you own problems end to end", story: "Morphemic Dictionary", standout: "Teachers checked it", recruiterNote: " A note. " })
          : JSON.stringify(GOOD_JUDGMENT);
      return new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    return { bodies, fetchStub };
  };
  const context = { mentorPrompt: "Rubric.", inventory: "Facts." };

  it("scoring turns thinking off and uses low effort, so long postings can't run out of room", async () => {
    const { makeAnthropicScorer } = await import("../src/llm/scoreJob");
    const { bodies, fetchStub } = capture();
    const score = makeAnthropicScorer({ apiKey: "test", model: "claude-haiku-5-5", context, fetch: fetchStub });
    await score({ companyName: "Acme", title: "FDE", location: null, postedAt: null, employmentType: null, description: "JD" });
    expect(bodies[0]).toMatchObject({ thinking: { type: "disabled" }, output_config: { effort: "low" }, max_tokens: 3000 });
  });

  it("tailoring keeps thinking but leaves plenty of room", async () => {
    const { makeAnthropicTailor } = await import("../src/llm/tailor");
    const { bodies, fetchStub } = capture();
    const tailor = makeAnthropicTailor({ apiKey: "test", model: "claude-sonnet-5-5", context, fetch: fetchStub });
    await tailor({ companyName: "Acme", title: "FDE", location: null, description: "JD", baseResume: "[0.0.0] x", questions: [] });
    expect(bodies[0]).toMatchObject({ max_tokens: 16000, output_config: { effort: "medium" } });
    expect(bodies[0]).not.toHaveProperty("thinking");
  });

  it("the note writer sends company notes, returns what the note is built around, and has room to think", async () => {
    const { makeAnthropicNoteWriter } = await import("../src/llm/note");
    const { bodies, fetchStub } = capture();
    const write = makeAnthropicNoteWriter({ apiKey: "test", model: "claude-sonnet-5-5", context, fetch: fetchStub });
    const r = await write({ companyName: "Acme", title: "FDE", description: "JD", resumeText: "# Me", companyNotes: "Values: ownership" });
    expect(r.note).toBe("A note.");
    expect(r.basis).toEqual({ companyValue: "Ownership", valueSource: "you own problems end to end", story: "Morphemic Dictionary", standout: "Teachers checked it" });
    expect(bodies[0]).toMatchObject({ output_config: { effort: "medium" }, max_tokens: 8000 });
    expect(JSON.stringify(bodies[0]!.messages)).toContain("<company_notes>\\nValues: ownership");
  });

  it("the answer writer sends each question with its options and returns answer/ask items", async () => {
    const { makeAnthropicAnswerWriter } = await import("../src/llm/answers");
    const { bodies, fetchStub } = capture();
    const write = makeAnthropicAnswerWriter({ apiKey: "test", model: "claude-sonnet-5-5", context, fetch: fetchStub });
    const r = await write({ companyName: "Acme", title: "FDE", description: "JD", resumeText: "# Me", recruiterNote: null, questions: [{ id: "ap1", label: "Salary?", kind: "select", options: ["<100k", "100k+"], required: true }] });
    expect(r.items).toEqual([{ id: "ap1", action: "ask", answer: "", ask: "What salary should I put?" }]);
    expect(JSON.stringify(bodies[0]!.messages)).toContain('kind=\\"select\\" required>Salary?\\nOptions: <100k | 100k+');
  });
});
