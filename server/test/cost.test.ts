import { describe, expect, it } from "vitest";
import { mentorPromptFor, sharedSystem } from "../src/llm/context";

const PROMPT = `# ACT AS
Mentor.

# TERMS
<candidate_inventory> facts </candidate_inventory>
<tracker_state> counts </tracker_state>
<networking_summary/>
## Time budget (until Nov 6)
30 h a week.
## Hard rules
1. Facts only.
## Tone
Be kind.
## Quality checks
- Ask first.

---
# MODULE: SCORING
Score it.
# MODULE: RESUME / TAILOR
Tailor it.
# MODULE: WEEKLY REVIEW (Sundays)
Review.`;

describe("per-call prompt costs", () => {
  it("per-job calls leave out her schedule, tone and quality-check sections; weekly ones keep them", () => {
    for (const m of ["scoring", "resume"] as const) {
      const t = mentorPromptFor(PROMPT, m);
      expect(t).toContain("Facts only.");
      expect(t).not.toContain("30 h a week");
      expect(t).not.toContain("Be kind.");
      expect(t).not.toContain("Ask first.");
    }
    expect(mentorPromptFor(PROMPT, "weekly")).toContain("30 h a week");
  });

  it("every Sonnet call shares one identical, cached first block (so only the first call in 5 minutes pays to write it)", () => {
    const ctx = { mentorPrompt: PROMPT, inventory: "INV" };
    const a = sharedSystem(ctx, "<task>tailor</task>");
    const b = sharedSystem(ctx, "<task>answer</task>");
    expect(a[0]).toEqual(b[0]);
    expect(a[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(a[1]!.text).not.toBe(b[1]!.text);
    expect(a[0]!.text).not.toContain("<tracker_state>");
    expect(a[0]!.text).not.toContain("<networking_summary");
    expect(a[0]!.text).not.toContain("(Not used");
  });
});
