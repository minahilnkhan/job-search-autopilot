ALTER TABLE `jobs` ADD `fields_confirmed` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Pasted jobs were reviewed on the Add a job page, so their fields count as confirmed.
UPDATE `jobs` SET `fields_confirmed` = 1 WHERE `source` = 'manual';
