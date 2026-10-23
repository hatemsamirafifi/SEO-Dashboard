/** Supported Schema.org entity types for the schema generator. */
export const SCHEMA_ENTITY_TYPES = [
  "Organization",
  "LocalBusiness",
  "Article",
  "BlogPosting",
  "Product",
  "BreadcrumbList",
  "FAQPage",
  "WebSite",
  "WebPage",
  "Service",
  "Person",
  "Event",
] as const;

export type SchemaEntityType = (typeof SCHEMA_ENTITY_TYPES)[number];

const SCHEMA_ENTITY_TYPE_SET: ReadonlySet<string> = new Set(
  SCHEMA_ENTITY_TYPES,
);

export function isSchemaEntityType(value: string): value is SchemaEntityType {
  return SCHEMA_ENTITY_TYPE_SET.has(value);
}
