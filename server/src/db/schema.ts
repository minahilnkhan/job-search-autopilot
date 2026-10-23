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
  ExtractedFields,
  FilterReason,
  Settings,
} from "../../../shared/types";

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
    source: text("source").notNull().default("manual"),
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
    fitScore: integer("fit_score"),
    scoreBreakdown: text("score_breakdown", { mode: "json" }).$type<Record<string, unknown>>(),
    tier: text("tier", { enum: ["A", "B", "skip"] }), // null until scored (Phase 2)
    redFlags: text("red_flags", { mode: "json" }).$type<string[]>(),
    status: text("status", { enum: ["new", "shortlisted", "dismissed"] })
      .notNull()
      .default("new"),
    // Not in the original spec: company|normalized title|normalized location, for dedupe.
    dedupeKey: text("dedupe_key").notNull(),
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
    answers: text("answers", { mode: "json" }).$type<Record<string, string>>(),
    status: text("status", { enum: APPLICATION_STATUSES }).notNull().default("draft"),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
    followUpDue: text("follow_up_due"),
    lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("applications_job_idx").on(t.jobId)]
);

export const resumeVersions = sqliteTable("resume_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  baseType: text("base_type", { enum: ["fde", "swe"] }).notNull(),
  parentId: integer("parent_id").references((): AnySQLiteColumn => resumeVersions.id),
  jobId: integer("job_id").references(() => jobs.id),
  content: text("content", { mode: "json" })
    .$type<{ sections: { title: string; bullets: string[] }[] }>()
    .notNull(),
  diffFromBase: text("diff_from_base", { mode: "json" }).$type<unknown>(),
  truthCheckStatus: text("truth_check_status", {
    enum: ["pending", "pass", "fail", "overridden"],
  })
    .notNull()
    .default("pending"),
  filePathDocx: text("file_path_docx"),
  filePathPdf: text("file_path_pdf"),
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
});
