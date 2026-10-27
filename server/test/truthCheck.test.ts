import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractNumbers, numberKey, parseInventory } from "../src/domain/inventory";
import { runTruthCheck } from "../src/domain/truthCheck";
import { canTransition } from "../src/domain/applicationStatus";

const md = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "inventory.md"), "utf8");
const facts = parseInventory(md);
const check = (text: string) => runTruthCheck({ lines: [{ where: "Resume › Experience › Acme › bullet 1", text }] }, facts);
const kinds = (text: string) => check(text).issues.map((i) => i.kind);

describe("Phase 3 acceptance: a planted DO NOT CLAIM line is blocked with the reason shown", () => {
  it("blocks 'cut latency 60%'", () => {
    const r = check("Cut latency 60% by rewriting the prompt pipeline");
    expect(r.pass).toBe(false);
    const dnc = r.issues.find((i) => i.kind === "do_not_claim")!;
    expect(dnc.message).toContain("DO NOT CLAIM");
    expect(dnc.message).toContain("60% search-latency cut");
    expect(dnc.where).toBe("Resume › Experience › Acme › bullet 1");
    expect(dnc.text).toBe("Cut latency 60% by rewriting the prompt pipeline");
  });
});

describe("numbers", () => {
  it("normalizes K, commas, ~, + and units", () => {
    expect(extractNumbers("~50K visits, 50,000 hits, 5+ formats, 94%, 1.2s, 10x").map(numberKey)).toEqual([
      "50000", "50000", "5", "94%", "1.2s", "10x",
    ]);
  });

  it("ignores digits inside words and codes", () => {
    expect(extractNumbers("3D rasterizer, H-1B, I-983, chem120, Claude-4")).toEqual([]);
  });

  it("allows numbers stated in the inventory, in any equivalent form", () => {
    expect(check("Taught about 150 students per session with a 94% satisfaction score").pass).toBe(true);
    expect(check("Supported 5+ input formats on a site with 50,000 daily visits").pass).toBe(true);
    expect(check("BA Computer Science, May 2025, GPA above 3.7").pass).toBe(true);
  });

  it("fails a number that isn't in the inventory", () => {
    const r = check("Reduced token usage by 35%");
    expect(r.pass).toBe(false);
    expect(r.issues[0]).toMatchObject({ kind: "unverified_number", message: expect.stringContaining('"35%"') });
  });

  it("numbers that only appear in the explanation of a DO NOT CLAIM item aren't forbidden by it", () => {
    // "No measured percent" sits after the first sentence; only the claim's own numbers are banned.
    expect(facts.doNotClaim.find((r) => r.claim.startsWith("60%"))!.numbers).toEqual(["60%", "3s", "1.2s"]);
  });
});

describe("DO NOT CLAIM", () => {
  it.each([
    ["Handled 15K+ daily AI requests", "15K+"],
    ["Cut response time from 3s to 1.2s", "3s"],
    ["Indexed 100K+ dictionary entries", "100K+"],
    ["Fixed 40+ production issues", "40+"],
    ["Built debugging frameworks for campers", "debugging frameworks"],
    ["Ran 250 students per session", "250"],
  ])("blocks %s", (text, hit) => {
    const dnc = check(text).issues.find((i) => i.kind === "do_not_claim");
    expect(dnc?.message).toContain(hit);
  });

  it("falls back to the claim's own words when it has no number or quote", () => {
    expect(kinds("Created a formal eval harness for prompts")).toContain("do_not_claim");
  });

  it("doesn't double-report a DO NOT CLAIM number as merely unverified", () => {
    expect(kinds("Cut latency 60%")).toEqual(["do_not_claim"]);
  });
});

describe("ownership", () => {
  it("reads who designed what from the inventory", () => {
    expect(facts.ownership[0]!.components).toEqual(["submit/poll apis", "background workers", "caching"]);
  });

  it.each(["Designed the submit/poll API for lookups", "Architected background workers and caching", "Built the caching layer"])(
    "flags %s",
    (text) => {
      const issue = check(text).issues.find((i) => i.kind === "ownership");
      expect(issue?.message).toMatch(/designed by a senior engineer/);
    }
  );

  it("allows integrating someone else's design, and owning your own work", () => {
    expect(check("Integrated submit/poll APIs and caching into the Word Splitter feature").pass).toBe(true);
    expect(check("Built the Claude pipeline with structured output and validation").pass).toBe(true);
  });
});

describe("other checks", () => {
  it("flags placeholders", () => {
    expect(check("Chicago, IL | [email]").issues[0]).toMatchObject({ kind: "placeholder", message: "Fill in [email]." });
  });

  it("banned style words only warn", () => {
    const r = check("Leveraged Claude to build the Word Splitter");
    expect(r.pass).toBe(true);
    expect(r.issues[0]).toMatchObject({ kind: "banned_word", severity: "warn" });
  });
});

describe("status transitions", () => {
  it.each([
    ["draft", "ready_for_review", true],
    ["ready_for_review", "approved", true],
    ["approved", "submitted", true],
    ["submitted", "screen", true],
    ["draft", "approved", false],
    ["draft", "submitted", false],
    ["ready_for_review", "submitted", false],
    ["rejected", "interview", false],
  ] as const)("%s → %s: %s", (from, to, ok) => {
    expect(canTransition(from, to)).toBe(ok);
  });
});

describe("one DO NOT CLAIM issue per line", () => {
  it("picks the entry whose wording matches the line when a number is on several", () => {
    const md2 = md.replace("- A formal eval harness.", "- A formal eval harness.\n- Tenzer: 15% less grading, 60%, 4.5/5.");
    const f2 = parseInventory(md2);
    const r = runTruthCheck({ lines: [{ where: "x", text: "Cut search latency 60%" }] }, f2);
    const dnc = r.issues.filter((i) => i.kind === "do_not_claim");
    expect(dnc).toHaveLength(1);
    expect(dnc[0]!.message).toContain("60% search-latency cut");
    expect(dnc[0]!.message).toContain("Also matches 1 other entry");
  });
});
