import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { parseInventory, type InventoryFacts } from "../domain/inventory";

// Loads the Truth Check rules from data/private/candidate_inventory.md (plus
// optional extra patterns), and writes the derived rules to
// data/private/do_not_claim.json so you can see exactly what's enforced.
// Re-read whenever either file changes; no restart needed.

export class MissingInventoryError extends Error {}

let cache: { key: string; facts: InventoryFacts } | null = null;

export function loadTruthFacts(dir = config.privateDir): InventoryFacts {
  const inventoryPath = path.join(dir, "candidate_inventory.md");
  const extraPath = path.join(dir, "do_not_claim.extra.json");
  if (!fs.existsSync(inventoryPath)) {
    throw new MissingInventoryError("Missing data/private/candidate_inventory.md. The Truth Check can't run without it.");
  }
  const mtime = (p: string) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0);
  const key = `${dir}:${mtime(inventoryPath)}:${mtime(extraPath)}`;
  if (cache?.key === key) return cache.facts;

  const extra = fs.existsSync(extraPath) ? JSON.parse(fs.readFileSync(extraPath, "utf8")) : undefined;
  const facts = parseInventory(fs.readFileSync(inventoryPath, "utf8"), extra);
  try {
    fs.writeFileSync(
      path.join(dir, "do_not_claim.json"),
      JSON.stringify(
        {
          note: "Generated from candidate_inventory.md (+ do_not_claim.extra.json). Edit those, not this file.",
          rules: facts.doNotClaim,
          ownership: facts.ownership,
          allowedNumbers: [...facts.allowedNumbers],
        },
        null,
        2
      )
    );
  } catch {
    // read-only folder: the check still works, you just don't get the file
  }
  cache = { key, facts };
  return facts;
}
