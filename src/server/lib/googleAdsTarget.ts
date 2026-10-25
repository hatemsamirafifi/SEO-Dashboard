/** Google Ads geo / language targeting resolution (v26).
 *
 * Every shape here is pinned to the official v26 reference:
 *  - POST /v26/geoTargetConstants:suggest
 *    https://developers.google.com/google-ads/api/reference/rpc/v26/SuggestGeoTargetConstantsRequest
 *  - GeoTargetConstant (resource name, status, target type, ISO country code)
 *    https://developers.google.com/google-ads/api/reference/rpc/v26/GeoTargetConstant
 *  - GeoTargetConstantStatusEnum
 *    https://developers.google.com/google-ads/api/reference/enums/v26/GeoTargetConstantStatusEnum
 *  - language_constant fields
 *    https://developers.google.com/google-ads/api/fields/v26/language_constant
 *  - Published geo target constants (Target Type / Status values)
 *    https://developers.google.com/google-ads/api/data/geotargets
 *
 * Two rules shape this module:
 *  - DataForSEO country ids are NOT evidence of Google geo target constant
 *    ids. A Google constant is only ever resolved by name/country code
 *    through the documented suggest call.
 *  - An unknown or ambiguous target is rejected explicitly. Nothing is
 *    defaulted (never "United States", never "English").
 *
 * Like googleAdsPlanner, this module has no transport code: it builds
 * request bodies and parses payloads. The client owns the HTTP calls.
 * Upstream payloads are narrowed with Zod at the trust boundary.
 */
import { z } from "zod";

/** A Google geo target constant (a country, region, city, ...). */
export type GoogleAdsGeoTargetConstant = {
  /** Resource name, e.g. "geoTargetConstants/2840". */
  resourceName: string;
  /** Criteria id (protobuf int64, rendered as a string). */
  id: string;
  /** English name. */
  name: string;
  /** Fully qualified English name. */
  canonicalName: string | null;
  /** ISO-3166-1 alpha-2 country code associated with the target. */
  countryCode: string | null;
  /** Normalized target type, e.g. "COUNTRY". */
  targetType: string | null;
  /** Geo target constant status. */
  status: GoogleAdsGeoTargetConstantStatus;
};

export type GoogleAdsGeoTargetConstantStatus =
  | "ENABLED"
  | "REMOVAL_PLANNED"
  | "UNKNOWN"
  | "UNSPECIFIED";

/** A Google language constant. */
export type GoogleAdsLanguageConstant = {
  /** Resource name, e.g. "languageConstants/1000". */
  resourceName: string;
  /** Criteria id (protobuf int64, rendered as a string). */
  id: string;
  /** Language code, e.g. "en", "en_US", "pt-BR". */
  code: string;
  /** Full language name in English. */
  name: string;
  /** Whether the language can be targeted. */
  targetable: boolean;
};

export type GoogleAdsGeoTargetSuggestInput = {
  /** ISO-3166-1 alpha-2 country code, e.g. "US". */
  countryCode: string;
  /** Country name to look up, e.g. "United States". */
  countryName: string;
};

export type GoogleAdsLanguageConstantInput = {
  customerId: string;
  /** Language code to resolve, e.g. "en", "en_US", "pt-BR". */
  languageCode: string;
  /** Manager account used as the login customer, when authorized. */
  loginCustomerId?: string | null;
};

/** A validation or parse outcome. The client decides which error a failure
 *  becomes, so this module never throws its own error classes. */
export type GoogleAdsTargetParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

const COUNTRY_CODE_PATTERN = /^[A-Za-z]{2}$/;
/** The upstream rejects a location name above 300 characters
 *  (GeoTargetConstantSuggestionError.LOCATION_NAME_SIZE_LIMIT). */
const MAX_COUNTRY_NAME_LENGTH = 300;
/** A language code is a short tag, optionally with a region. It never
 *  contains quotes, spaces or punctuation, so it cannot break out of the
 *  GAQL string literal it is embedded in. */
const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(?:[_-][A-Za-z]{2,4})?$/;

const GEO_TARGET_CONSTANT_PATTERN = /^geoTargetConstants\/\d+$/;
const LANGUAGE_CONSTANT_PATTERN = /^languageConstants\/\d+$/;

const geoTargetStatusSchema = z.enum([
  "ENABLED",
  "REMOVAL_PLANNED",
  "UNKNOWN",
  "UNSPECIFIED",
]);

/** Narrowing schemas for the upstream payloads. */
const jsonObjectSchema = z.record(z.string(), z.unknown());
const unknownListSchema = z.array(z.unknown());
const int64Schema = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((value) => Number(value))
  .refine((value) => Number.isSafeInteger(value) && value >= 0);

function readObject(value: unknown): Record<string, unknown> | null {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** Normalizes the published target type spelling ("Country") to the enum-like
 *  form the rest of the boundary uses ("COUNTRY"). */
export function normalizeGeoTargetType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, "_").toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

/** The `geoTargetConstants:suggest` request body. */
export type GoogleAdsGeoTargetSuggestBody = {
  countryCode: string;
  locationNames: { names: string[] };
};

/** Builds the `geoTargetConstants:suggest` request body. */
export function buildGeoTargetSuggestRequest(
  input: GoogleAdsGeoTargetSuggestInput,
):
  | { ok: true; value: GoogleAdsGeoTargetSuggestBody }
  | { ok: false; reason: string } {
  if (
    typeof input.countryCode !== "string" ||
    !COUNTRY_CODE_PATTERN.test(input.countryCode)
  ) {
    return fail(
      "The Google Ads country code must be an ISO-3166-1 alpha-2 code such as US.",
    );
  }
  if (typeof input.countryName !== "string") {
    return fail("The Google Ads country name must be a string.");
  }
  const countryName = input.countryName.trim();
  if (countryName.length === 0) {
    return fail("The Google Ads country name must not be empty.");
  }
  if (countryName.length > MAX_COUNTRY_NAME_LENGTH) {
    return fail(
      `The Google Ads country name must be ${MAX_COUNTRY_NAME_LENGTH} characters or fewer.`,
    );
  }
  return {
    ok: true,
    value: {
      countryCode: input.countryCode.toUpperCase(),
      locationNames: { names: [countryName] },
    },
  };
}

function readOptionalString(value: unknown): string | null {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return null;
  const trimmed = parsed.data.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readInt64String(value: unknown): string | null {
  const parsed = int64Schema.safeParse(value);
  return parsed.success ? String(parsed.data) : null;
}

/** Parses a `geoTargetConstants:suggest` response. */
export function parseGeoTargetSuggestions(
  payload: unknown,
): GoogleAdsTargetParseResult<{
  constants: GoogleAdsGeoTargetConstant[];
  malformedSuggestions: number;
}> {
  const body = readObject(payload);
  if (!body) {
    return { ok: false, reason: "The geo target response was not an object." };
  }
  const suggestions = body.geoTargetConstantSuggestions;
  if (suggestions === undefined || suggestions === null) {
    return { ok: true, value: { constants: [], malformedSuggestions: 0 } };
  }
  const list = unknownListSchema.safeParse(suggestions);
  if (!list.success) {
    return {
      ok: false,
      reason: "The geo target suggestions were not a list.",
    };
  }
  const constants: GoogleAdsGeoTargetConstant[] = [];
  let malformedSuggestions = 0;
  for (const suggestion of list.data) {
    const wrapper = readObject(suggestion);
    const constant = wrapper ? readObject(wrapper.geoTargetConstant) : null;
    if (!constant) {
      malformedSuggestions += 1;
      continue;
    }
    const resourceName = readOptionalString(constant.resourceName);
    const id = readInt64String(constant.id);
    const name = readOptionalString(constant.name);
    const status = geoTargetStatusSchema.safeParse(constant.status);
    if (
      !resourceName ||
      !GEO_TARGET_CONSTANT_PATTERN.test(resourceName) ||
      !id ||
      !name ||
      !status.success
    ) {
      malformedSuggestions += 1;
      continue;
    }
    constants.push({
      resourceName,
      id,
      name,
      canonicalName: readOptionalString(constant.canonicalName),
      countryCode:
        readOptionalString(constant.countryCode)?.toUpperCase() ?? null,
      targetType: normalizeGeoTargetType(constant.targetType),
      status: status.data,
    });
  }
  return { ok: true, value: { constants, malformedSuggestions } };
}

/** Selects the one enabled country constant that matches the requested
 *  country. Zero matches and several matches are both rejected explicitly. */
export function selectCountryGeoTargetConstant(
  constants: GoogleAdsGeoTargetConstant[],
  requestedCountryCode: string,
):
  | { ok: true; value: GoogleAdsGeoTargetConstant }
  | { ok: false; reason: string } {
  const wanted = requestedCountryCode.toUpperCase();
  const matches = constants.filter(
    (constant) =>
      constant.status === "ENABLED" &&
      constant.targetType === "COUNTRY" &&
      constant.countryCode === wanted,
  );
  if (matches.length === 0) {
    return fail(
      `Google Ads returned no enabled country geo target constant for "${wanted}".`,
    );
  }
  if (matches.length > 1) {
    return fail(
      `Google Ads returned more than one enabled country geo target constant for "${wanted}".`,
    );
  }
  return { ok: true, value: matches[0] };
}

/** The fixed language-constant lookup. The language code is validated against
 *  a strict pattern before it is embedded, so it can never alter the query. */
export function buildLanguageConstantQuery(
  languageCode: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof languageCode !== "string") {
    return fail("The Google Ads language code must be a string.");
  }
  const code = languageCode.trim();
  if (!LANGUAGE_CODE_PATTERN.test(code)) {
    return fail(
      "The Google Ads language code must look like en, en_US or pt-BR.",
    );
  }
  return {
    ok: true,
    value: [
      "SELECT",
      "  language_constant.id,",
      "  language_constant.code,",
      "  language_constant.name,",
      "  language_constant.targetable",
      "FROM language_constant",
      `WHERE language_constant.code = '${code}'`,
    ].join("\n"),
  };
}

/** Parses a `language_constant` search response. */
export function parseLanguageConstants(
  payload: unknown,
): GoogleAdsTargetParseResult<{
  constants: GoogleAdsLanguageConstant[];
  malformedRows: number;
}> {
  const body = readObject(payload);
  if (!body) {
    return {
      ok: false,
      reason: "The language constant response was not an object.",
    };
  }
  const rows = body.results;
  if (rows === undefined || rows === null) {
    return { ok: true, value: { constants: [], malformedRows: 0 } };
  }
  const list = unknownListSchema.safeParse(rows);
  if (!list.success) {
    return {
      ok: false,
      reason: "The language constant results were not a list.",
    };
  }
  const constants: GoogleAdsLanguageConstant[] = [];
  let malformedRows = 0;
  for (const row of list.data) {
    const wrapper = readObject(row);
    const fields = wrapper ? readObject(wrapper.languageConstant) : null;
    if (!fields) {
      malformedRows += 1;
      continue;
    }
    const resourceName = readOptionalString(fields.resourceName);
    const id = readInt64String(fields.id);
    const code = readOptionalString(fields.code);
    const name = readOptionalString(fields.name);
    if (
      !resourceName ||
      !LANGUAGE_CONSTANT_PATTERN.test(resourceName) ||
      !id ||
      !code ||
      !name
    ) {
      malformedRows += 1;
      continue;
    }
    constants.push({
      resourceName,
      id,
      code,
      name,
      targetable: fields.targetable === true,
    });
  }
  return { ok: true, value: { constants, malformedRows } };
}

/** Selects the one targetable language constant for an exact language code.
 *  Unknown, ambiguous and non-targetable codes are rejected: Google would
 *  refuse a plan that targets a non-targetable language, so one can never be
 *  selected here (proto3 `bool` `targetable`; a field Google emits as absent
 *  or false is non-targetable). English is never assumed. */
export function selectLanguageConstant(
  constants: GoogleAdsLanguageConstant[],
  requestedCode: string,
):
  | { ok: true; value: GoogleAdsLanguageConstant }
  | { ok: false; reason: string } {
  const matches = constants.filter(
    (constant) => constant.code === requestedCode,
  );
  if (matches.length === 0) {
    return fail(
      `Google Ads returned no language constant for code "${requestedCode}".`,
    );
  }
  const targetable = matches.filter((constant) => constant.targetable);
  if (targetable.length === 0) {
    return fail(
      `Google Ads returned only non-targetable language constants for code "${requestedCode}".`,
    );
  }
  if (targetable.length === 1) return { ok: true, value: targetable[0] };
  return fail(
    `Google Ads returned more than one targetable language constant for code "${requestedCode}".`,
  );
}
