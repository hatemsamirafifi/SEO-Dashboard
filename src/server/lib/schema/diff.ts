/**
 * Existing-vs-proposed diff.
 *
 * Every proposed property is classified against the strongest existing
 * document of the same @type: kept (identical), changed (different value),
 * conflicting (the page's identity/URL disagrees) or added. Properties that
 * exist only in the current markup stay visible as existing_only so a
 * replacement never silently drops them.
 */
import { jsonLdTypeNames } from "../audit/salla/json-ld";
import type { JsonLdNode } from "../audit/salla/json-ld";
import { isSchemaEntityType } from "./types";
import type {
  DiffEntry,
  ObservedProperty,
  SchemaDiff,
  SchemaEntityType,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function documentType(node: JsonLdNode): SchemaEntityType | null {
  const type = jsonLdTypeNames(node["@type"])[0];
  return type && isSchemaEntityType(type) ? type : null;
}

const IDENTITY_PATHS = new Set(["url", "@id", "mainEntityOfPage"]);

export function diffSchema(
  existingNodes: JsonLdNode[],
  proposed: JsonLdNode,
  proposedProperties: ObservedProperty[] = [],
): SchemaDiff {
  const type = documentType(proposed);
  const matches = existingNodes.filter((node) => documentType(node) === type);
  const existing = matches[0] ?? null;
  const sourceByPath = new Map(
    proposedProperties.map((property) => [property.path, property.source]),
  );

  const entries: DiffEntry[] = [];
  const proposedProps = Object.entries(proposed).filter(
    ([key]) => key !== "@context" && key !== "@type",
  );
  for (const [key, proposedValue] of proposedProps) {
    const existingValue = existing?.[key];
    const source = sourceByPath.get(key) ?? null;
    if (existingValue === undefined) {
      entries.push({
        path: key,
        status: "added",
        existing: undefined,
        proposed: proposedValue,
        source,
      });
      continue;
    }
    if (stableStringify(existingValue) === stableStringify(proposedValue)) {
      entries.push({
        path: key,
        status: "kept",
        existing: existingValue,
        proposed: proposedValue,
        source,
      });
      continue;
    }
    entries.push({
      path: key,
      status: IDENTITY_PATHS.has(key) ? "conflicting" : "changed",
      existing: existingValue,
      proposed: proposedValue,
      source,
    });
  }

  if (existing) {
    for (const [key, existingValue] of Object.entries(existing)) {
      if (key === "@context" || key === "@type" || key === "@graph") continue;
      if (key in proposed) continue;
      entries.push({
        path: key,
        status: "existing_only",
        existing: existingValue,
        proposed: undefined,
        source: null,
      });
    }
  }

  const notes: string[] = [];
  if (!existing) {
    notes.push(`No existing ${type ?? "@type"} document to compare against`);
  } else if (matches.length > 1) {
    notes.push(
      `Compared against the first of ${matches.length} existing ${type} nodes`,
    );
  }
  return { entries, notes };
}
