-- Phase 5: hours against the cap need an estimate per task, and weekly
-- projects need the week they belong to and the skills they're meant to build.
ALTER TABLE `tasks` ADD `estimate_minutes` integer;
--> statement-breakpoint
ALTER TABLE `projects` ADD `week_start` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD `skills` text;
