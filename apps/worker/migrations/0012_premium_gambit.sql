CREATE TABLE `watches` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`query` text NOT NULL,
	`sources` text NOT NULL,
	`interval_minutes` integer NOT NULL,
	`until_at` text,
	`status` text NOT NULL,
	`seen` text NOT NULL,
	`last_checked_at` text,
	`created_at` text NOT NULL,
	`stopped_at` text,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `watches_entity` ON `watches` (`partner_id`,`entity_id`,`status`);