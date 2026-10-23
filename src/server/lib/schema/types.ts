/**
 * Schema Generator core types.
 *
 * Every property in a proposal carries an observation source: the stored page
 * field, Salla extraction path, or existing JSON-LD node it was read from.
 * There is no "default" source — a property without observations is omitted
 * (D6/D12: never manufacture values).
 */
import type { JsonLdNode } from "../audit/salla/json-ld";
import type { PageTypeName } from "../audit/salla/page-type-evidence";
import type { ExtractionState } from "@/shared/audit-fetch-class";

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

/** Stored page evidence available to the generator (no network reads). */
export interface SchemaPageInput {
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  metaDescription: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  images: Array<{ src: string | null; alt: string | null }>;
  pageType: PageTypeName | null;
  extractionState: ExtractionState;
  isIndexable: boolean;
  structuredDataJson: string | null;
  sallaExtractionJson: string | null;
}

/** One emitted property and where its value was observed. */
export interface ObservedProperty {
  path: string;
  value: unknown;
  source: string;
}

export interface SchemaProposal {
  type: SchemaEntityType;
  jsonLd: JsonLdNode;
  properties: ObservedProperty[];
  notes: string[];
}

export type ProposalResult =
  | { ok: true; proposal: SchemaProposal }
  | { ok: false; type: SchemaEntityType; reasons: string[] };

export interface ValidationReport {
  valid: boolean;
  errors: string[];
  /** null when Google has no rich-result feature for this type. */
  richResultEligible: boolean | null;
  missingRichResultRequired: string[];
  missingRichResultRecommended: string[];
}

export type DiffStatus =
  | "kept"
  | "added"
  | "changed"
  | "conflicting"
  | "existing_only";

export interface DiffEntry {
  path: string;
  status: DiffStatus;
  existing: unknown;
  proposed: unknown;
  source: string | null;
}

export interface SchemaDiff {
  entries: DiffEntry[];
  notes: string[];
}

export type { JsonLdNode };
