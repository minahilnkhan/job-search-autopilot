import { buildApp } from "./app";
import { createDb, runMigrations } from "./db/client";
import { seed } from "./db/seed";
import { config } from "./config";
import { anthropicScorerFactory, anthropicTailorFactory } from "./llm/factory";
import { makeRenderer } from "./render/renderer";
import { loadTruthFacts } from "./services/truth";
import { importBasesIfMissing } from "./services/resumes";
import type { PrepDeps } from "./services/applications";
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
const prep: PrepDeps = { getTailor: anthropicTailorFactory, renderer: makeRenderer({ chromiumPath: config.chromiumPath }), facts: loadTruthFacts };
const app = buildApp(db, { logger: true, pipeline, prep, onSettingsChanged: () => reschedule() });

// Bind to localhost only: this is a personal tool with no auth.
await app.listen({ port: config.port, host: "127.0.0.1" });

// The schedule only fires while this process is running (it's a local app).
// If the laptop was asleep at run time, the next start catches up.
const scheduler = startScheduler(db, pipeline, (msg) => app.log.info(msg));

// First run: pick up data/private/resume_fde.md and resume_swe.md as base resumes.
importBasesIfMissing(db, prep).catch((err) => app.log.warn(`Base resume import skipped: ${(err as Error).message}`));
reschedule = scheduler.reschedule;
