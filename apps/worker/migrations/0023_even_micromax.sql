CREATE TABLE `working_events` (
	`partner_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`title` text NOT NULL,
	`event` text NOT NULL,
	`status` text,
	`summary` text,
	`at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`partner_id`, `thread_id`)
);
--> statement-breakpoint
CREATE INDEX `working_events_partner_at` ON `working_events` (`partner_id`,`at`);