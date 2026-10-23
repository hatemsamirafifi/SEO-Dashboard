/**
 * Schema Generator core types.
 *
 * Every property in a proposal carries an observation source: the stored page
 * field, Salla extraction path, or existing JSON-LD node it was read from.
 * There is no "default" source — a property without observations is omitted
 * (D6/D12: never manufacture values).
 */
import type { PageTypeName } from "../audit/salla/page-type-evidence";
import type { ExtractionState } from "@/shared/audit-fetch-class";
import type { SchemaEntityType } from "@/shared/schema-types";

export {
  SCHEMA_ENTITY_TYPES,
  isSchemaEntityType,
  type SchemaEntityType,
} from "@/shared/schema-types";

/** JSON-serializable value (server-function return contract). */
export type SchemaJson =
  | string
  | number
  | boolean
  | null
  | SchemaJson[]
  | SchemaJsonObject;

export interface SchemaJsonObject {
  [key: string]: SchemaJson;
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
  value: SchemaJson;
  source: string;
}

export interface SchemaProposal {
  type: SchemaEntityType;
  jsonLd: SchemaJsonObject;
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
  existing: SchemaJson;
  proposed: SchemaJson;
  source: string | null;
}

export interface SchemaDiff {
  entries: DiffEntry[];
  notes: string[];
}
