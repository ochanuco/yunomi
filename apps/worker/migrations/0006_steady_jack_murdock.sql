CREATE TABLE `open_loops` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`summary` text NOT NULL,
	`importance` real NOT NULL,
	`due_at` text,
	`due_confidence` real,
	`follow_up_interval_hours` real,
	`status` text DEFAULT 'open' NOT NULL,
	`source_message_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text,
	`last_followed_up_at` text,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `open_loops_entity_status` ON `open_loops` (`partner_id`,`entity_id`,`status`,`importance`);--> statement-breakpoint
CREATE INDEX `open_loops_partner_created` ON `open_loops` (`partner_id`,`created_at`);