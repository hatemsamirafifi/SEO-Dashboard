import type { googleAdsPlannerGroups } from "@/db/schema";
import type {
  GoogleAdsKeywordCompetition,
  GoogleAdsKeywordRecord,
} from "@/server/lib/googleAdsPlanner";
import { normalizeGoogleAdsCustomerId } from "@/shared/google-ads";

/** Typed model for the Google Ads Keyword Planner first-party repository.
 *
 *  The storage shape is Keyword Planner GROUP observations: one observation
 *  ledger row per (project, customer, data type, seed, market, network,
 *  contract), one canonical group row per keyword inside that scope, plus
 *  explicit variant memberships and explicit monthly histories. Reads
 *  rebuild faithful typed planner records — micros stay micros, close
 *  variants reattach, absent metrics stay null — never fabricated rows per
 *  variant.
 *
 *  Honesty rules (same basis as google-ads-planner schema): values are
 *  Google-native — money in micros of the account currency, the competition
 *  enum and its 0-100 index (NOT organic keyword difficulty); absent
 *  upstream metrics stay null; a month Google reported with no volume stays
 *  null; a REAL zero stays zero. `sourceFetchedAt` is only advanced by an
 *  actual fresh planner fetch — reads never refresh it.
 */

/** Everything that scopes a planner observation, all resolved server-side
 *  from the project's Ads connection (never from client input). */
export type GoogleAdsPlannerScope = {
  projectId: string;
  organizationId: string;
  /** 10-digit Ads customer id the data belongs to. */
  customerId: string;
  /** Manager id used as the login customer, when the connection rides a
   *  manager hierarchy. */
  loginCustomerId: string | null;
  /** Currency the money micros are denominated in. */
  currencyCode: string | null;
  locationCode: number;
  languageCode: string;
  network: string;
  contractVersion: string;
};

/** The keyword flows a planner observation was produced for. */
export type GoogleAdsPlannerDataType = "keyword_ideas" | "keyword_metrics";

export type GoogleAdsPlannerObservationInput = {
  scope: GoogleAdsPlannerScope;
  dataType: GoogleAdsPlannerDataType;
  /** Seed the ideas walk was seeded with; "" for keyword_metrics calls. */
  seedKeyword: string;
  /** The serving planner fetch timestamp this payload was produced at. */
  sourceFetchedAt: string;
  stats: {
    truncated: boolean;
    partial: boolean;
    malformedKeywordCount: number;
    duplicateKeywordCount: number;
    missingKeywordCount: number;
  };
  /** One record per canonical keyword group, exactly as parsed upstream. */
  records: GoogleAdsKeywordRecord[];
};

/** A stored planner record — a canonical keyword group plus provenance and
 *  the account currency the money fields are denominated in. */
export type GoogleAdsPlannerStoredGroup = {
  record: GoogleAdsKeywordRecord;
  sourceFetchedAt: string;
  currencyCode: string | null;
};

/** Match result for a keyword-list read: keywords that ARE canonical groups
 *  versus keywords that are only variant members of some canonical group. */
export type GoogleAdsPlannerKeywordMatches = {
  /** keyword -> the stored observation where this keyword is the canonical
   *  group. */
  canonical: Map<string, GoogleAdsPlannerStoredGroup>;
  /** variant keyword -> the canonical group whose estimate it shares. */
  variants: Map<string, GoogleAdsPlannerStoredGroup>;
};

/** A drizzle-selected google_ads_planner_groups row. */
export type GroupRow = typeof googleAdsPlannerGroups.$inferSelect;

export function normalizeKeywordText(value: string): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isoNow(): string {
  return new Date().toISOString();
}

/** Bounded chunks matching the D1 ~100-bound-parameter statement cap. */
export function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function normalizeCustomerId(value: string): string {
  const normalized = normalizeGoogleAdsCustomerId(value);
  if (!normalized) throw new Error("Invalid Google Ads customer id");
  return normalized;
}

/** The stored competition text is written from parsed planner payloads only,
 *  whose enum space is exactly LOW/MEDIUM/HIGH (UNSPECIFIED and UNKNOWN are
 *  mapped to null upstream). Reads narrow the column honestly instead of
 *  asserting a wider string onto the record's enum type; a stray value
 *  degrades to "no level reported" null, matching upstream semantics. */
export function competitionFromStored(
  value: string | null,
): GoogleAdsKeywordCompetition | null {
  return value === "LOW" || value === "MEDIUM" || value === "HIGH"
    ? value
    : null;
}
