import type { BaseType, ResumeChange, ResumeContent } from "../../../shared/types";
import { resumeLines, setLine } from "./resumeFormat";

// What the tailoring model may change, and how it's applied. It may reword
// existing lines (by id), reorder bullets within an entry, write a short
// summary, add a sentence to an existing role when the inventory backs it,
// and drop weaker bullets to stay on one page. It can't add roles, employers
// or dates. Everything it writes still goes through the Truth Check.

export type TailorPlan = {
  summary: { headline: string; text: string } | null; // text under 50 words, headline under 10
  lineEdits: { id: string; after: string; reason: string }[];
  bulletOrder: { entry: string; order: number[] }[]; // entry = "section.entry", order = old bullet indices
  addBullets: { entry: string; position: number; text: string; reason: string }[]; // position in the final list, 0 = first
  removeBullets: { id: string; reason: string }[];
  answers: { question: string; answer: string }[];
  mustHaves: string[]; // the posting's must-have keywords
  keywordsCovered: string[];
  keywordsMissing: string[];
  honestGaps: string[];
  suggestions: string[]; // e.g. "Swap in the Teaching Assistant role to cover mentoring": for you to decide
};

const MAX_ADDED_BULLETS = 3;
const SUMMARY_MAX_WORDS = 50;
const HEADLINE_MAX_WORDS = 10;
const SUMMARY_SECTION = /^(summary|professional (overview|summary)|profile|overview)$/i;

const FDE_TITLES = /forward[- ]deployed|solutions?|deployment|customer|implementation|integrations?|applied ai|strategist|technical account/i;

/** Mentor prompt: FDE/Solutions base for customer-facing roles, SWE base for the rest. */
export function chooseBase(title: string): BaseType {
  return FDE_TITLES.test(title) ? "fde" : "swe";
}

/** The base resume as the model sees it: every editable line tagged with its id. */
export function resumeForPrompt(r: ResumeContent): string {
  return resumeLines(r)
    .map((l) => (l.kind === "header" ? `\n${l.where}: ${l.text}` : `[${l.id}] ${l.text}`))
    .join("\n")
    .trim();
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/** "Software Engineer building production LLM features" → section title, if it reads as a clean heading. */
export function summaryTitle(headline: string): string {
  const h = headline.trim();
  return h && words(h) < HEADLINE_MAX_WORDS && /^[A-Za-z0-9 ,&/+.'-]+$/.test(h) ? h : "Professional Overview";
}

type Plan = Pick<TailorPlan, "lineEdits" | "bulletOrder"> & Partial<Pick<TailorPlan, "summary" | "addBullets" | "removeBullets">>;

export function applyPlan(base: ResumeContent, plan: Plan) {
  const content: ResumeContent = structuredClone(base);
  const changes: ResumeChange[] = [];
  const notes: string[] = [];
  const baseLines = new Map(resumeLines(base).map((l) => [l.id, l]));

  // Work per entry on bullets that remember their original index, so edits and
  // removals (which use the base ids the model saw) land on the right bullet
  // whatever the order ends up being.
  type B = { baseIdx: number | null; text: string; changeIdx?: number };
  const lists = new Map<string, B[]>();
  content.sections.forEach((sec, si) => sec.entries.forEach((e, ei) => lists.set(`${si}.${ei}`, e.bullets.map((text, i) => ({ baseIdx: i, text })))));

  for (const { entry, order } of plan.bulletOrder) {
    const list = lists.get(entry);
    const isPermutation = list && order.length === list.length && [...order].sort((a, b) => a - b).every((v, i) => v === i);
    if (!list || !isPermutation) {
      notes.push(`Ignored a bullet reorder for "${entry}" that didn't match the resume.`);
      continue;
    }
    if (order.every((v, i) => v === i)) continue;
    lists.set(entry, order.map((i) => list[i]!));
    const [si, ei] = entry.split(".").map(Number);
    changes.push({
      id: `${entry}.order`,
      where: `${content.sections[si!]!.title} › ${content.sections[si!]!.entries[ei!]!.org}`,
      before: "Original bullet order",
      after: `Bullets reordered: ${order.map((i) => i + 1).join(", ")}`,
      reason: "Most relevant bullets first for this job",
    });
  }

  const pendingLineEdits: { id: string; after: string; before: string; where: string; reason: string }[] = [];
  for (const edit of plan.lineEdits) {
    const before = baseLines.get(edit.id);
    if (!before || before.kind === "header") {
      notes.push(`Ignored an edit to unknown line "${edit.id}".`);
      continue;
    }
    const after = edit.after.trim();
    if (!after || after === before.text) continue;
    const m = /^(\d+\.\d+)\.(\d+)$/.exec(edit.id);
    if (m) {
      const b = lists.get(m[1]!)?.find((x) => x.baseIdx === Number(m[2]));
      if (!b) continue;
      b.text = after;
      changes.push({ id: "", where: before.where, before: before.text, after, reason: edit.reason });
      b.changeIdx = changes.length - 1;
    } else {
      pendingLineEdits.push({ id: edit.id, after, before: before.text, where: before.where, reason: edit.reason });
    }
  }

  for (const r of plan.removeBullets ?? []) {
    const m = /^(\d+\.\d+)\.(\d+)$/.exec(r.id);
    const list = m ? lists.get(m[1]!) : undefined;
    const i = list?.findIndex((x) => x.baseIdx === Number(m![2])) ?? -1;
    if (!list || i === -1 || list.length <= 1) {
      notes.push(`Ignored removing "${r.id}".`);
      continue;
    }
    const [gone] = list.splice(i, 1);
    if (gone!.changeIdx !== undefined) changes.splice(gone!.changeIdx, 1, { id: `${r.id}.removed`, where: changes[gone!.changeIdx]!.where, before: baseLines.get(r.id)!.text, after: "(removed)", reason: r.reason });
    else changes.push({ id: `${r.id}.removed`, where: baseLines.get(r.id)!.where, before: gone!.text, after: "(removed)", reason: r.reason });
  }

  let added = 0;
  for (const a of plan.addBullets ?? []) {
    const list = lists.get(a.entry);
    const text = a.text.trim();
    if (!list || !text || added >= MAX_ADDED_BULLETS) {
      notes.push(`Ignored an added bullet for "${a.entry}".`);
      continue;
    }
    const [si, ei] = a.entry.split(".").map(Number);
    const at = Math.max(0, Math.min(list.length, Math.trunc(a.position)));
    changes.push({ id: "", where: `${content.sections[si!]!.title} › ${content.sections[si!]!.entries[ei!]!.org} › new bullet`, before: "", after: text, reason: a.reason });
    list.splice(at, 0, { baseIdx: null, text, changeIdx: changes.length - 1 });
    added++;
  }

  // Write the lists back and give each changed bullet its final id.
  for (const [key, list] of lists) {
    const [si, ei] = key.split(".").map(Number);
    content.sections[si!]!.entries[ei!]!.bullets = list.map((b) => b.text);
    list.forEach((b, i) => {
      if (b.changeIdx !== undefined && changes[b.changeIdx]!.id === "") changes[b.changeIdx]!.id = `${key}.${i}`;
    });
  }
  let out = content;
  for (const e of pendingLineEdits) {
    out = setLine(out, e.id, e.after);
    changes.push({ id: e.id, where: e.where, before: e.before, after: e.after, reason: e.reason });
  }

  // Summary goes first, under the headline when it reads as a clean heading.
  const summaryText = plan.summary?.text.trim();
  if (summaryText) {
    if (words(summaryText) > SUMMARY_MAX_WORDS) notes.push(`The summary runs ${words(summaryText)} words; trim it under ${SUMMARY_MAX_WORDS}.`);
    const title = summaryTitle(plan.summary!.headline);
    const existing = out.sections.findIndex((s) => SUMMARY_SECTION.test(s.title));
    if (existing !== -1) {
      const before = out.sections[existing]!.lines.join(" ");
      out.sections[existing] = { ...out.sections[existing]!, title, lines: [summaryText] };
      changes.unshift({ id: `${existing}.L0`, where: title, before, after: summaryText, reason: "Summary for this job" });
    } else {
      out.sections.unshift({ title, entries: [], lines: [summaryText] });
      // Every other section moved down one.
      for (const c of changes) c.id = c.id.replace(/^(\d+)\./, (_m, n) => `${Number(n) + 1}.`);
      changes.unshift({ id: "0.L0", where: title, before: "", after: summaryText, reason: "Summary for this job" });
    }
  }
  return { content: out, changes, notes };
}
