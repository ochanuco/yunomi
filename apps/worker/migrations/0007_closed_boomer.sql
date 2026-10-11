CREATE TABLE `interest_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`topic` text NOT NULL,
	`before_score` real NOT NULL,
	`after_score` real NOT NULL,
	`reason` text NOT NULL,
	`source_message_id` text NOT NULL,
	`lifestyle_day` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `interest_changes_day` ON `interest_changes` (`partner_id`,`lifestyle_day`,`topic`);--> statement-breakpoint
CREATE TABLE `interest_states` (
	`partner_id` text NOT NULL,
	`topic` text NOT NULL,
	`score` real NOT NULL,
	`baseline` real NOT NULL,
	`learned_delta` real NOT NULL,
	`summary` text NOT NULL,
	`updated_at` text NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`partner_id`, `topic`)
);
--> statement-breakpoint
CREATE TABLE `opinion_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`topic` text NOT NULL,
	`direction` text NOT NULL,
	`before_stance` text NOT NULL,
	`after_stance` text NOT NULL,
	`before_confidence` real NOT NULL,
	`after_confidence` real NOT NULL,
	`reason` text NOT NULL,
	`source_message_id` text NOT NULL,
	`lifestyle_day` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `opinion_changes_day` ON `opinion_changes` (`partner_id`,`lifestyle_day`,`topic`);--> statement-breakpoint
CREATE TABLE `opinion_states` (
	`partner_id` text NOT NULL,
	`topic` text NOT NULL,
	`stance` text NOT NULL,
	`confidence` real NOT NULL,
	`stability` real NOT NULL,
	`reasons` text NOT NULL,
	`source_memory_ids` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`partner_id`, `topic`)
);
