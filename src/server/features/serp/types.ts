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
  /** Whether circuit-breaker protection was active for this provider call. */
  circuitBreakerEnabled?: boolean;
  /** 1-based attempt within this provider's retry sequence. */
  attempt?: number;
  /** Configured maximum additional retries for this provider (0-5). */
  maxRetries?: number;
  /** Whether the failure that ended this call is classified retryable. */
  retryable?: boolean;
  /** Provider-supplied Retry-After (bounded) in ms, when present. */
  retryAfterMs?: number | null;
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
    options: {
      deterministic?: boolean;
      /** Provider-supplied Retry-After wait in ms (already bounded), if any. */
      retryAfterMs?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "SerpProviderError";
    this.deterministic = options.deterministic ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }

  /** True when retrying the identical request can never succeed. */
  readonly deterministic: boolean;
  /** Provider-supplied Retry-After wait in ms (already bounded), if any. */
  readonly retryAfterMs: number | null;
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
