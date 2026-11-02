-- Named resume versions beside the two bases, tagged by role type.
CREATE TABLE `resume_library` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`role_tag` text NOT NULL,
	`version_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `resume_versions`(`id`) ON UPDATE no action ON DELETE no action
);
