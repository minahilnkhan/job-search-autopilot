import type { TruthIssue, TruthReport } from "../../../shared/types";
import { extractNumbers, numberKey, type InventoryFacts } from "./inventory";

// The no-fabrication rule, in code. Pure: give it the lines and the facts,
// get back every problem with where it is and why. Any "fail" keeps the
// application out of the review queue until it's fixed or overridden.

export type CheckLine = { where: string; text: string; lineId?: string; checkNumbers?: boolean };

// From the mentor prompt's resume rules. Style, not truth, so these only warn.
const BANNED = ["spearheaded", "leveraged", "utilized", "passionate", "robust", "seamless", "cutting-edge", "dynamic", "results-driven", "synergy", "responsible for"];

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** "submit/poll apis" → /submit\/poll/, "background workers" → /worker/, "caching" → /cach/ */
function componentPattern(component: string): RegExp {
  const generic = new Set(["api", "apis", "background", "the", "system", "systems", "layer", "service", "services"]);
  const words = component.split(/\s+/).filter((w) => !generic.has(w));
  const word = words.sort((a, b) => b.length - a.length)[0] ?? component;
  const stem = word.replace(/(ing|s)$/i, "");
  return new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\/]/g, (c) => `\\${c}`)}`, "i");
}

function checkLine(line: CheckLine, facts: InventoryFacts): TruthIssue[] {
  const issues: TruthIssue[] = [];
  const base = { where: line.where, text: line.text, lineId: line.lineId };
  const lower = line.text.toLowerCase();

  // 1. DO NOT CLAIM: a listed number or phrase anywhere in the line. One issue
  // per line: when several entries match (60% is on three), show the one whose
  // wording overlaps the line most ("latency" → the latency entry).
  const nums = extractNumbers(line.text);
  const lineWords = new Set(lower.match(/[a-z]{4,}/g) ?? []);
  const hits = facts.doNotClaim
    .map((rule) => {
      const hitNumber = nums.find((n) => rule.numbers.includes(numberKey(n)));
      const hitPhrase = rule.phrases.find((p) => p && lower.includes(p));
      const overlap = (rule.claim.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => lineWords.has(w) || lineWords.has(w.replace(/[-]/g, ""))).length;
      return { rule, hit: hitNumber ? hitNumber.raw : hitPhrase, overlap: overlap + (hitPhrase ? 10 : 0) };
    })
    .filter((h) => h.hit)
    .sort((a, b) => b.overlap - a.overlap);
  if (hits.length) {
    const best = hits[0]!;
    const others = hits.length - 1;
    issues.push({
      ...base,
      kind: "do_not_claim",
      severity: "fail",
      message: `On your DO NOT CLAIM list ("${best.hit}"): ${best.rule.claim}${others ? ` (Also matches ${others} other ${others === 1 ? "entry" : "entries"}.)` : ""}`,
    });
  }

  // 2. Every number must appear in the inventory.
  if (line.checkNumbers !== false) {
    const flagged = new Set(nums.filter((n) => facts.doNotClaim.some((r) => r.numbers.includes(numberKey(n)))).map(numberKey));
    for (const n of nums) {
      const key = numberKey(n);
      if (flagged.has(key) || facts.allowedNumbers.has(key)) continue;
      issues.push({ ...base, kind: "unverified_number", severity: "fail", message: `"${n.raw}" isn't in your inventory. Use a number you can back up, or a concrete non-numeric result.` });
    }
  }

  // 3. Ownership verbs on work someone else designed.
  for (const rule of facts.ownership) {
    for (const verb of rule.verbs) {
      for (const component of rule.components) {
        const pattern = new RegExp(`\\b${verb}\\b[^.;]{0,60}?${componentPattern(component).source}`, "i");
        if (pattern.test(line.text)) {
          issues.push({
            ...base,
            kind: "ownership",
            severity: "fail",
            message: `"${verb}" claims ownership of ${component}, but ${rule.why}. Say "integrated", "extended" or "worked with".`,
          });
        }
      }
    }
  }

  // 4. Unfilled placeholders like [email] or [METRIC?].
  const placeholder = /\[[^\]]{1,40}\]/.exec(line.text);
  if (placeholder) issues.push({ ...base, kind: "placeholder", severity: "fail", message: `Fill in ${placeholder[0]}.` });

  // 5. Banned style words (warning only).
  for (const w of BANNED) {
    if (lower.includes(w)) issues.push({ ...base, kind: "banned_word", severity: "warn", message: `"${w}" is on your banned-words list. Use a plain verb.` });
  }
  return dedupe(issues);
}

function dedupe(issues: TruthIssue[]): TruthIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.kind}|${i.where}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function runTruthCheck(input: { lines: CheckLine[] }, facts: InventoryFacts, now = new Date()): TruthReport {
  const issues = input.lines.flatMap((l) => checkLine(l, facts));
  return { pass: !issues.some((i) => i.severity === "fail"), issues, checkedAt: now.getTime() };
}
