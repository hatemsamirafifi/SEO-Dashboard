/**
 * Product extraction (Phase 2 R1/R2/R9).
 *
 * Consumes the already-fetched page: the parsed JSON-LD payload, the loaded
 * fragment, visible text and internal links. Never fetches; never defaults.
 * Fields carry their evidence tier (structured-data > html per field, R2);
 * availability follows the R1 ladder with an explicit UNKNOWN fallback, and
 * the currency/price fields stay null without evidence. The URL-slug external
 * ID (R9) is always weak evidence.
 *
 * The reading helpers live in `product-extractor-helpers`; this module is the
 * pipeline that combines them into one evidence-shaped extraction.
 */
import type { CheerioAPI } from "cheerio";
import {
  collectJsonLdNodes,
  firstJsonString,
  mergeField,
  availabilityFromKeywords,
  type AvailabilityEvidence,
  type Field,
  type ProductImageEvidence,
  type ProductVariantEvidence,
  type SallaExtractionInput,
  type SallaProductExtraction,
} from "./extraction";
import { isJsonLdNode, type JsonLdNode } from "./json-ld";
import {
  addToCartDisabled,
  brandName,
  clamp,
  htmlGalleryImages,
  htmlPrice,
  imagesFromJsonLd,
  MAX_TEXT,
  offerCandidate,
  offersOf,
  round2,
  slugExternalId,
  stockFromDataAttr,
  stringField,
  stringFromH1,
  structuredDomAvailability,
  structuredDomPrice,
  type OfferCandidate,
} from "./product-extractor-helpers";

type ProductStructuredFields = Pick<
  SallaProductExtraction,
  | "name"
  | "sku"
  | "mpn"
  | "brand"
  | "description"
  | "price"
  | "priceRaw"
  | "currency"
>;

/**
 * Prefer a plain Offer over aggregate data: the first candidate is a
 * documented deterministic pick when several exist.
 */
function pickStructuredPrice(
  productOffers: JsonLdNode[],
): OfferCandidate | null {
  let structuredPrice: OfferCandidate | null = null;
  for (const offer of productOffers) {
    const candidate = offerCandidate(offer);
    if (!candidate) continue;
    structuredPrice = candidate;
    if (structuredPrice.kind === "Offer") break;
  }
  return structuredPrice;
}

function structuredFields(
  productNode: JsonLdNode | null,
  structuredPrice: OfferCandidate | null,
): ProductStructuredFields {
  return {
    name: stringField(
      clamp(firstJsonString(productNode?.name), MAX_TEXT.name),
      "structured-data",
    ),
    sku: stringField(
      clamp(firstJsonString(productNode?.sku), MAX_TEXT.identifier),
      "structured-data",
    ),
    mpn: stringField(
      clamp(firstJsonString(productNode?.mpn), MAX_TEXT.identifier),
      "structured-data",
    ),
    brand: stringField(
      clamp(brandName(productNode?.brand), MAX_TEXT.identifier),
      "structured-data",
    ),
    description: stringField(
      clamp(firstJsonString(productNode?.description), MAX_TEXT.description),
      "structured-data",
    ),
    price:
      structuredPrice?.price != null
        ? { value: structuredPrice.price, from: "structured-data" }
        : null,
    priceRaw: structuredPrice?.priceRaw
      ? { value: structuredPrice.priceRaw, from: "structured-data" }
      : null,
    currency: stringField(structuredPrice?.currency ?? null, "structured-data"),
  };
}

/** Gallery images, JSON-LD first: membership decides the evidence tier. */
function productImages(
  $: CheerioAPI,
  productNode: JsonLdNode | null,
  pageUrl: string,
): ProductImageEvidence[] {
  const ldImages = productNode
    ? imagesFromJsonLd(productNode.image, pageUrl)
    : [];
  const images: ProductImageEvidence[] = [];
  const seenImages = new Set<string>();
  for (const image of [...ldImages, ...htmlGalleryImages($, pageUrl)]) {
    if (seenImages.has(image.url)) continue;
    seenImages.add(image.url);
    // ldImages precede gallery URLs, so membership decides the tier.
    const from = ldImages.includes(image) ? "structured-data" : "html";
    images.push({ ...image, from });
    if (images.length >= 20) break;
  }
  return images;
}

/**
 * The price and availability a single variant offers. Variant payloads come
 * exclusively from JSON-LD, so everything they yield is structured-data tier.
 */
function variantOfferEvidence(variant: JsonLdNode): {
  price: Field<number> | null;
  availability: AvailabilityEvidence | null;
} {
  let price: Field<number> | null = null;
  let availability: AvailabilityEvidence | null = null;
  for (const offer of offersOf(variant)) {
    const candidate = offerCandidate(offer);
    if (!candidate) continue;
    if (price === null && candidate.price !== null) {
      price = { value: candidate.price, from: "structured-data" };
    }
    if (availability === null && candidate.availability) {
      availability = candidate.availability;
    }
  }
  return { price, availability };
}

/** Variants: JSON-LD hasVariant only; options carry no guessed values. */
function productVariants(
  productNode: JsonLdNode | null,
  basePrice: number | null,
): ProductVariantEvidence[] {
  const variants: ProductVariantEvidence[] = [];
  const hasVariantRaw = productNode?.hasVariant;
  const variantNodes = Array.isArray(hasVariantRaw)
    ? hasVariantRaw
    : hasVariantRaw
      ? [hasVariantRaw]
      : [];
  for (const rawVariant of variantNodes) {
    if (variants.length >= 20) break;
    if (!isJsonLdNode(rawVariant)) continue;
    const { price, availability } = variantOfferEvidence(rawVariant);
    variants.push({
      name: stringField(
        clamp(firstJsonString(rawVariant.name), MAX_TEXT.name),
        "structured-data",
      ),
      sku: stringField(
        clamp(firstJsonString(rawVariant.sku), MAX_TEXT.identifier),
        "structured-data",
      ),
      price,
      priceDelta:
        price && basePrice !== null
          ? {
              value: round2(price.value - basePrice),
              from: price.from,
            }
          : null,
      availability,
    });
  }
  return variants;
}

/** Stock evidence read from a `data-stock` attribute. */
function dataStockAvailability($: CheerioAPI): AvailabilityEvidence | null {
  const dataStock = $("[data-stock]").first().attr("data-stock");
  if (dataStock === undefined) return null;
  const mapped = stockFromDataAttr(dataStock);
  return mapped ? { value: mapped, from: "html" } : null;
}

/** DOM-tier availability, strongest marker first. */
function domAvailability($: CheerioAPI): AvailabilityEvidence | null {
  const disabledAvailability: AvailabilityEvidence | null = addToCartDisabled($)
    ? { value: "OutOfStock", from: "html" }
    : null;
  return (
    structuredDomAvailability($) ??
    dataStockAvailability($) ??
    disabledAvailability
  );
}

/** R1 availability ladder: strongest structured evidence first. */
function productAvailability(
  $: CheerioAPI,
  productOffers: JsonLdNode[],
  bodyText: string,
): AvailabilityEvidence {
  const ldAvailability = productOffers
    .map(offerCandidate)
    .find((candidate) => candidate?.availability)?.availability;
  return (
    ldAvailability ??
    domAvailability($) ??
    availabilityFromKeywords(bodyText) ?? { value: "UNKNOWN", from: null }
  );
}

export function extractProduct(
  input: SallaExtractionInput,
): SallaProductExtraction {
  const { structuredDataJson, pageUrl, bodyText } = input;
  const productNode = structuredDataJson
    ? (collectJsonLdNodes(structuredDataJson, ["Product"])[0] ?? null)
    : null;
  const productOffers = productNode ? offersOf(productNode) : [];
  const structuredPrice = pickStructuredPrice(productOffers);
  const fields = structuredFields(productNode, structuredPrice);

  const html = htmlPrice(input.$);
  const domStructured = structuredDomPrice(input.$);

  const price = mergeField(
    mergeField(fields.price, domStructured.price),
    html.price,
  );
  const priceRaw = mergeField(
    mergeField(fields.priceRaw, domStructured.priceRaw),
    html.priceRaw,
  );
  const currency = mergeField(
    mergeField(fields.currency, domStructured.currency),
    html.currency,
  );

  return {
    kind: "product",
    name: fields.name ?? stringFromH1(input),
    sku: fields.sku,
    mpn: fields.mpn,
    brand: fields.brand,
    description: fields.description,
    price,
    priceRaw,
    compareAtPrice: html.compareAtPrice,
    compareAtPriceRaw: html.compareAtPriceRaw,
    currency,
    availability: productAvailability(input.$, productOffers, bodyText),
    externalId: slugExternalId(pageUrl),
    images: productImages(input.$, productNode, pageUrl),
    variants: productVariants(productNode, price?.value ?? null),
  };
}
