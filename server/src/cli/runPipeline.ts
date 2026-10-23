// One-off run from the terminal: `npm run pipeline`.
// Prefer the Run now button while the app is open, so two runs don't overlap.
import { createDb, runMigrations } from "../db/client";
import { seed } from "../db/seed";
import { anthropicScorerFactory } from "../llm/factory";
import { fetchBoard } from "../sources/boards";
import { getShortlist, runPipeline } from "../services/pipeline";

const db = createDb();
runMigrations(db);
seed(db);
const run = await runPipeline(db, { fetchBoard, getScorer: anthropicScorerFactory }, "manual");
console.log(`Run ${run.id}: ${run.status}`);
if (run.message) console.log(run.message);
console.log(run.stats);
for (const e of getShortlist(db)?.entries ?? []) {
  console.log(`${String(e.rank).padStart(2)}. [${e.job.tier}] ${e.job.fitScore}/10  ${e.job.companyName}: ${e.job.title}`);
}
