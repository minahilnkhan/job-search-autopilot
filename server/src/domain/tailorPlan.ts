import type { BaseType, ResumeChange, ResumeContent } from "../../../shared/types";
import { resumeLines, setLine } from "./resumeFormat";

// What the tailoring model may change, and how it's applied. The model can
// only reword existing lines (by id) and reorder bullets within an entry; it
// can't add roles, projects or new claims. Everything it writes still goes
// through the Truth Check afterwards.

export type TailorPlan = {
  lineEdits: { id: string; after: string; reason: string }[];
  bulletOrder: { entry: string; order: number[] }[]; // entry = "section.entry", order = old bullet indices
  recruiterNote: string;
  answers: { question: string; answer: string }[];
  keywordsCovered: string[];
  keywordsMissing: string[];
  honestGaps: string[];
};

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

export function applyPlan(base: ResumeContent, plan: Pick<TailorPlan, "lineEdits" | "bulletOrder">) {
  let content: ResumeContent = structuredClone(base);
  const changes: ResumeChange[] = [];
  const notes: string[] = [];
  const baseLines = new Map(resumeLines(base).map((l) => [l.id, l]));
  const idMap = new Map<string, string>(); // base bullet id → id after reordering

  for (const { entry, order } of plan.bulletOrder) {
    const [si, ei] = entry.split(".").map(Number);
    const e = content.sections[si!]?.entries[ei!];
    const isPermutation = e && order.length === e.bullets.length && [...order].sort((a, b) => a - b).every((v, i) => v === i);
    if (!e || !isPermutation) {
      notes.push(`Ignored a bullet reorder for "${entry}" that didn't match the resume.`);
      continue;
    }
    if (order.every((v, i) => v === i)) continue;
    e.bullets = order.map((i) => e.bullets[i]!);
    order.forEach((oldIdx, newIdx) => idMap.set(`${si}.${ei}.${oldIdx}`, `${si}.${ei}.${newIdx}`));
    changes.push({
      id: `${entry}.order`,
      where: `${content.sections[si!]!.title} › ${e.org}`,
      before: "Original bullet order",
      after: `Bullets reordered: ${order.map((i) => i + 1).join(", ")}`,
      reason: "Most relevant bullets first for this job",
    });
  }

  for (const edit of plan.lineEdits) {
    const before = baseLines.get(edit.id);
    if (!before || before.kind === "header") {
      notes.push(`Ignored an edit to unknown line "${edit.id}".`);
      continue;
    }
    const after = edit.after.trim();
    if (!after || after === before.text) continue;
    const id = idMap.get(edit.id) ?? edit.id;
    content = setLine(content, id, after);
    changes.push({ id, where: before.where, before: before.text, after, reason: edit.reason });
  }
  return { content, changes, notes };
}
