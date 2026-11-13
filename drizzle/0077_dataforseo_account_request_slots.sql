CREATE TABLE `dataforseo_account_request_slots` (
	`account_hash` text PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 1 NOT NULL,
	`acquired_at` text NOT NULL,
	`free_at` text NOT NULL
);
