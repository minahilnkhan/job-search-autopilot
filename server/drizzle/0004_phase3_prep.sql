-- Hand-edited: drizzle-kit wanted to rebuild the settings table (copying a
-- column that doesn't exist yet). A plain ADD COLUMN with a default does the job.
ALTER TABLE `settings` ADD `standard_answers` text DEFAULT '[{"question":"How did you hear about this role?","answer":"Their careers page."},{"question":"Are you willing to relocate?","answer":"Yes, anywhere in the US."},{"question":"When can you start?","answer":"[your start date or notice period]"},{"question":"What are your salary expectations?","answer":"[your answer, or leave it open]"}]' NOT NULL;--> statement-breakpoint
ALTER TABLE `applications` ADD `truth_report` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `truth_override` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `review_reason` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `snoozed_until` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `prep_notes` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `tailoring` text;--> statement-breakpoint
ALTER TABLE `resume_versions` ADD `pdf_pages` integer;--> statement-breakpoint
ALTER TABLE `resume_versions` ADD `truth_report` text;
