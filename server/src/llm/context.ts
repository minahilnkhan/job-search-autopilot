import fs from "node:fs";
import path from "node:path";
import { config } from "../config";

// The mentor prompt and candidate inventory are personal, so they live in the
// gitignored data/private/ folder, never in the repo.

export class MissingContextError extends Error {}

export type MentorContext = { mentorPrompt: string; inventory: string };

/**
 * job-mentor-prompt.md has slots like
 * <candidate_inventory>[inject candidate_inventory.md …]</candidate_inventory>.
 * Fill each slot with real content (or say it isn't provided), so the model never
 * sees an empty placeholder and thinks the data is missing. If the inventory
 * slot isn't there, append the inventory instead.
 */
export function fillMentorPrompt(prompt: string, slots: Record<string, string | null>): string {
  let out = prompt;
  let inventoryPlaced = false;
  for (const [tag, value] of Object.entries(slots)) {
    if (value === null) {
      // Not needed for this call: drop the tag instead of sending "(Not used)".
      out = out.replace(new RegExp(`<${tag}>[^<]*</${tag}>|<${tag}\\s*/>`, "g"), "");
      continue;
    }
    // Three slot shapes: <tag>[inject …]</tag> (v1), <tag> a description </tag>
    // (v2, the description is kept as a note), and an empty <tag/>.
    const slot = new RegExp(`<${tag}>([^<]*)</${tag}>|<${tag}\\s*/>`, "g");
    if (slot.test(out)) {
      slot.lastIndex = 0;
      out = out.replace(slot, (_m, inner: string | undefined) => {
        const desc = (inner ?? "").trim();
        const note = desc && !desc.startsWith("[") ? `(${desc})\n` : "";
        return `<${tag}>\n${note}${value}\n</${tag}>`;
      });
      if (tag === "candidate_inventory") inventoryPlaced = true;
    }
  }
  if (!inventoryPlaced && typeof slots.candidate_inventory === "string") {
    out += `\n\n<candidate_inventory>\n${slots.candidate_inventory}\n</candidate_inventory>`;
  }
  return out;
}

export type PromptModule = "scoring" | "resume" | "interview" | "portfolio" | "weekly" | "checkin";

const MODULE_HEADING = /^#\s+(MODULE|OUTPUT FORMAT):\s*(.+)$/;
const MODULE_MATCH: Record<PromptModule, RegExp> = {
  scoring: /SCORING/i,
  resume: /RESUME|TAILOR/i,
  interview: /INTERVIEW/i,
  portfolio: /PORTFOLIO/i,
  weekly: /WEEKLY/i,
  checkin: /CHECK-?IN/i,
};

/**
 * The mentor prompt is shared rules (ACT AS, REQUEST, TERMS) plus modules
 * ("# MODULE: SCORING", "# MODULE: RESUME / TAILOR", …). Each call gets the
 * shared rules and only the module it needs: a scoring call doesn't read the
 * portfolio rules. A prompt without modules is returned whole.
 */
function dropSections(text: string, heading: RegExp): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (/^#{1,2}\s/.test(line)) skipping = heading.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function mentorPromptFor(prompt: string, module: PromptModule): string {
  const lines = prompt.split("\n");
  const starts = lines.flatMap((l, i) => (MODULE_HEADING.test(l.trim()) ? [i] : []));
  if (starts.length === 0) return prompt;
  let shared = lines.slice(0, starts[0]).join("\n").replace(/\n-{3,}\s*$/, "").trimEnd();
  // Per-job calls (scoring, tailoring, answers, chat) don't plan her week or
  // coach her, so the time budget, tone and quality-check sections stay out.
  if (module === "scoring" || module === "resume") shared = dropSections(shared, /^##\s+(Time budget|Tone|Quality checks)\b/i);
  const picked = starts
    .map((start, k) => ({ title: MODULE_HEADING.exec(lines[start]!.trim())![2]!, text: lines.slice(start, starts[k + 1] ?? lines.length).join("\n").trim() }))
    .filter((m) => MODULE_MATCH[module].test(m.title))
    .map((m) => m.text);
  return [shared, ...picked].join("\n\n");
}

export function loadMentorContext(dir = config.privateDir): MentorContext {
  const read = (file: string) => {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) {
      throw new MissingContextError(
        `Missing data/private/${file}. Scoring needs it: copy it from your project docs into data/private/.`
      );
    }
    return fs.readFileSync(p, "utf8").trim();
  };
  return { mentorPrompt: read("job-mentor-prompt.md"), inventory: withConfirmedAdditions(read("candidate_inventory.md"), dir) };
}

/** Your answers to assumption questions, kept in their own file so the inventory you wrote stays yours. */
export const ADDITIONS_FILE = "confirmed_additions.md";

export function readConfirmedAdditions(dir = config.privateDir): string {
  const p = path.join(dir, ADDITIONS_FILE);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
}

export function withConfirmedAdditions(inventory: string, dir = config.privateDir): string {
  const extra = readConfirmedAdditions(dir);
  return extra ? `${inventory}\n\n## Confirmed additions (her answers to assumption questions; [HER ESTIMATE] = a number she gave from memory)\n${extra.replace(/^#.*\n?/, "").trim()}` : inventory;
}

/**
 * The system prompt for every Sonnet call (tailoring, answers, chat,
 * follow-up). The big first block is identical across them and marked for
 * caching, so after the first call within five minutes the rest read it at a
 * tenth of the price instead of each paying to write its own copy. Each
 * call's own instructions follow as a second block.
 */
export function sharedSystem(ctx: MentorContext, instructions: string) {
  const text = fillMentorPrompt(mentorPromptFor(ctx.mentorPrompt, "resume"), {
    candidate_inventory: ctx.inventory,
    current_resume: "(The resume and posting for this job are in the message.)",
    tracker_state: null,
    networking_summary: null,
  });
  return [
    { type: "text" as const, text, cache_control: { type: "ephemeral" as const } },
    { type: "text" as const, text: instructions, cache_control: { type: "ephemeral" as const } },
  ];
}
