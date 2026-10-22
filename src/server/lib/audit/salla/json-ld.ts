/**
 * Shared JSON-LD reading helpers.
 *
 * Structured-data payloads reach the extractors as parsed JSON (`unknown`),
 * so every read narrows through a real guard instead of a type assertion.
 * A JSON-LD node is a plain JSON object; arrays and primitives are
 * containers or scalars, never nodes.
 */

/** A plain JSON object — the shape every JSON-LD node has. */
export type JsonLdNode = Record<string, unknown>;

/** Narrow an unknown value to a plain JSON object (not null, not an array). */
export function isJsonLdNode(value: unknown): value is JsonLdNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `@type` values of a JSON-LD node. The string form is split on
 * whitespace ("Product Offer" is two types); the array form keeps its
 * entries verbatim.
 */
export function jsonLdTypeNames(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/);
  if (Array.isArray(value)) {
    const names: string[] = [];
    for (const item of value) {
      if (typeof item === "string") names.push(item);
    }
    return names;
  }
  return [];
}
