import { headedBrowser } from "./submit/browser";
import type { SubmitDeps } from "./services/submissions";
import { buildApp } from "./app";
import { createDb, runMigrations } from "./db/client";
import { seed } from "./db/seed";
import { config } from "./config";
import { anthropicNoteFactory, anthropicAnswerFactory, anthropicChatFactory, anthropicFollowUpFactory, anthropicScorerFactory, anthropicTailorFactory } from "./llm/factory";
import { makeRenderer } from "./render/renderer";
import { loadTruthFacts } from "./services/truth";
import { importBasesIfMissing } from "./services/resumes";
import type { PrepDeps } from "./services/applications";
import { fetchBoard } from "./sources/boards";
import { startScheduler } from "./scheduler";
import { markInterruptedRuns, rebuildTodaysShortlist, recheckBoardJobs, type PipelineDeps } from "./services/pipeline";

const db = createDb();
// Migrate + seed on boot so a fresh clone works with just `npm run dev`.
// Both are idempotent.
runMigrations(db);
seed(db);
markInterruptedRuns(db); // a run can't still be going if the app just started
// Apply the current filter rules to jobs already stored (free, no API calls),
// then re-rank today's picks so a job that now fails drops off right away.
{
  const r = recheckBoardJobs(db, new Date());
  if (r.nowFailing) rebuildTodaysShortlist(db);
  console.log(`Re-checked ${r.checked} job-board postings; ${r.nowFailing} now fail a hard filter.`);
}

const pipeline: PipelineDeps = { fetchBoard, getScorer: anthropicScorerFactory };
let reschedule = () => {};
const prep: PrepDeps = { getTailor: anthropicTailorFactory, getNoteWriter: anthropicNoteFactory, renderer: makeRenderer({ chromiumPath: config.chromiumPath }), facts: loadTruthFacts };
// Assisted submit opens a visible browser window on this machine.
const submit: SubmitDeps = { openPage: headedBrowser(config.chromiumPath), getAnswerWriter: anthropicAnswerFactory, getChat: anthropicChatFactory, getFollowUp: anthropicFollowUpFactory, facts: loadTruthFacts };
const app = buildApp(db, { logger: true, pipeline, prep, submit, onSettingsChanged: () => reschedule() });

// Bind to localhost only: this is a personal tool with no auth.
await app.listen({ port: config.port, host: "127.0.0.1" });

// The schedule only fires while this process is running (it's a local app).
// If the laptop was asleep at run time, the next start catches up.
const scheduler = startScheduler(db, pipeline, (msg) => app.log.info(msg));

// First run: pick up data/private/resume_fde.md and resume_swe.md as base resumes.
importBasesIfMissing(db, prep).catch((err) => app.log.warn(`Base resume import skipped: ${(err as Error).message}`));
reschedule = scheduler.reschedule;
