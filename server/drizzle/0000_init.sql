CREATE TABLE `applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`tier` text,
	`resume_version_id` integer,
	`recruiter_note` text,
	`answers` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`approved_at` integer,
	`submitted_at` integer,
	`follow_up_due` text,
	`last_activity_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resume_version_id`) REFERENCES `resume_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `applications_job_idx` ON `applications` (`job_id`);--> statement-breakpoint
CREATE TABLE `check_ins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`type` text NOT NULL,
	`input_state` text,
	`mentor_output` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`website` text,
	`ats_type` text,
	`ats_board_token` text,
	`e_verify` text DEFAULT 'unknown' NOT NULL,
	`h1b_history` integer,
	`tags` text DEFAULT '[]' NOT NULL,
	`warm_contact` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_name_lower_uq` ON `companies` (lower("name"));--> statement-breakpoint
CREATE TABLE `interviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer NOT NULL,
	`stage` text NOT NULL,
	`scheduled_at` integer,
	`prep_plan` text,
	`outcome` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`location` text,
	`remote` integer DEFAULT false NOT NULL,
	`posted_at` text,
	`fetched_at` integer,
	`description` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`years_required` integer,
	`sponsorship_stated` text DEFAULT 'unstated' NOT NULL,
	`hard_filter_pass` integer NOT NULL,
	`filter_fail_reasons` text DEFAULT '[]' NOT NULL,
	`extracted_fields` text NOT NULL,
	`fit_score` integer,
	`score_breakdown` text,
	`tier` text,
	`red_flags` text,
	`status` text DEFAULT 'new' NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_key_uq` ON `jobs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `jobs_company_idx` ON `jobs` (`company_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`repo_url` text,
	`status` text DEFAULT 'active' NOT NULL,
	`hours_logged` real DEFAULT 0 NOT NULL,
	`tasks` text,
	`result_metric` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `resume_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`base_type` text NOT NULL,
	`parent_id` integer,
	`job_id` integer,
	`content` text NOT NULL,
	`diff_from_base` text,
	`truth_check_status` text DEFAULT 'pending' NOT NULL,
	`file_path_docx` text,
	`file_path_pdf` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `resume_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`targets` text NOT NULL,
	`cap_review_date` text NOT NULL,
	`work_auth` text NOT NULL,
	`location_prefs` text NOT NULL,
	`models` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`bucket` text,
	`due_date` text,
	`priority` integer DEFAULT 2 NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`linked_entity` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `time_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bucket` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`minutes` integer,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
