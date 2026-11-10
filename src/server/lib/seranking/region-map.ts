import { getIsoCountryCode } from "@/shared/keyword-locations";

/**
 * Maps OpenSEO / DataForSEO location codes or ISO codes to SE Ranking database `source` codes.
 * SE Ranking uses standard 2-letter country codes for regional databases.
 * Notice: UK is often "uk" or "gb" in different APIs; SE Ranking supports "uk" and "us".
 */
const SE_RANKING_REGION_OVERRIDES: Record<string, string> = {
  gb: "uk",
};

export function locationCodeToSeRankingSource(locationCode?: number | null): string {
  if (!locationCode) {
    return "us";
  }
  const iso = getIsoCountryCode(locationCode).toLowerCase();
  return SE_RANKING_REGION_OVERRIDES[iso] ?? iso;
}

export function countryCodeToSeRankingSource(countryCode?: string | null): string {
  if (!countryCode) {
    return "us";
  }
  const normalized = countryCode.trim().toLowerCase();
  return SE_RANKING_REGION_OVERRIDES[normalized] ?? normalized;
}

export function resolveSeRankingSource(params: {
  locationCode?: number | null;
  countryCode?: string | null;
}): string {
  if (params.locationCode) {
    return locationCodeToSeRankingSource(params.locationCode);
  }
  if (params.countryCode) {
    return countryCodeToSeRankingSource(params.countryCode);
  }
  return "us";
}
