CREATE TABLE "ga4_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"property_id" text NOT NULL,
	"property_display_name" text NOT NULL,
	"connected_by_user_id" text NOT NULL,
	"ga4_account_id" text NOT NULL,
	"currency_code" text,
	"has_ecommerce" boolean DEFAULT false NOT NULL,
	"created_at" text DEFAULT now() NOT NULL,
	"updated_at" text DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ga4_connections" ADD CONSTRAINT "ga4_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ga4_connections" ADD CONSTRAINT "ga4_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ga4_connections_project_idx" ON "ga4_connections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ga4_connections_organization_idx" ON "ga4_connections" USING btree ("organization_id");