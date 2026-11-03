CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`linkedin_url` text NOT NULL,
	`headline` text,
	`relationship` text NOT NULL,
	`about` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_linkedin_url_idx` ON `contacts` (`linkedin_url`);--> statement-breakpoint
CREATE TABLE `outreach` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contact_id` integer NOT NULL,
	`application_id` integer,
	`status` text DEFAULT 'planned' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`ask` text DEFAULT '' NOT NULL,
	`follow_up` text DEFAULT '' NOT NULL,
	`issues` text DEFAULT '[]' NOT NULL,
	`invited_at` integer,
	`connected_at` integer,
	`connected_via` text,
	`asked_at` integer,
	`follow_up_due` text,
	`ended_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `outreach_contact_idx` ON `outreach` (`contact_id`);--> statement-breakpoint
CREATE INDEX `outreach_application_idx` ON `outreach` (`application_id`);