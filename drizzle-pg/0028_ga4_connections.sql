CREATE TABLE "ga4_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "property_id" text NOT NULL,
  "property_display_name" text NOT NULL,
  "connected_by_user_id" text NOT NULL,
  "ga4_account_id" text NOT NULL,
  "currency_code" text,
  "has_ecommerce" boolean DEFAULT false NOT NULL,
  "created_at" text DEFAULT now() NOT NULL,
  "updated_at" text DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "ga4_connections_project_idx" ON "ga4_connections" USING btree ("project_id");
CREATE INDEX "ga4_connections_organization_idx" ON "ga4_connections" USING btree ("organization_id");
