CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `external_identities` (
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`entity_id` text NOT NULL,
	PRIMARY KEY(`provider`, `external_id`),
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `relationship_events` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`type` text NOT NULL,
	`summary` text NOT NULL,
	`familiarity_delta` real NOT NULL,
	`trust_delta` real NOT NULL,
	`closeness_delta` real,
	`tension_delta` real,
	`source` text NOT NULL,
	`confidence` real NOT NULL,
	`related_episode_id` text,
	`reason` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `relationship_events_entity` ON `relationship_events` (`partner_id`,`entity_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `state_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`delta_json` text NOT NULL,
	`source_event_id` text NOT NULL,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `state_transitions_partner` ON `state_transitions` (`partner_id`,`occurred_at`);