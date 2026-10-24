import { sql } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
  uniqueIndex,
  index,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import type {
  NoteBasis,
  PrefillReport,
  Answer,
  ExtractedFields,
  ResumeChange,
  ResumeContent,
  TruthReport,
  FilterReason,
  RunStats,
  ScoreBreakdown,
  Settings,
} from "../../../shared/types";
import { DEFAULT_SETTINGS } from "../domain/settingsDefaults";

// Conventions:
// - Timestamps are integer milliseconds (timestamp_ms); calendar dates are 'YYYY-MM-DD' text.
// - JSON columns use text({ mode: "json" }) so Drizzle parses/serializes them for us.
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

export const companies = sqliteTable(
  "companies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    website: text("website"),
    atsType: text("ats_type", { enum: ["greenhouse", "lever", "ashby", "other"] }),
    atsBoardToken: text("ats_board_token"),
    eVerify: text("e_verify", { enum: ["confirmed", "likely", "unknown"] })
      .notNull()
      .default("unknown"),
    h1bHistory: integer("h1b_history"),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
    warmContact: integer("warm_contact", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    // Phase 2: result of the last job-board fetch, e.g. "ok: 121 postings" or the error.
    atsLastCheckedAt: integer("ats_last_checked_at", { mode: "timestamp_ms" }),
    atsLastStatus: text("ats_last_status"),
    createdAt: createdAt(),
  },
  // Case-insensitive uniqueness: "Anthropic" and "anthropic" are one company.
  (t) => [uniqueIndex("companies_name_lower_uq").on(sql`lower(${t.name})`)]
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id),
    title: text("title").notNull(),
    url: text("url"),
    location: text("location"),
    remote: integer("remote", { mode: "boolean" }).notNull().default(false),
    postedAt: text("posted_at"),
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }),
    description: text("description").notNull(),
    source: text("source").notNull().default("manual"), // manual | greenhouse | lever | ashby
    externalId: text("external_id"), // the job board's own id for the posting
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }), // last run that still saw it open
    yearsRequired: integer("years_required"),
    sponsorshipStated: text("sponsorship_stated", { enum: ["yes", "no", "unstated"] })
      .notNull()
      .default("unstated"),
    hardFilterPass: integer("hard_filter_pass", { mode: "boolean" }).notNull(),
    // Holds fails AND warns, each tagged with severity, so the UI can show both.
    filterFailReasons: text("filter_fail_reasons", { mode: "json" })
      .$type<FilterReason[]>()
      .notNull()
      .default([]),
    // Not in the original spec: the reviewed extraction (flags + evidence) the filters ran on.
    extractedFields: text("extracted_fields", { mode: "json" }).$type<ExtractedFields>().notNull(),
    // True once a person has reviewed the fields (pasted jobs, or "Correct fields"):
    // automatic re-extraction never overwrites them.
    fieldsConfirmed: integer("fields_confirmed", { mode: "boolean" }).notNull().default(false),
    fitScore: integer("fit_score"),
    scoreBreakdown: text("score_breakdown", { mode: "json" }).$type<ScoreBreakdown>(),
    scoredAt: integer("scored_at", { mode: "timestamp_ms" }),
    tier: text("tier", { enum: ["A", "B", "skip"] }), // null until scored (Phase 2)
    redFlags: text("red_flags", { mode: "json" }).$type<string[]>(),
    status: text("status", { enum: ["new", "shortlisted", "dismissed"] })
      .notNull()
      .default("new"),
    // Not in the original spec: company|normalized title|normalized location, for dedupe.
    dedupeKey: text("dedupe_key").notNull(),
    // Deleted from the Jobs page. The row stays so the daily fetch doesn't add the posting back.
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("jobs_dedupe_key_uq").on(t.dedupeKey),
    index("jobs_company_idx").on(t.companyId),
  ]
);

export const APPLICATION_STATUSES = [
  "draft",
  "ready_for_review",
  "approved",
  "submitted",
  "screen",
  "interview",
  "offer",
  "rejected",
  "ghosted",
  "withdrawn",
] as const;

export const applications = sqliteTable(
  "applications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id),
    tier: text("tier", { enum: ["A", "B"] }),
    resumeVersionId: integer("resume_version_id").references(() => resumeVersions.id),
    recruiterNote: text("recruiter_note"),
    answers: text("answers", { mode: "json" }).$type<Answer[]>(),
    status: text("status", { enum: APPLICATION_STATUSES }).notNull().default("draft"),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
    followUpDue: text("follow_up_due"),
    lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }),
    // Phase 3
    truthReport: text("truth_report", { mode: "json" }).$type<TruthReport>(),
    truthOverride: text("truth_override", { mode: "json" }).$type<{ reason: string; at: number }>(),
    reviewReason: text("review_reason"), // why you rejected it in review
    snoozedUntil: text("snoozed_until"), // YYYY-MM-DD
    prepNotes: text("prep_notes", { mode: "json" }).$type<string[]>(),
    tailoring: text("tailoring", { mode: "json" }).$type<{ keywordsCovered: string[]; keywordsMissing: string[]; honestGaps: string[]; mustHaves?: string[]; suggestions?: string[] }>(),
    // What the recruiter note was built around, so you can judge and edit it.
    noteBasis: text("note_basis", { mode: "json" }).$type<NoteBasis>(),
    // Phase 4: what the assisted-submit prefill filled and left for you.
    prefillReport: text("prefill_report", { mode: "json" }).$type<PrefillReport>(),
    createdAt: createdAt(),
  },
  (t) => [index("applications_job_idx").on(t.jobId)]
);

export const resumeVersions = sqliteTable("resume_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  baseType: text("base_type", { enum: ["fde", "swe"] }).notNull(),
  parentId: integer("parent_id").references((): AnySQLiteColumn => resumeVersions.id),
  jobId: integer("job_id").references(() => jobs.id),
  content: text("content", { mode: "json" }).$type<ResumeContent>().notNull(),
  diffFromBase: text("diff_from_base", { mode: "json" }).$type<ResumeChange[]>(),
  truthCheckStatus: text("truth_check_status", {
    enum: ["pending", "pass", "fail", "overridden"],
  })
    .notNull()
    .default("pending"),
  filePathDocx: text("file_path_docx"),
  filePathPdf: text("file_path_pdf"),
  pdfPages: integer("pdf_pages"),
  truthReport: text("truth_report", { mode: "json" }).$type<TruthReport>(),
  createdAt: createdAt(),
});

const BUCKETS = ["applications", "projects", "prep"] as const;

export const timeLogs = sqliteTable("time_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bucket: text("bucket", { enum: BUCKETS }).notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  minutes: integer("minutes"),
  note: text("note"),
  createdAt: createdAt(),
});

export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  bucket: text("bucket", { enum: BUCKETS }),
  dueDate: text("due_date"),
  priority: integer("priority").notNull().default(2), // 1 = highest
  source: text("source", { enum: ["mentor", "manual"] }).notNull().default("manual"),
  status: text("status", { enum: ["todo", "doing", "done", "dropped"] })
    .notNull()
    .default("todo"),
  linkedEntity: text("linked_entity"), // e.g. "application:12"
  createdAt: createdAt(),
});

export const interviews = sqliteTable("interviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  applicationId: integer("application_id")
    .notNull()
    .references(() => applications.id),
  stage: text("stage").notNull(),
  scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }),
  prepPlan: text("prep_plan", { mode: "json" }).$type<unknown>(),
  outcome: text("outcome"),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  repoUrl: text("repo_url"),
  status: text("status").notNull().default("active"),
  hoursLogged: real("hours_logged").notNull().default(0),
  tasks: text("tasks", { mode: "json" }).$type<unknown[]>(),
  resultMetric: text("result_metric"),
  createdAt: createdAt(),
});

export const checkIns = sqliteTable("check_ins", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  type: text("type", { enum: ["daily", "weekly"] }).notNull(),
  inputState: text("input_state", { mode: "json" }).$type<unknown>(),
  mentorOutput: text("mentor_output", { mode: "json" }).$type<unknown>(),
  createdAt: createdAt(),
});

// Single-row table (id = 1). One JSON column per settings group keeps
// validation in one zod schema instead of a dozen nullable columns.
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  targets: text("targets", { mode: "json" }).$type<Settings["targets"]>().notNull(),
  capReviewDate: text("cap_review_date").notNull(),
  workAuth: text("work_auth", { mode: "json" }).$type<Settings["workAuth"]>().notNull(),
  locationPrefs: text("location_prefs", { mode: "json" })
    .$type<Settings["locationPrefs"]>()
    .notNull(),
  models: text("models", { mode: "json" }).$type<Settings["models"]>().notNull(),
  // Column default kept as first shipped (changing it would rebuild the
  // table); getSettings() fills in any newer keys from DEFAULT_SETTINGS.
  shortlist: text("shortlist", { mode: "json" })
    .$type<Settings["shortlist"]>()
    .notNull()
    .default(sql`'{"minFitScore":8,"maxAgeDays":14,"preferredCityBoost":1}'`),
  pipeline: text("pipeline", { mode: "json" })
    .$type<Settings["pipeline"]>()
    .notNull()
    .default(DEFAULT_SETTINGS.pipeline),
  submit: text("submit", { mode: "json" }).$type<Settings["submit"]>().notNull().default(DEFAULT_SETTINGS.submit),
  profile: text("profile", { mode: "json" }).$type<Settings["profile"]>().notNull().default(DEFAULT_SETTINGS.profile),
  standardAnswers: text("standard_answers", { mode: "json" })
    .$type<Settings["standardAnswers"]>()
    .notNull()
    .default(DEFAULT_SETTINGS.standardAnswers),
});

// ---- Phase 2 -----------------------------------------------------------------

export const pipelineRuns = sqliteTable("pipeline_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  trigger: text("trigger", { enum: ["schedule", "catch_up", "manual"] }).notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  status: text("status", { enum: ["running", "ok", "partial", "failed"] }).notNull().default("running"),
  stats: text("stats", { mode: "json" }).$type<RunStats>(),
  message: text("message"), // why a run was partial or failed, in plain words
});

// The ranked list a run produced for one day. One row per date; a later run
// that day replaces it.
export const shortlists = sqliteTable("shortlists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull().unique(), // YYYY-MM-DD in the configured timezone
  runId: integer("run_id").references(() => pipelineRuns.id),
  jobIds: text("job_ids", { mode: "json" }).$type<number[]>().notNull(),
  createdAt: createdAt(),
});

// One row per Anthropic API call, for the monthly spend on the dashboard.
export const apiUsage = sqliteTable(
  "api_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    purpose: text("purpose").notNull(), // "scoring" now; "tailoring", "check_in" later
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    costUsd: real("cost_usd"), // null if the model isn't in the price table
    jobId: integer("job_id").references(() => jobs.id),
  },
  (t) => [index("api_usage_at_idx").on(t.at)]
);
