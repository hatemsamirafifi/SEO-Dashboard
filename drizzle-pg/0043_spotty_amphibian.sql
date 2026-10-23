CREATE TABLE "salla_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"connected_by_user_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"merchant_name" text,
	"store_id" text NOT NULL,
	"store_domain" text,
	"store_url" text,
	"store_status" text,
	"scope" text,
	"token_ciphertext" text NOT NULL,
	"token_expires_at" text,
	"connected_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "salla_connections" ADD CONSTRAINT "salla_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salla_connections" ADD CONSTRAINT "salla_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "salla_connections_project_idx" ON "salla_connections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "salla_connections_organization_idx" ON "salla_connections" USING btree ("organization_id");