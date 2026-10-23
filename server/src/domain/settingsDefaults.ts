import type { Settings } from "../../../shared/types";

// Defaults come from job-mentor-prompt.md. Everything is editable on the Settings page.
export const DEFAULT_SETTINGS: Settings = {
  targets: {
    appsPerDay: 10,
    daysPerWeek: 6,
    hoursPerWeekCap: 30,
    bucketHours: { applications: 20, projects: 6, prep: 4 },
  },
  capReviewDate: "2026-11-06",
  // Fixed, truthful answers. The LLM never writes these (hard constraint).
  workAuth: {
    authorizedToWorkInUS: "Yes",
    requiresSponsorshipNowOrFuture: "Yes",
  },
  locationPrefs: { preferred: ["Chicago, IL", "Remote (US)"], openToRelocation: true },
  // Small model for bulk scoring, larger one for tailoring and check-ins.
  models: {
    scoring: "claude-haiku-5-5",
    tailoring: "claude-sonnet-5-5",
    checkIns: "claude-sonnet-5-5",
  },
  pipeline: {
    enabled: true,
    dailyTime: "07:00",
    timezone: "America/Chicago",
    // Upper bound on AI scoring calls per run, so a first run over hundreds of
    // postings can't surprise you on cost.
    maxScoresPerRun: 150,
  },
};
