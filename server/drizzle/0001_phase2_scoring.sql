CREATE TABLE `api_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`job_id` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `api_usage_at_idx` ON `api_usage` (`at`);--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trigger` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`stats` text,
	`message` text
);
--> statement-breakpoint
CREATE TABLE `shortlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`run_id` integer,
	`job_ids` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shortlists_date_unique` ON `shortlists` (`date`);--> statement-breakpoint
ALTER TABLE `companies` ADD `ats_last_checked_at` integer;--> statement-breakpoint
ALTER TABLE `companies` ADD `ats_last_status` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `scored_at` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `pipeline` text DEFAULT '{"enabled":true,"dailyTime":"07:00","timezone":"America/Chicago","maxScoresPerRun":150}' NOT NULL;