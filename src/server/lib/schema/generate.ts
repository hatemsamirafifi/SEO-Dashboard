/**
 * Observed-only schema generator.
 *
 * Builders read the observation map and emit properties whose values were
 * actually persisted by the crawler. Types without page evidence are refused
 * with reasons (never emitted empty or with guessed values). Generation is
 * gated on STATIC_COMPLETE extraction so blocked/partial pages cannot produce
 * confirmed markup.
 */
import { toSchemaJson } from "./observations";
import type { SchemaJson, SchemaJsonObject } from "./types";
import {
  existingNodesOfType,
  observedBreadcrumbTrail,
  readSchemaObservations,
} from "./observations";
import type { Observed, SchemaObservations } from "./observations";
import type {
  ObservedProperty,
  ProposalResult,
  SchemaEntityType,
  SchemaPageInput,
} from "./types";
import { SCHEMA_ENTITY_TYPES } from "./types";

interface Draft {
  props: Record<string, SchemaJson>;
  properties: ObservedProperty[];
}

type Builder = (
  observations: SchemaObservations,
) => Draft | { reasons: string[] };

const SCHEMA_CONTEXT = "https://schema.org";

function emit(
  properties: ObservedProperty[],
  path: string,
  observation: Observed<SchemaJson>,
): SchemaJson {
  properties.push({
    path,
    value: observation.value,
    source: observation.source,
  });
  return observation.value;
}

function refusal(reason: string): { reasons: string[] } {
  return { reasons: [reason] };
}

function existingTypeDraft(
  observations: SchemaObservations,
  type: SchemaEntityType,
): Draft | { reasons: string[] } {
  const nodes = existingNodesOfType(observations, type);
  const node = nodes[0];
  if (!node) {
    return refusal(`No observed ${type} structured data on this page`);
  }
  const properties: ObservedProperty[] = [];
  const props: Record<string, SchemaJson> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "@context" || key === "@type" || key === "@graph") continue;
    const serializable = toSchemaJson(value);
    props[key] = serializable;
    properties.push({
      path: key,
      value: serializable,
      source: `json-ld.${type}.${key}`,
    });
  }
  return { props, properties };
}

function buildProduct(
  observations: SchemaObservations,
): Draft | { reasons: string[] } {
  const product = observations.product;
  if (!product) {
    return refusal("No product extraction evidence on this page");
  }
  if (!product.name) {
    return refusal("Product name was not observed");
  }
  const properties: ObservedProperty[] = [];
  const props: Record<string, SchemaJson> = {};

  props.name = emit(properties, "name", {
    value: product.name.value,
    source: "extraction.product.name",
  });
  if (product.sku) {
    props.sku = emit(properties, "sku", {
      value: product.sku.value,
      source: "extraction.product.sku",
    });
  }
  if (product.mpn) {
    props.mpn = emit(properties, "mpn", {
      value: product.mpn.value,
      source: "extraction.product.mpn",
    });
  }
  if (product.brand) {
    props.brand = {
      "@type": "Brand",
      name: emit(properties, "brand.name", {
        value: product.brand.value,
        source: "extraction.product.brand",
      }),
    };
  }
  if (product.description) {
    props.description = emit(properties, "description", {
      value: product.description.value,
      source: "extraction.product.description",
    });
  }

  const observedImages = product.images
    .map((image, index) => ({ image, index }))
    .slice(0, 10);
  if (observedImages.length > 0) {
    props.image = observedImages.map(({ image, index }) =>
      emit(properties, `image[${index}]`, {
        value: image.url,
        source: `extraction.product.images[${index}]`,
      }),
    );
  } else if (observations.image) {
    props.image = [emit(properties, "image[0]", observations.image)];
  }

  if (product.price) {
    const offer: Record<string, SchemaJson> = {
      "@type": "Offer",
      price: emit(properties, "offers.price", {
        value: product.price.value,
        source: "extraction.product.price",
      }),
      url: emit(properties, "offers.url", {
        value: observations.pageUrl,
        source: observations.input.canonicalUrl?.trim()
          ? "page.canonical_url"
          : "page.url",
      }),
    };
    if (product.currency) {
      offer.priceCurrency = emit(properties, "offers.priceCurrency", {
        value: product.currency.value,
        source: "extraction.product.currency",
      });
    }
    if (product.availability.from && product.availability.value !== "UNKNOWN") {
      offer.availability = emit(properties, "offers.availability", {
        value: product.availability.value,
        source: `extraction.product.availability (${product.availability.from})`,
      });
    }
    props.offers = offer;
  }

  return { props, properties };
}

function buildBreadcrumbList(
  observations: SchemaObservations,
): Draft | { reasons: string[] } {
  const trail = observedBreadcrumbTrail(observations);
  if (!trail) {
    return refusal(
      "No breadcrumb evidence (existing BreadcrumbList or category path)",
    );
  }
  const properties: ObservedProperty[] = [];
  const itemListElement = trail.value.map((entry, index) => {
    const item: Record<string, SchemaJson> = {
      "@type": "ListItem",
      position: index + 1,
    };
    item.name = emit(properties, `itemListElement[${index}].name`, {
      value: entry.name,
      source: `${trail.source}[${index}]`,
    });
    if (entry.item) {
      item.item = emit(properties, `itemListElement[${index}].item`, {
        value: entry.item,
        source: `${trail.source}[${index}]`,
      });
    }
    return item;
  });
  return { props: { itemListElement }, properties };
}

function buildArticle(
  observations: SchemaObservations,
): Draft | { reasons: string[] } {
  const blog = observations.blog;
  const headline = blog?.title
    ? {
        value: blog.title.value,
        source: "extraction.blog.title",
      }
    : observations.title;
  if (!headline) {
    return refusal("Article headline was not observed");
  }
  const properties: ObservedProperty[] = [];
  const props: Record<string, SchemaJson> = {
    headline: emit(properties, "headline", headline),
  };
  if (blog?.datePublished) {
    props.datePublished = emit(properties, "datePublished", {
      value: blog.datePublished.value,
      source: "extraction.blog.datePublished",
    });
  }
  if (blog?.dateModified) {
    props.dateModified = emit(properties, "dateModified", {
      value: blog.dateModified.value,
      source: "extraction.blog.dateModified",
    });
  }
  if (blog?.author) {
    props.author = {
      "@type": "Person",
      name: emit(properties, "author.name", {
        value: blog.author.value,
        source: "extraction.blog.author",
      }),
    };
  }
  if (observations.image) {
    props.image = [emit(properties, "image[0]", observations.image)];
  }
  if (observations.description) {
    props.description = emit(
      properties,
      "description",
      observations.description,
    );
  }
  return { props, properties };
}

function buildWebPage(
  observations: SchemaObservations,
): Draft | { reasons: string[] } {
  const ogTitle = observations.input.ogTitle
    ? { value: observations.input.ogTitle, source: "page.og_title" }
    : null;
  const name = observations.title ?? ogTitle;
  if (!name) {
    return refusal("Page title was not observed");
  }
  const properties: ObservedProperty[] = [];
  const props: Record<string, SchemaJson> = {
    name: emit(properties, "name", name),
    url: emit(properties, "url", {
      value: observations.pageUrl,
      source: observations.input.canonicalUrl?.trim()
        ? "page.canonical_url"
        : "page.url",
    }),
  };
  if (observations.description) {
    props.description = emit(
      properties,
      "description",
      observations.description,
    );
  }
  if (observations.image) {
    props.primaryImageOfPage = {
      "@type": "ImageObject",
      url: emit(properties, "primaryImageOfPage.url", observations.image),
    };
  }
  return { props, properties };
}

function buildWebSite(
  observations: SchemaObservations,
): Draft | { reasons: string[] } {
  const ogTitle = observations.input.ogTitle
    ? { value: observations.input.ogTitle, source: "page.og_title" }
    : null;
  const name = observations.title ?? ogTitle;
  let origin: string;
  try {
    origin = new URL(observations.pageUrl).origin;
  } catch {
    return refusal("Page URL is not absolute; site origin is unobservable");
  }
  const properties: ObservedProperty[] = [];
  const props: Record<string, SchemaJson> = {
    url: emit(properties, "url", {
      value: origin,
      source: "page.url.origin (derived)",
    }),
  };
  if (name) {
    props.name = emit(properties, "name", name);
  }
  return { props, properties };
}

const BUILDERS: Record<SchemaEntityType, Builder> = {
  Organization: (observations) =>
    existingTypeDraft(observations, "Organization"),
  LocalBusiness: (observations) =>
    existingTypeDraft(observations, "LocalBusiness"),
  Person: (observations) => existingTypeDraft(observations, "Person"),
  Event: (observations) => existingTypeDraft(observations, "Event"),
  Service: (observations) => existingTypeDraft(observations, "Service"),
  FAQPage: (observations) => existingTypeDraft(observations, "FAQPage"),
  Product: buildProduct,
  BreadcrumbList: buildBreadcrumbList,
  Article: buildArticle,
  BlogPosting: buildArticle,
  WebPage: buildWebPage,
  WebSite: buildWebSite,
};

/** Structured data is proposed only from complete, analyzed extractions. */
function extractionGate(input: SchemaPageInput): string[] {
  if (input.extractionState !== "STATIC_COMPLETE") {
    return [
      `Page extraction state is ${input.extractionState}; schema is proposed only from STATIC_COMPLETE pages`,
    ];
  }
  return [];
}

export function generateSchema(
  input: SchemaPageInput,
  type: SchemaEntityType,
): ProposalResult {
  const gateReasons = extractionGate(input);
  if (gateReasons.length > 0) {
    return { ok: false, type, reasons: gateReasons };
  }
  const observations = readSchemaObservations(input);
  const draft = BUILDERS[type](observations);
  if ("reasons" in draft) {
    return { ok: false, type, reasons: draft.reasons };
  }
  if (draft.properties.length === 0) {
    return {
      ok: false,
      type,
      reasons: [`No observed ${type} properties on this page`],
    };
  }

  const jsonLd: SchemaJsonObject = {
    "@context": SCHEMA_CONTEXT,
    "@type": type,
    ...draft.props,
  };
  const notes = [...observations.notes];
  if (type === "Product" && !draft.props.offers) {
    notes.push("No observed price; offers omitted");
  }
  return {
    ok: true,
    proposal: { type, jsonLd, properties: draft.properties, notes },
  };
}

/** Every supported type with its per-page availability verdict. */
export function proposeSchemaTypes(
  input: SchemaPageInput,
): Array<{ type: SchemaEntityType; ok: boolean; reasons: string[] }> {
  return SCHEMA_ENTITY_TYPES.map((type) => {
    const result = generateSchema(input, type);
    return result.ok
      ? { type, ok: true, reasons: [] }
      : { type, ok: false, reasons: result.reasons };
  });
}
