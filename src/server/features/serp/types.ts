export type SerpProviderId = "dataforseo" | "serper" | "zenserp";
export type SerpDevice = "desktop" | "mobile";

export type SerpProviderSkipReason =
  | "DISABLED"
  | "MISSING_CREDENTIALS"
  | "CIRCUIT_OPEN"
  | "UNSUPPORTED_DEVICE"
  | "UNSUPPORTED_LOCATION"
  | "CANCELLED"
  | "INVALID_CONFIGURATION";

export type NormalizedSerpLocation = {
  countryCode: string;
  languageCode: string;
  locationName: string;
};

export type SerpSearchInput = {
  keywordId: string;
  keyword: string;
  targetDomain: string;
  location: NormalizedSerpLocation;
  device: SerpDevice;
  depth: number;
  signal?: AbortSignal;
  isCancelled?: () => Promise<boolean>;
};

export type SerpProviderCall = {
  provider: SerpProviderId;
  endpoint: string;
  status: "success" | "failed" | "insufficient_depth" | "skipped";
  httpStatus: number | null;
  errorCode: string | null;
  durationMs: number;
  resultCount: number | null;
  requestedDepth: number;
  inspectedDepth: number | null;
  pagesRequested: number;
  resultCompleteness:
    | "partial"
    | "complete"
    | "target_found"
    | "insufficient_depth"
    | "not_applicable";
  dispatched: boolean;
  skipReason?: SerpProviderSkipReason | null;
  circuitReason?: string | null;
  circuitOpenedAt?: string | null;
  circuitExpiresAt?: string | null;
};

export type NormalizedSerpResult = {
  keywordId: string;
  keyword: string;
  position: number | null;
  url: string | null;
  title: string | null;
  domain: string | null;
  serpFeatures: string[];
  provider: SerpProviderId;
  inspectedDepth: number;
  calls: SerpProviderCall[];
};

export class SerpProviderError extends Error {
  constructor(
    public readonly provider: SerpProviderId,
    public readonly code: string,
    public readonly calls: SerpProviderCall[],
    message: string,
    public readonly deterministic = false,
  ) {
    super(message);
    this.name = "SerpProviderError";
  }
}

export class SerpCancelledError extends Error {
  constructor(public readonly calls: SerpProviderCall[] = []) {
    super("Rank check cancelled");
    this.name = "AbortError";
  }
}

export interface SerpProvider {
  id: SerpProviderId;
  supports: (input: SerpSearchInput) => boolean;
  search: (input: SerpSearchInput) => Promise<NormalizedSerpResult>;
}

export async function assertNotCancelled(input: SerpSearchInput) {
  if (input.signal?.aborted || (await input.isCancelled?.())) {
    throw new SerpCancelledError();
  }
}

export function normalizedDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function domainMatches(candidate: string, target: string): boolean {
  const normalizedTarget = target.toLowerCase().replace(/^www\./, "");
  return (
    candidate === normalizedTarget || candidate.endsWith(`.${normalizedTarget}`)
  );
}
