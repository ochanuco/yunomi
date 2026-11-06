CREATE TABLE `github_events` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`event` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_events_delivery` ON `github_events` (`delivery_id`);--> statement-breakpoint
CREATE INDEX `github_events_received` ON `github_events` (`received_at`);