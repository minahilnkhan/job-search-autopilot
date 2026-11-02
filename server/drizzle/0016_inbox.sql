CREATE TABLE `email_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`from_address` text NOT NULL,
	`from_name` text,
	`subject` text NOT NULL,
	`received_at` integer NOT NULL,
	`snippet` text NOT NULL,
	`application_id` integer,
	`candidate_ids` text,
	`kind` text NOT NULL,
	`kind_source` text NOT NULL,
	`kind_reason` text,
	`suggested_status` text,
	`state` text NOT NULL,
	`decided_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_messages_message_id_idx` ON `email_messages` (`message_id`);--> statement-breakpoint
CREATE TABLE `mail_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trigger` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`stats` text,
	`error` text
);
