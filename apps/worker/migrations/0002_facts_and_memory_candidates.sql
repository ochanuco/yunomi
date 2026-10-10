CREATE TABLE `facts` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`subject_entity_id` text NOT NULL,
	`predicate` text NOT NULL,
	`object_type` text NOT NULL,
	`object_value` text NOT NULL,
	`object_display` text,
	`confidence` real NOT NULL,
	`importance` real NOT NULL,
	`source` text NOT NULL,
	`observed_at` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`decay_policy` text DEFAULT 'standard' NOT NULL,
	`superseded_by` text,
	FOREIGN KEY (`subject_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `facts_retrieval` ON `facts` (`partner_id`,`subject_entity_id`,`importance`,`observed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `facts_current_unique` ON `facts` (`partner_id`,`subject_entity_id`,`predicate`) WHERE "facts"."valid_to" IS NULL AND "facts"."superseded_by" IS NULL;--> statement-breakpoint
CREATE TABLE `memory_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`subject_entity_id` text,
	`subject_text` text,
	`predicate` text NOT NULL,
	`object_type` text NOT NULL,
	`object_value` text NOT NULL,
	`confidence` real NOT NULL,
	`importance` real NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`conflict_fact_id` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`source_event_id` text NOT NULL,
	FOREIGN KEY (`subject_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memory_candidates_status` ON `memory_candidates` (`partner_id`,`status`);