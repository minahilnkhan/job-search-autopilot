// Turns candidate_inventory.md into the structured facts the Truth Check
// enforces. The inventory stays the single source of truth: edit it, and the
// rules change on the next check.

export type NumberKind = "%" | "x" | "s" | "ms" | "";
export type CanonicalNumber = { value: number; kind: NumberKind; raw: string };

// A number, optionally with K/M, a unit (x, s, ms), "+" and "%".
// Not part of a word or code: "3D", "H-1B", "I-983", "Claude-4" don't count.
const NUMBER = /(?<![A-Za-z0-9\-/.])([$~]?)(\d[\d,]*(?:\.\d+)?)\s?(k|m|x|ms|s)?(\+)?(%)?(?![A-Za-z0-9])/gi;

export function extractNumbers(text: string): CanonicalNumber[] {
  const out: CanonicalNumber[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const digits = m[2]!.replace(/,/g, "");
    let value = Number(digits);
    if (!Number.isFinite(value)) continue;
    const unit = (m[3] ?? "").toLowerCase();
    let kind: NumberKind = m[5] ? "%" : "";
    if (unit === "k") value *= 1_000;
    else if (unit === "m") value *= 1_000_000;
    else if (unit === "x" || unit === "s" || unit === "ms") kind = unit;
    out.push({ value, kind, raw: m[0].trim() });
  }
  return out;
}

export const numberKey = (n: CanonicalNumber) => `${n.value}${n.kind}`;

export type DoNotClaimRule = {
  id: string;
  claim: string; // the inventory's own wording
  numbers: string[]; // canonical keys; any one of these in a line is a match
  phrases: string[]; // lowercase substrings that match on their own
};

export type OwnershipRule = {
  /** Things someone else designed, e.g. "submit/poll", "workers", "caching". */
  components: string[];
  /** Words that claim authorship of them. */
  verbs: string[];
  why: string;
};

export type InventoryFacts = {
  /** Every number stated as true (outside DO NOT CLAIM). */
  allowedNumbers: Set<string>;
  doNotClaim: DoNotClaimRule[];
  ownership: OwnershipRule[];
};

const OWNERSHIP_VERBS = ["designed", "architected", "built", "created", "owned", "led", "invented", "engineered", "authored"];

/** Splits the markdown at the "DO NOT CLAIM" heading. */
export function splitInventory(md: string): { facts: string; doNotClaim: string } {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /do not claim/i.test(l) && !/^\s*[-*]/.test(l));
  if (start === -1) return { facts: md, doNotClaim: "" };
  // The section runs to the next ALL-CAPS or markdown heading, or the end.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (/^#{1,6}\s/.test(l) || (/^[A-Z][A-Z\s'&/-]{6,}$/.test(l) && !/do not claim/i.test(l))) {
      end = i;
      break;
    }
  }
  return {
    facts: [...lines.slice(0, start), ...lines.slice(end)].join("\n"),
    doNotClaim: lines.slice(start + 1, end).join("\n"),
  };
}

export function parseDoNotClaim(section: string): DoNotClaimRule[] {
  return section
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*•]\s+/.test(l))
    .map((l, i) => {
      const claim = l.replace(/^[-*•]\s+/, "");
      // Only the first sentence states the claim; the rest explains it
      // ("Made up. Latency did improve…"), and its numbers aren't forbidden.
      const head = claim.split(/(?<=[a-z0-9%)"”])\.\s/)[0] ?? claim;
      const quoted = [...head.matchAll(/["“]([^"”]{2,60})["”]/g)].map((m) => m[1]!.replace(/[,.;:]+$/, "").toLowerCase());
      const numbers = extractNumbers(head).map(numberKey);
      // A claim with no number and no quoted phrase ("A formal eval harness")
      // falls back to its own wording; add sharper patterns in do_not_claim.extra.json.
      const phrases = quoted.length || numbers.length ? quoted : [head.replace(/^(a|an|the|that you)\s+/i, "").replace(/[.]+$/, "").toLowerCase()];
      return { id: `dnc-${i + 1}`, claim, numbers, phrases };
    });
}

/**
 * "X, Y, and Z were designed by a senior engineer." → components X, Y, Z.
 * Lets the check flag "designed the caching layer" without a hand-kept list.
 */
export function parseOwnership(facts: string): OwnershipRule[] {
  const rules: OwnershipRule[] = [];
  for (const m of facts.matchAll(/([^.\n]+?)\s+(?:were|was)\s+(?:designed|built|architected)\s+by\s+([^.\n]+)/gi)) {
    const components = m[1]!
      .replace(/^[-*•]\s+/, "")
      .split(/,\s*|\s+and\s+/i)
      .map((c) => c.replace(/^(the|and)\s+/i, "").trim().toLowerCase())
      .filter((c) => c.length > 2);
    if (components.length) {
      rules.push({ components, verbs: OWNERSHIP_VERBS, why: `${m[1]!.replace(/^[-*•]\s+/, "").trim()} ${m[0].includes("were") ? "were" : "was"} designed by ${m[2]!.trim()}` });
    }
  }
  return rules;
}

export function parseInventory(md: string, extra?: { phrases?: { pattern: string; claim: string }[] }): InventoryFacts {
  const { facts, doNotClaim } = splitInventory(md);
  const rules = parseDoNotClaim(doNotClaim);
  for (const [i, p] of (extra?.phrases ?? []).entries()) {
    rules.push({ id: `extra-${i + 1}`, claim: p.claim, numbers: [], phrases: [p.pattern.toLowerCase()] });
  }
  return {
    allowedNumbers: new Set(extractNumbers(facts).map(numberKey)),
    doNotClaim: rules,
    ownership: parseOwnership(facts),
  };
}
