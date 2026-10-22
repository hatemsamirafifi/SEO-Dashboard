/**
 * Blog extraction (Phase 2, thin): Article/BlogPosting hints only.
 * Dates, author and headline come from structured data or equivalent meta
 * markup — no text-paragraph date mining, nothing fabricated.
 */
import type { CheerioAPI } from "cheerio";
import { isJsonLdNode } from "./json-ld";
import {
  collectJsonLdNodes,
  firstJsonString,
  mergeField,
  type Field,
  type SallaBlogExtraction,
  type SallaExtractionInput,
} from "./extraction";

function metaContent($: CheerioAPI, selector: string): string | null {
  const element = $(selector).first();
  return element.attr("content")?.trim() || null;
}

export function extractBlog(input: SallaExtractionInput): SallaBlogExtraction {
  const articleNode = input.structuredDataJson
    ? (collectJsonLdNodes(input.structuredDataJson, [
        "BlogPosting",
        "Article",
        "NewsArticle",
      ])[0] ?? null)
    : null;

  const structuredTitle = firstJsonString(articleNode?.headline);
  const structuredDatePublished =
    firstJsonString(articleNode?.datePublished) ??
    metaContent(input.$, 'meta[property="article:published_time"]');
  const structuredDateModified =
    firstJsonString(articleNode?.dateModified) ??
    metaContent(input.$, 'meta[property="article:modified_time"]');
  const structuredAuthor = ((): string | null => {
    const author = articleNode?.author;
    if (typeof author === "string") return author.trim() || null;
    if (!isJsonLdNode(author)) return null;
    return firstJsonString(author.name);
  })();

  const htmlTitle = ((): Field<string> | null => {
    const fromH1 = input.h1s.find((h1) => h1.trim().length > 0);
    const candidate = fromH1 ?? input.title;
    return candidate?.trim()
      ? {
          value: candidate.trim().slice(0, 200),
          from: "html",
        }
      : null;
  })();

  return {
    kind: "blog",
    title: mergeField(
      structuredTitle
        ? { value: structuredTitle.slice(0, 200), from: "structured-data" }
        : null,
      htmlTitle,
    ),
    datePublished: structuredDatePublished
      ? { value: structuredDatePublished.slice(0, 64), from: "structured-data" }
      : null,
    dateModified: structuredDateModified
      ? { value: structuredDateModified.slice(0, 64), from: "structured-data" }
      : null,
    author: structuredAuthor
      ? { value: structuredAuthor.slice(0, 200), from: "structured-data" }
      : null,
  };
}
