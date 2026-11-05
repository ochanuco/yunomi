CREATE TABLE `work_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `work_notes_entity` ON `work_notes` (`partner_id`,`entity_id`,`created_at`);