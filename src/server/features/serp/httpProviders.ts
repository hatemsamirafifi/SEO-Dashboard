/* eslint-disable eslint/max-lines */
import { z } from "zod";
import {
  assertNotCancelled,
  domainMatches,
  normalizedDomain,
  SerpProviderError,
  type NormalizedSerpResult,
  type SerpFeatureSet,
  type SerpProvider,
  type SerpProviderCall,
  type SerpProviderId,
  type SerpSearchInput,
} from "./types";
import { boundedRetryAfterMs } from "./retryPolicy";

const PAGE_SIZE = 10;

const organicItemSchema = z
  .object({
    position: z.number().int().positive(),
    title: z.string().nullable().optional(),
    link: z.string().url().optional(),
    url: z.string().url().optional(),
    snippet: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  })
  .passthrough();
const responseSchema = z
  .object({ organic: z.array(organicItemSchema) })
  .passthrough();

type HttpProviderOptions = {
  id: "serper" | "zenserp";
  apiKey: string;
  fetchFn?: typeof fetch;
};

function errorCode(
  status: number,
  body: string,
): { code: string; deterministic: boolean } {
  if (status === 401 || status === 403)
    return { code: "AUTH_FAILED", deterministic: true };
  if (
    status === 402 ||
    /quota|credit|exhaust|not enough credits|insufficient/i.test(body)
  ) {
    return { code: "QUOTA_EXHAUSTED", deterministic: true };
  }
  if (status === 429) return { code: "RATE_LIMITED", deterministic: false };
  if (status >= 500)
    return { code: "PROVIDER_UNAVAILABLE", deterministic: false };
  return { code: "INVALID_PROVIDER_RESPONSE", deterministic: false };
}

export function providerEndpoint(id: SerpProviderId) {
  return id === "dataforseo"
    ? "/v3/serp/google/organic/live/advanced"
    : id === "serper"
      ? "/search"
      : "/api/v2/search";
}

function failedCall(input: {
  id: "serper" | "zenserp";
  startedAt: number;
  status: number | null;
  code: string;
  requestedDepth: number;
  pageNumber: number;
}): SerpProviderCall {
  return {
    provider: input.id,
    endpoint: providerEndpoint(input.id),
    status: "failed",
    httpStatus: input.status,
    errorCode: input.code,
    durationMs: Date.now() - input.startedAt,
    resultCount: null,
    requestedDepth: input.requestedDepth,
    inspectedDepth: null,
    pagesRequested: input.pageNumber,
    resultCompleteness: "not_applicable",
    dispatched: true,
  };
}

function failure(input: {
  id: "serper" | "zenserp";
  priorCalls: SerpProviderCall[];
  startedAt: number;
  status: number | null;
  code: string;
  deterministic: boolean;
  requestedDepth: number;
  pageNumber: number;
  retryAfterMs?: number | null;
}): SerpProviderError {
  return new SerpProviderError(
    input.id,
    input.code,
    [
      ...input.priorCalls,
      failedCall({
        id: input.id,
        startedAt: input.startedAt,
        status: input.status,
        code: input.code,
        requestedDepth: input.requestedDepth,
        pageNumber: input.pageNumber,
      }),
    ],
    `${input.id === "serper" ? "Serper.dev" : "Zenserp"} request failed: ${input.code}`,
    {
      deterministic: input.deterministic,
      retryAfterMs: input.retryAfterMs ?? null,
    },
  );
}

function requestForPage(
  options: HttpProviderOptions,
  input: SerpSearchInput,
  pageNumber: number,
): [URL | string, RequestInit] {
  const offset = (pageNumber - 1) * PAGE_SIZE;
  if (options.id === "serper") {
    return [
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": options.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          q: input.keyword,
          gl: input.location.countryCode.toLowerCase(),
          hl: input.location.languageCode,
          location: input.location.locationName,
          num: PAGE_SIZE,
          page: pageNumber,
        }),
        signal: input.signal ?? AbortSignal.timeout(30_000),
      },
    ];
  }
  const params = new URLSearchParams({
    q: input.keyword,
    engine: "google",
    gl: input.location.countryCode.toLowerCase(),
    hl: input.location.languageCode,
    location: input.location.locationName,
    device: input.device,
    num: String(PAGE_SIZE),
    start: String(offset),
  });
  return [
    `https://app.zenserp.com/api/v2/search?${params.toString()}`,
    {
      headers: { apikey: options.apiKey, Accept: "application/json" },
      signal: input.signal ?? AbortSignal.timeout(30_000),
    },
  ];
}

function absolutePosition(rawPosition: number, pageNumber: number): number {
  const offset = (pageNumber - 1) * PAGE_SIZE;
  return rawPosition > offset ? rawPosition : offset + rawPosition;
}

type NormalizedOrganic = {
  position: number;
  title: string | null;
  url: string;
  domain: string;
  description: string | null;
};

function normalizeOrganic(
  parsed: z.infer<typeof responseSchema>,
  pageNumber: number,
): NormalizedOrganic[] {
  return parsed.organic.flatMap((item) => {
    const url = item.link ?? item.url;
    const domain = url ? normalizedDomain(url) : null;
    return url && domain
      ? [
          {
            position: absolutePosition(item.position, pageNumber),
            title: item.title ?? null,
            url,
            domain,
            description: item.snippet ?? item.description ?? null,
          },
        ]
      : [];
  });
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return typeof val === "object" && val !== null && !Array.isArray(val)
    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- guarded by typeof/null/isArray
      (val as Record<string, unknown>)
    : null;
}

function asString(val: unknown): string | null {
  return typeof val === "string" && val.trim().length > 0 ? val : null;
}

function extractObservedFeatures(raw: Record<string, unknown>): {
  features: SerpFeatureSet;
  familyNames: string[];
} {
  const features: SerpFeatureSet = {};
  const familyNames: string[] = [];

  const answerBox = asRecord(raw.answerBox ?? raw.answer_box);
  if (answerBox) {
    const title = asString(answerBox.title) ?? asString(answerBox.answer);
    const snippet =
      asString(answerBox.snippet) ?? asString(answerBox.answer) ?? "";
    const url = asString(answerBox.link ?? answerBox.url);
    if (title) {
      features.featuredResult = {
        title,
        url,
        domain: url ? normalizedDomain(url) : null,
        snippet,
      };
      familyNames.push("featured_snippet");
    }
  }

  const paaRaw = raw.peopleAlsoAsk ?? raw.people_also_ask ?? raw.questions;
  if (Array.isArray(paaRaw)) {
    const items = paaRaw.flatMap((entry) => {
      const rec = asRecord(entry);
      const question = rec
        ? (asString(rec.question) ?? asString(rec.title))
        : asString(entry);
      if (!question) return [];
      const url = rec ? asString(rec.link ?? rec.url) : null;
      return [{ question, url, placement: null }];
    });
    if (items.length > 0) {
      features.peopleAlsoAsk = { items };
      familyNames.push("people_also_ask");
    }
  }

  const relatedRaw = raw.relatedSearches ?? raw.related_searches;
  if (Array.isArray(relatedRaw)) {
    const items = relatedRaw.flatMap((entry) => {
      const rec = asRecord(entry);
      const query = rec
        ? (asString(rec.query) ?? asString(rec.title))
        : asString(entry);
      return query ? [query] : [];
    });
    if (items.length > 0) {
      features.relatedSearches = { items };
      familyNames.push("related_searches");
    }
  }

  const placesRaw = raw.places ?? raw.local_results ?? raw.maps_results;
  if (Array.isArray(placesRaw)) {
    const items = placesRaw.flatMap((entry) => {
      const rec = asRecord(entry);
      const title = rec ? asString(rec.title) : null;
      if (!rec || !title) return [];
      const url = asString(rec.website ?? rec.link ?? rec.url);
      const rating = typeof rec.rating === "number" ? rec.rating : null;
      const reviewCountRaw = rec.ratingCount ?? rec.reviews ?? rec.review_count;
      const reviewCount =
        typeof reviewCountRaw === "number" && Number.isInteger(reviewCountRaw)
          ? reviewCountRaw
          : null;
      return [
        {
          title,
          url,
          domain: url ? normalizedDomain(url) : null,
          address: asString(rec.address),
          rating,
          reviewCount,
        },
      ];
    });
    if (items.length > 0) {
      features.localPack = { items };
      familyNames.push("local_pack");
    }
  }

  const kg = asRecord(raw.knowledgeGraph ?? raw.knowledge_graph);
  if (kg) {
    const title = asString(kg.title);
    if (title) {
      const url = asString(kg.website ?? kg.descriptionLink ?? kg.url);
      features.knowledgeGraph = {
        title,
        url,
        domain: url ? normalizedDomain(url) : null,
        description: asString(kg.description),
      };
      familyNames.push("knowledge_graph");
    }
  }

  return { features, familyNames };
}

function result(input: {
  searchInput: SerpSearchInput;
  provider: "serper" | "zenserp";
  inspectedDepth: number;
  calls: SerpProviderCall[];
  match?: NormalizedOrganic;
  organic?: NormalizedOrganic[];
  observedFeatures?: SerpFeatureSet;
  serpFeatures?: string[];
}): NormalizedSerpResult {
  const topOrganic = (input.organic ?? []).slice(0, 10);
  const organicDescriptions: Record<number, string> = {};
  for (const entry of topOrganic) {
    if (entry.description) {
      organicDescriptions[entry.position] = entry.description;
    }
  }
  return {
    keywordId: input.searchInput.keywordId,
    keyword: input.searchInput.keyword,
    position: input.match?.position ?? null,
    url: input.match?.url ?? null,
    title: input.match?.title ?? null,
    domain: input.match?.domain ?? null,
    serpFeatures: input.serpFeatures ?? [],
    provider: input.provider,
    inspectedDepth: Math.min(input.searchInput.depth, input.inspectedDepth),
    calls: input.calls,
    organicResults: topOrganic.map((entry) => ({
      position: entry.position,
      title: entry.title,
      url: entry.url,
      domain: entry.domain,
      resultType: "organic",
      featureRefs: [],
    })),
    ...(Object.keys(organicDescriptions).length > 0
      ? { organicDescriptions }
      : {}),
    ...(input.observedFeatures && Object.keys(input.observedFeatures).length > 0
      ? { observedFeatures: input.observedFeatures }
      : {}),
  };
}

export function createHttpSerpProvider(
  options: HttpProviderOptions,
): SerpProvider {
  const fetchFn = options.fetchFn ?? fetch;
  return {
    id: options.id,
    // Serper does not document an equivalent desktop/mobile control. It is
    // therefore intentionally unsuitable for mobile rank checks.
    supports: (input) => options.id === "zenserp" || input.device === "desktop",
    async search(input): Promise<NormalizedSerpResult> {
      const requestedDepth = Math.min(100, Math.max(10, input.depth));
      const calls: SerpProviderCall[] = [];
      const pageFingerprints = new Set<string>();
      const collectedOrganic: NormalizedOrganic[] = [];
      let pageOneFeatures: SerpFeatureSet | undefined;
      let pageOneFeatureNames: string[] = [];
      let inspectedDepth = 0;
      let noProgressPages = 0;

      // One result per page is the conservative worst case. The no-progress
      // guard exits earlier when pagination repeats or stops yielding results.
      for (let pageNumber = 1; pageNumber <= requestedDepth; pageNumber++) {
        await assertNotCancelled(input);
        const startedAt = Date.now();
        let response: Response;
        try {
          const [url, init] = requestForPage(options, input, pageNumber);
          response = await fetchFn(url, init);
        } catch (error) {
          if (
            input.signal?.aborted ||
            (error instanceof Error && error.name === "AbortError")
          ) {
            throw error;
          }
          throw failure({
            id: options.id,
            priorCalls: calls,
            startedAt,
            status: null,
            code: "NETWORK_OR_TIMEOUT",
            deterministic: false,
            requestedDepth,
            pageNumber,
          });
        }

        const body = await response.text();
        if (!response.ok) {
          const classified = errorCode(response.status, body);
          throw failure({
            id: options.id,
            priorCalls: calls,
            startedAt,
            status: response.status,
            code: classified.code,
            deterministic: classified.deterministic,
            requestedDepth,
            pageNumber,
            // Respect a 429 Retry-After within a safe maximum (retryPolicy
            // owns the cap); RATE_LIMITED stays retryable.
            retryAfterMs:
              response.status === 429
                ? boundedRetryAfterMs(response.headers.get("retry-after"))
                : null,
          });
        }

        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          throw failure({
            id: options.id,
            priorCalls: calls,
            startedAt,
            status: response.status,
            code: "MALFORMED_JSON",
            deterministic: false,
            requestedDepth,
            pageNumber,
          });
        }
        const parsed = responseSchema.safeParse(json);
        if (!parsed.success) {
          throw failure({
            id: options.id,
            priorCalls: calls,
            startedAt,
            status: response.status,
            code: "INVALID_PROVIDER_RESPONSE",
            deterministic: false,
            requestedDepth,
            pageNumber,
          });
        }

        if (pageNumber === 1) {
          const extracted = extractObservedFeatures(parsed.data);
          pageOneFeatures = extracted.features;
          pageOneFeatureNames = extracted.familyNames;
        }

        const pageOrganic = normalizeOrganic(parsed.data, pageNumber);
        collectedOrganic.push(...pageOrganic);
        const fingerprint = pageOrganic
          .map((item) => item.url)
          .toSorted()
          .join("\n");
        const madeProgress =
          fingerprint.length > 0 && !pageFingerprints.has(fingerprint);
        noProgressPages = madeProgress ? 0 : noProgressPages + 1;
        if (fingerprint) pageFingerprints.add(fingerprint);
        inspectedDepth = Math.max(
          inspectedDepth,
          ...pageOrganic.map((item) => item.position),
        );
        const call: SerpProviderCall = {
          provider: options.id,
          endpoint: providerEndpoint(options.id),
          status: "success",
          httpStatus: response.status,
          errorCode: null,
          durationMs: Date.now() - startedAt,
          resultCount: pageOrganic.length,
          requestedDepth,
          inspectedDepth: Math.min(requestedDepth, inspectedDepth),
          pagesRequested: pageNumber,
          resultCompleteness: "partial",
          dispatched: true,
        };
        calls.push(call);

        const match = input.targetDomain
          ? pageOrganic.find(
              (item) =>
                item.position <= requestedDepth &&
                domainMatches(item.domain, input.targetDomain),
            )
          : undefined;
        if (match) {
          call.resultCompleteness = "target_found";
          return result({
            searchInput: input,
            provider: options.id,
            inspectedDepth,
            calls,
            match,
            organic: collectedOrganic,
            observedFeatures: pageOneFeatures,
            serpFeatures: pageOneFeatureNames,
          });
        }
        if (
          inspectedDepth >= requestedDepth ||
          (!input.targetDomain &&
            pageNumber === 1 &&
            requestedDepth <= PAGE_SIZE)
        ) {
          call.resultCompleteness = "complete";
          return result({
            searchInput: input,
            provider: options.id,
            inspectedDepth,
            calls,
            organic: collectedOrganic,
            observedFeatures: pageOneFeatures,
            serpFeatures: pageOneFeatureNames,
          });
        }
        if (noProgressPages >= 2) break;
      }

      const lastCall = calls.at(-1);
      if (lastCall) {
        lastCall.status = "insufficient_depth";
        lastCall.errorCode = "INSUFFICIENT_DEPTH";
        lastCall.resultCompleteness = "insufficient_depth";
      }
      throw new SerpProviderError(
        options.id,
        "INSUFFICIENT_DEPTH",
        calls,
        `${options.id === "serper" ? "Serper.dev" : "Zenserp"} could not inspect the requested ranking depth`,
      );
    },
  };
}
