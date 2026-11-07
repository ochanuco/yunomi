PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`query` text NOT NULL,
	`sources` text NOT NULL,
	`interval_minutes` integer,
	`until_at` text,
	`status` text NOT NULL,
	`seen` text NOT NULL,
	`last_checked_at` text,
	`created_at` text NOT NULL,
	`stopped_at` text,
	`notify_thread_id` text,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_watches`("id", "partner_id", "entity_id", "query", "sources", "interval_minutes", "until_at", "status", "seen", "last_checked_at", "created_at", "stopped_at", "notify_thread_id") SELECT "id", "partner_id", "entity_id", "query", "sources", "interval_minutes", "until_at", "status", "seen", "last_checked_at", "created_at", "stopped_at", "notify_thread_id" FROM `watches`;--> statement-breakpoint
DROP TABLE `watches`;--> statement-breakpoint
ALTER TABLE `__new_watches` RENAME TO `watches`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `watches_entity` ON `watches` (`partner_id`,`entity_id`,`status`);