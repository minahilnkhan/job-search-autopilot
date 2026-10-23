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
export function fillMentorPrompt(prompt: string, slots: Record<string, string>): string {
  let out = prompt;
  let inventoryPlaced = false;
  for (const [tag, value] of Object.entries(slots)) {
    const slot = new RegExp(`<${tag}>\\s*\\[[^\\]]*\\]\\s*</${tag}>`, "g");
    if (slot.test(out)) {
      out = out.replace(slot, () => `<${tag}>\n${value}\n</${tag}>`);
      if (tag === "candidate_inventory") inventoryPlaced = true;
    }
  }
  if (!inventoryPlaced && slots.candidate_inventory) {
    out += `\n\n<candidate_inventory>\n${slots.candidate_inventory}\n</candidate_inventory>`;
  }
  return out;
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
  return { mentorPrompt: read("job-mentor-prompt.md"), inventory: read("candidate_inventory.md") };
}
