/**
 * Two-axis schema judgement:
 *
 *   - valid: the document satisfies Schema.org structural requirements for its
 *     @type (required properties present and non-empty);
 *   - richResultEligible: the document additionally satisfies the Google
 *     rich-result requirements for that type. Null means Google publishes no
 *     rich-result feature for the type, so eligibility is not applicable.
 *
 * The two axes stay separate on purpose: a structurally valid Product without
 * an offer is still not rich-result eligible, and the report says which
 * properties are missing instead of collapsing the verdicts.
 */
import { jsonLdTypeNames } from "../audit/salla/json-ld";
import type { JsonLdNode } from "../audit/salla/json-ld";
import { isSchemaEntityType } from "./types";
import type { SchemaEntityType, ValidationReport } from "./types";

const STRUCTURAL_REQUIREMENTS: Record<SchemaEntityType, string[]> = {
  Organization: ["name"],
  LocalBusiness: ["name", "address"],
  Article: ["headline"],
  BlogPosting: ["headline"],
  Product: ["name"],
  BreadcrumbList: ["itemListElement"],
  FAQPage: ["mainEntity"],
  WebSite: ["url"],
  WebPage: ["name", "url"],
  Service: ["name"],
  Person: ["name"],
  Event: ["name", "startDate", "location"],
};

interface RichResultRule {
  required: string[];
  recommended: string[];
}

const RICH_RESULT_RULES: Partial<Record<SchemaEntityType, RichResultRule>> = {
  Product: {
    required: ["name", "image", "offers.price"],
    recommended: [
      "offers.priceCurrency",
      "offers.availability",
      "brand",
      "sku",
      "description",
    ],
  },
  Article: {
    required: ["headline", "image", "datePublished", "author"],
    recommended: ["dateModified"],
  },
  BlogPosting: {
    required: ["headline", "image", "datePublished", "author"],
    recommended: ["dateModified"],
  },
  BreadcrumbList: {
    required: ["itemListElement"],
    recommended: ["itemListElement.item"],
  },
  FAQPage: { required: ["mainEntity"], recommended: [] },
  LocalBusiness: {
    required: ["name", "address"],
    recommended: ["telephone", "url", "openingHours"],
  },
  Event: {
    required: ["name", "startDate", "location"],
    recommended: ["endDate", "image", "offers"],
  },
  Organization: {
    required: ["name"],
    recommended: ["url", "logo", "sameAs"],
  },
  Person: { required: ["name"], recommended: ["url", "sameAs"] },
  WebSite: { required: ["url"], recommended: ["name"] },
  WebPage: { required: [], recommended: [] },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    const key = segment.split("[")[0];
    if (Array.isArray(current)) {
      const values: unknown[] = [];
      for (const item of current) {
        if (isRecord(item) && item[key] !== undefined) values.push(item[key]);
      }
      current = values.length > 0 ? values : undefined;
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasValue);
  if (isRecord(value)) return Object.keys(value).length > 0;
  return false;
}

function resolveType(jsonLd: JsonLdNode): SchemaEntityType | null {
  const types = jsonLdTypeNames(jsonLd["@type"]);
  for (const type of types) {
    if (isSchemaEntityType(type) && type in STRUCTURAL_REQUIREMENTS) {
      return type;
    }
  }
  return null;
}

export function validateSchema(jsonLd: JsonLdNode): ValidationReport {
  const type = resolveType(jsonLd);
  if (!type) {
    return {
      valid: false,
      errors: ["No supported @type on document"],
      richResultEligible: null,
      missingRichResultRequired: [],
      missingRichResultRecommended: [],
    };
  }

  const errors = STRUCTURAL_REQUIREMENTS[type]
    .filter((path) => !hasValue(readPath(jsonLd, path)))
    .map((path) => `Missing required property: ${path}`);

  const rule = RICH_RESULT_RULES[type];
  if (!rule) {
    return {
      valid: errors.length === 0,
      errors,
      richResultEligible: null,
      missingRichResultRequired: [],
      missingRichResultRecommended: [],
    };
  }

  const missingRequired = rule.required.filter(
    (path) => !hasValue(readPath(jsonLd, path)),
  );
  const missingRecommended = rule.recommended.filter(
    (path) => !hasValue(readPath(jsonLd, path)),
  );
  return {
    valid: errors.length === 0,
    errors,
    richResultEligible: missingRequired.length === 0,
    missingRichResultRequired: missingRequired,
    missingRichResultRecommended: missingRecommended,
  };
}
