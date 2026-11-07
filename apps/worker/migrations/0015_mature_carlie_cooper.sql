CREATE TABLE `maintenance_events` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`deleted_count` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `maintenance_events_partner_created` ON `maintenance_events` (`partner_id`,`created_at`);