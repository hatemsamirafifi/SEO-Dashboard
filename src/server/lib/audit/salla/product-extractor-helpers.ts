/**
 * Product extraction helpers (Phase 2 R1/R2/R9).
 *
 * The reading side of the product extractor: JSON-LD offer parsing, DOM
 * price/availability markers, gallery images and the URL-slug external ID.
 * Split out of `product-extractor` so the extractor itself reads as a short
 * pipeline and every helper stays readable on its own.
 */
import type { CheerioAPI } from "cheerio";
import { normalizeUrl } from "../url-utils";
import {
  firstJsonString,
  mapSchemaAvailability,
  type AvailabilityEvidence,
  type AvailabilityValue,
  type ExternalIdEvidence,
  type Field,
  type SallaExtractionInput,
} from "./extraction";
import { isJsonLdNode, type JsonLdNode } from "./json-ld";

/** Text-size caps keep a bloated page from dominating the payload. */
export const MAX_TEXT = {
  name: 200,
  identifier: 100,
  description: 1_500,
  priceRaw: 50,
};

export function clamp(value: string | null, limit: number): string | null {
  return value ? value.slice(0, limit) : null;
}

export function stringField(
  value: string | null,
  from: "structured-data" | "html",
): Field<string> | null {
  return value ? { value, from } : null;
}

/**
 * Parse a price-ish value. Accepts schema.org numbers ("149.99"), currency
 * prefixes ("SAR 149.99"), thousands grouping ("1,234.56" / "1.234,56") and
 * trailing separators ("149.99,"), common in Salla price markup.
 */
function parsePriceNumber(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[^\d.,]/g, "");
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized: string;
  if (lastComma > lastDot) {
    // The trailing group separator is the decimal mark (Arabic/SA convention:
    // "1.234,56"); everything before it groups thousands.
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = cleaned.replace(/,/g, "");
  }
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export interface OfferCandidate {
  price: number | null;
  priceRaw: string | null;
  currency: string | null;
  availability: AvailabilityEvidence | null;
  kind: "Offer" | "AggregateOffer";
}

export function offersOf(node: JsonLdNode): JsonLdNode[] {
  const offers = node.offers;
  if (Array.isArray(offers)) {
    const list: JsonLdNode[] = [];
    for (const offer of offers) {
      if (isJsonLdNode(offer)) list.push(offer);
    }
    return list;
  }
  return isJsonLdNode(offers) ? [offers] : [];
}

export function offerCandidate(offer: JsonLdNode): OfferCandidate | null {
  const type = offer["@type"];
  const kind: OfferCandidate["kind"] | null =
    type === "Offer"
      ? "Offer"
      : type === "AggregateOffer"
        ? "AggregateOffer"
        : null;
  if (!kind) return null;
  const priceRawValue =
    firstJsonString(offer.price) ??
    (typeof offer.price === "number" && Number.isFinite(offer.price)
      ? String(offer.price)
      : null);
  const price = parsePriceNumber(offer.price);
  // An Offer with no parsable price is still evidence for currency/stock.
  const lowPrice = parsePriceNumber(offer.lowPrice);
  if (price === null && lowPrice === null && !priceRawValue) {
    if (!firstJsonString(offer.priceCurrency) && !offer.availability) {
      return null;
    }
  }
  const availabilityRaw = firstJsonString(offer.availability);
  const mapped = availabilityRaw
    ? mapSchemaAvailability(availabilityRaw)
    : null;
  return {
    price: price ?? (kind === "AggregateOffer" ? lowPrice : null),
    priceRaw: clamp(priceRawValue, MAX_TEXT.priceRaw),
    currency: clamp(firstJsonString(offer.priceCurrency), MAX_TEXT.identifier),
    availability: mapped ? { value: mapped, from: "structured-data" } : null,
    kind,
  };
}

export function brandName(value: unknown): string | null {
  const obj = isJsonLdNode(value) ? value : null;
  const name = obj ? firstJsonString(obj.name) : null;
  return name ?? firstJsonString(value);
}

export function imagesFromJsonLd(
  value: unknown,
  pageUrl: string,
): Array<{ url: string; alt: string | null }> {
  const urls: string[] = [];
  const visitImageValue = (item: unknown): void => {
    if (typeof item === "string") {
      urls.push(item);
      return;
    }
    if (!isJsonLdNode(item)) return;
    const url = item.url ?? item.contentUrl;
    if (typeof url === "string") urls.push(url);
  };
  if (Array.isArray(value)) {
    for (const item of value) visitImageValue(item);
  } else {
    visitImageValue(value);
  }
  return urls
    .map((raw) => normalizeUrl(raw, pageUrl))
    .filter((url): url is string => !!url)
    .slice(0, 20)
    .map((url) => ({ url: url.slice(0, 1024), alt: null }));
}

/** Same bounded marker set as the analyzer's affordance check; duplicated
 * here rather than imported to keep the page-analyzer↔salla cycle clean. */
const ADD_TO_CART_SELECTORS =
  "[data-add-to-cart], button[name=add], input[name=add], " +
  'form[action*="cart"] button[type=submit], .add-to-cart, #add-to-cart';

export function structuredDomAvailability(
  $: CheerioAPI,
): AvailabilityEvidence | null {
  const values: string[] = [];
  $('meta[property="product:availability"]').each((_, el) => {
    const content = $(el).attr("content");
    if (content) values.push(content);
  });
  $("[itemprop=availability]").each((_, el) => {
    const element = $(el);
    values.push(
      element.attr("href") ?? element.attr("content") ?? element.text().trim(),
    );
  });
  for (const value of values) {
    const mapped = mapSchemaAvailability(value);
    if (mapped) return { value: mapped, from: "structured-data" };
  }
  return null;
}

export function stockFromDataAttr(value: string): AvailabilityValue | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (/^\d+$/.test(v)) {
    return Number(v) > 0 ? "InStock" : "OutOfStock";
  }
  if (/out[_ -]?of[_ -]?stock|sold[_ -]?out/.test(v)) return "OutOfStock";
  if (/in[_ -]?stock|available/.test(v)) return "InStock";
  if (/pre[_ -]?order|^pre$|^pre\b/.test(v)) return "PreOrder";
  if (/back[_ -]?order/.test(v)) return "OnBackorder";
  return null;
}

/** A disabled or aria-disabled add-to-cart control is an out-of-stock hint. */
export function addToCartDisabled($: CheerioAPI): boolean {
  let disabled = false;
  $(ADD_TO_CART_SELECTORS).each((_, el) => {
    if (disabled) return;
    const element = $(el);
    const attr = element.attr("disabled") ?? element.attr("aria-disabled");
    if (attr !== undefined && attr.toLowerCase() !== "false") disabled = true;
  });
  return disabled;
}

export function structuredDomPrice($: CheerioAPI): {
  price: Field<number> | null;
  priceRaw: Field<string> | null;
  currency: Field<string> | null;
} {
  let raw: string | null = null;
  $('meta[property="product:price:amount"], [itemprop=price]').each((_, el) => {
    if (raw) return;
    const element = $(el);
    raw = element.attr("content") ?? element.text().trim();
  });
  let currency: string | null = null;
  $('meta[property="product:price:currency"], [itemprop=priceCurrency]').each(
    (_, el) => {
      if (currency) return;
      currency = $(el).attr("content")?.trim() ?? null;
    },
  );
  const price = parsePriceNumber(raw);
  const priceRaw = clamp(raw, MAX_TEXT.priceRaw);
  return {
    price: price !== null ? { value: price, from: "structured-data" } : null,
    priceRaw: priceRaw ? { value: priceRaw, from: "structured-data" } : null,
    currency: stringField(
      clamp(currency, MAX_TEXT.identifier),
      "structured-data",
    ),
  };
}

export function htmlPrice($: CheerioAPI): {
  price: Field<number> | null;
  priceRaw: Field<string> | null;
  compareAtPrice: Field<number> | null;
  compareAtPriceRaw: Field<string> | null;
  currency: Field<string> | null;
} {
  let raw: string | null = null;
  const dataPrice = $("[data-price]").first().attr("data-price");
  if (dataPrice?.trim()) {
    raw = dataPrice.trim();
  } else {
    const text = $(".product-price .price:not(del):not(s)")
      .first()
      .text()
      .trim();
    raw = text || null;
  }
  let compareRaw: string | null = null;
  const dataOldPrice = $("[data-old-price]").first().attr("data-old-price");
  if (dataOldPrice?.trim()) {
    compareRaw = dataOldPrice.trim();
  } else {
    const del = $(".product-price del, .product-price s, .price-old").first();
    const text = del.text().trim();
    compareRaw = text || null;
  }
  const price = parsePriceNumber(raw);
  const comparePrice = parsePriceNumber(compareRaw);
  return {
    price: price !== null ? { value: price, from: "html" } : null,
    priceRaw: raw
      ? { value: raw.slice(0, MAX_TEXT.priceRaw), from: "html" }
      : null,
    compareAtPrice:
      comparePrice !== null ? { value: comparePrice, from: "html" } : null,
    compareAtPriceRaw: compareRaw
      ? { value: compareRaw.slice(0, MAX_TEXT.priceRaw), from: "html" }
      : null,
    currency: (() => {
      const dataCurrency = $("[data-currency]").first().attr("data-currency");
      return dataCurrency?.trim()
        ? {
            value: dataCurrency.trim().slice(0, MAX_TEXT.identifier),
            from: "html",
          }
        : null;
    })(),
  };
}

export function htmlGalleryImages(
  $: CheerioAPI,
  pageUrl: string,
): Array<{ url: string; alt: string | null }> {
  const images: Array<{ url: string; alt: string | null }> = [];
  const selector =
    ".product-gallery img, [data-gallery] img, .product-images img, [data-slider] img";
  $(selector).each((_, el) => {
    if (images.length >= 20) return;
    const element = $(el);
    const src = element.attr("src") ?? element.attr("data-src");
    if (!src) return;
    const baseHref = $("base[href]").first().attr("href") ?? pageUrl;
    const url = normalizeUrl(src, baseHref);
    if (!url) return;
    images.push({
      url: url.slice(0, 1024),
      alt: element.attr("alt")?.trim() || null,
    });
  });
  return images;
}

export function slugExternalId(pageUrl: string): ExternalIdEvidence | null {
  // Salla slugs end in "-<productId>" (e.g. /product/berber-rug-23815);
  // a trailing numeric run is the only honest read, and even that is weak
  // evidence per R9 — matched, never trusted.
  let pathname = pageUrl;
  try {
    pathname = new URL(pageUrl).pathname;
  } catch {
    return null;
  }
  const match = pathname.match(/-(\d+)\/?$/);
  return match ? { value: match[1], weak: true } : null;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Product name has no HTML-tier fallback other than the first h1. */
export function stringFromH1(
  input: SallaExtractionInput,
): Field<string> | null {
  const first = input.h1s.find((h1) => h1.trim().length > 0);
  return first
    ? { value: first.trim().slice(0, MAX_TEXT.name), from: "html" }
    : null;
}
