import { buildApp } from "./app";
import { createDb, runMigrations } from "./db/client";
import { seed } from "./db/seed";
import { config } from "./config";
import { anthropicScorerFactory } from "./llm/factory";
import { fetchBoard } from "./sources/boards";
import { startScheduler } from "./scheduler";
import { markInterruptedRuns, type PipelineDeps } from "./services/pipeline";

const db = createDb();
// Migrate + seed on boot so a fresh clone works with just `npm run dev`.
// Both are idempotent.
runMigrations(db);
seed(db);
markInterruptedRuns(db); // a run can't still be going if the app just started

const pipeline: PipelineDeps = { fetchBoard, getScorer: anthropicScorerFactory };
let reschedule = () => {};
const app = buildApp(db, { logger: true, pipeline, onSettingsChanged: () => reschedule() });

// Bind to localhost only: this is a personal tool with no auth.
await app.listen({ port: config.port, host: "127.0.0.1" });

// The schedule only fires while this process is running (it's a local app).
// If the laptop was asleep at run time, the next start catches up.
const scheduler = startScheduler(db, pipeline, (msg) => app.log.info(msg));
reschedule = scheduler.reschedule;
