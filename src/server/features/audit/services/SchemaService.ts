/**
 * Schema Generator application layer.
 *
 * Reads one stored audit page (project-scoped), maps it to the generator's
 * input contract, and returns the availability verdicts plus an optional
 * proposal, validation report, and existing-vs-proposed diff. No network
 * reads, no writes: everything comes from the crawl's persisted evidence.
 */
import { z } from "zod";
import type { auditPages } from "@/db/schema";
import { PAGE_TYPE_NAMES } from "@/server/lib/audit/salla/page-type-evidence";
import type { PageTypeName } from "@/server/lib/audit/salla/page-type-evidence";
import { diffSchema } from "@/server/lib/schema/diff";
import {
  generateSchema,
  proposeSchemaTypes,
} from "@/server/lib/schema/generate";
import { readSchemaObservations } from "@/server/lib/schema/observations";
import type {
  SchemaEntityType,
  SchemaPageInput,
  SchemaProposal,
  SchemaDiff,
  ValidationReport,
} from "@/server/lib/schema/types";
import { validateSchema } from "@/server/lib/schema/validate";
import { AuditRepository } from "../repositories/AuditRepository";

type AuditPageRow = typeof auditPages.$inferSelect;

const PAGE_TYPE_SET: ReadonlySet<string> = new Set(PAGE_TYPE_NAMES);

function isPageTypeName(value: string): value is PageTypeName {
  return PAGE_TYPE_SET.has(value);
}

function asPageTypeName(value: string | null): PageTypeName | null {
  return value && isPageTypeName(value) ? value : null;
}

const imagesSchema = z.array(
  z.object({ src: z.string().nullable(), alt: z.string().nullable() }),
);

function parseImages(json: string | null): SchemaPageInput["images"] {
  if (!json) return [];
  try {
    const parsed = imagesSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function toPageInput(page: AuditPageRow): SchemaPageInput {
  return {
    url: page.url,
    canonicalUrl: page.canonicalUrl,
    title: page.title,
    metaDescription: page.metaDescription,
    ogTitle: page.ogTitle,
    ogDescription: page.ogDescription,
    ogImage: page.ogImage,
    images: parseImages(page.imagesJson),
    pageType: asPageTypeName(page.pageType),
    extractionState: page.extractionState,
    isIndexable: page.isIndexable,
    structuredDataJson: page.structuredDataJson,
    sallaExtractionJson: page.sallaExtractionJson,
  };
}

export interface PageSchemaResult {
  page: {
    id: string;
    url: string;
    pageType: PageTypeName | null;
    extractionState: AuditPageRow["extractionState"];
  };
  availableTypes: Array<{
    type: SchemaEntityType;
    ok: boolean;
    reasons: string[];
  }>;
  requestedType: SchemaEntityType | null;
  proposal: SchemaProposal | null;
  validation: ValidationReport | null;
  diff: SchemaDiff | null;
  reasons: string[];
}

export interface GetPageSchemaInput {
  pageId: string;
  auditId: string;
  projectId: string;
  type?: SchemaEntityType;
}

async function getPageSchema(
  input: GetPageSchemaInput,
): Promise<PageSchemaResult | null> {
  const page = await AuditRepository.getAuditPageForProject({
    pageId: input.pageId,
    auditId: input.auditId,
    projectId: input.projectId,
  });
  if (!page) return null;

  const pageInput = toPageInput(page);
  const base = {
    page: {
      id: page.id,
      url: page.url,
      pageType: pageInput.pageType,
      extractionState: page.extractionState,
    },
    availableTypes: proposeSchemaTypes(pageInput),
  };
  const requestedType = input.type ?? null;
  if (!requestedType) {
    return {
      ...base,
      requestedType: null,
      proposal: null,
      validation: null,
      diff: null,
      reasons: [],
    };
  }

  const generated = generateSchema(pageInput, requestedType);
  if (!generated.ok) {
    return {
      ...base,
      requestedType,
      proposal: null,
      validation: null,
      diff: null,
      reasons: generated.reasons,
    };
  }

  const observations = readSchemaObservations(pageInput);
  return {
    ...base,
    requestedType,
    proposal: generated.proposal,
    validation: validateSchema(generated.proposal.jsonLd),
    diff: diffSchema(
      observations.existing.map((entry) => entry.node),
      generated.proposal.jsonLd,
      generated.proposal.properties,
    ),
    reasons: [],
  };
}

export const SchemaService = {
  getPageSchema,
} as const;
