/**
 * Evidence-scored e-commerce platform detection for audit pages.
 *
 * Never hostname-only: every detection must be backed by page-level evidence
 * (meta generator, platform asset/script hosts, platform JS globals, URL
 * patterns, or response headers). Each source contributes a bounded weight —
 * at most one evidence entry per source — and the detection confirms once the
 * accumulated confidence reaches the threshold. Anything below it stays
 * undetected rather than guessed, and no single weak signal (such as a URL
 * path) can confirm a platform on its own.
 */

export type PlatformName = "salla";

type PlatformEvidenceSource =
  | "generator_meta"
  | "asset_host"
  | "global_object"
  | "url_pattern"
  | "response_header";

export interface PlatformEvidence {
  source: PlatformEvidenceSource;
  /** What matched: the host, header name, generator value, or path. */
  detail: string;
}

export interface PlatformDetection {
  platform: PlatformName | null;
  /** 0..1, capped; only populated alongside evidence. */
  confidence: number;
  evidence: PlatformEvidence[];
}

interface PlatformProfile {
  platform: PlatformName;
  weights: Record<PlatformEvidenceSource, number>;
  /** Matched against the content of <meta name="generator">. */
  generator: RegExp;
  /** Matched anywhere against the HTML body (script/link/src/reference). */
  assetHost: RegExp;
  /** Matched against the HTML body (inline scripts and SDK usage). */
  globals: RegExp;
  /** Matched against the URL path of the page itself. */
  urlPattern: RegExp;
  /** Response header keys (lowercased) that count as evidence. */
  headerPrefixes: string[];
}

export const PLATFORM_CONFIDENCE_THRESHOLD = 0.75;

/**
 * Platform signals (generator meta, SDK inclusion scripts) sit in the
 * document head and early body. Bounding the scan keeps per-page detection
 * cost constant on very large documents; deeper body evidence is not
 * required for a confident detection.
 */
const SCAN_CHARS = 256 * 1024;

const SALLA_PROFILE: PlatformProfile = {
  platform: "salla",
  weights: {
    generator_meta: 0.8,
    asset_host: 0.6,
    response_header: 0.7,
    global_object: 0.4,
    url_pattern: 0.2,
  },
  // Generator values seen on Salla-hosted stores, e.g. "Salla E-Commerce".
  generator: /\bsalla\b/i,
  // Platform-owned hosts referenced from page markup, e.g. cdn.salla.network,
  // merchant storefront script bundles on *.salla.sa. The pattern is anchored
  // on the literal marker so scans stay linear even over very large
  // documents; host labels are diagnostics, not the evidence itself.
  assetHost: /\bsalla\.(?:sa|app|network|dev|io)\b/i,
  // Salla JS SDK usage: window.salla, salla.init/event/cart/config/theme.
  globals:
    /\b(?:window\.)?salla\.(?:init|config|event|cart|product|theme|render)\b/,
  // Storefront route shapes: product detail, category grids, blog, checkout.
  urlPattern: /(?:^|\/)(?:product|category|blog|checkout)(?:\/|$)/i,
  headerPrefixes: ["x-salla", "salla"],
};

const PROFILES: PlatformProfile[] = [SALLA_PROFILE];

const META_TAG_PATTERN = /<meta\b[^>]*>/gi;
const GENERATOR_NAME_PATTERN = /\bname\s*=\s*["']generator["']/i;
const META_CONTENT_PATTERN = /\bcontent\s*=\s*["']([^"']*)["']/i;

function generatorEvidence(
  html: string,
  profile: PlatformProfile,
): string | null {
  META_TAG_PATTERN.lastIndex = 0;
  const tags = html.match(META_TAG_PATTERN) ?? [];
  for (const tag of tags) {
    if (!GENERATOR_NAME_PATTERN.test(tag)) continue;
    const content = META_CONTENT_PATTERN.exec(tag)?.[1] ?? "";
    if (profile.generator.test(content)) return content.trim();
  }
  return null;
}

function assetHostEvidence(
  html: string,
  profile: PlatformProfile,
): string | null {
  const match = profile.assetHost.exec(html);
  if (!match) return null;
  // Evidence details are diagnostics: never mirror an arbitrary-length
  // portion of the source document into the persisted row.
  return match[0].slice(0, 100);
}

function globalEvidence(html: string, profile: PlatformProfile): string | null {
  const match = profile.globals.exec(html);
  return match ? match[0] : null;
}

function urlPatternEvidence(
  url: string,
  profile: PlatformProfile,
): string | null {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Keep the raw URL; the pattern still applies.
  }
  const match = profile.urlPattern.exec(path);
  return match ? match[0] : null;
}

function headerEvidence(
  headers: Record<string, string>,
  profile: PlatformProfile,
): string | null {
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (profile.headerPrefixes.some((p) => lower.startsWith(p))) {
      return key;
    }
  }
  return null;
}

export function detectPlatform(input: {
  html?: string | null;
  url: string;
  headers?: Record<string, string>;
}): PlatformDetection {
  const origins: Array<{
    platform: PlatformName;
    confidence: number;
    evidence: PlatformEvidence[];
  }> = [];

  // Platform evidence lives near the top of the document (see SCAN_CHARS).
  const html = input.html ? input.html.slice(0, SCAN_CHARS) : null;

  for (const profile of PROFILES) {
    const evidence: PlatformEvidence[] = [];
    if (html) {
      const generator = generatorEvidence(html, profile);
      if (generator) {
        evidence.push({
          source: "generator_meta",
          detail: generator,
        });
      }
      const asset = assetHostEvidence(html, profile);
      if (asset) {
        evidence.push({ source: "asset_host", detail: asset });
      }
      const globalObj = globalEvidence(html, profile);
      if (globalObj) {
        evidence.push({ source: "global_object", detail: globalObj });
      }
    }
    const urlPattern = urlPatternEvidence(input.url, profile);
    if (urlPattern) {
      evidence.push({ source: "url_pattern", detail: urlPattern });
    }
    if (input.headers) {
      const header = headerEvidence(input.headers, profile);
      if (header) {
        evidence.push({ source: "response_header", detail: header });
      }
    }

    if (evidence.length === 0) continue;
    const confidence = Math.min(
      1,
      evidence.reduce((total, item) => total + profile.weights[item.source], 0),
    );
    origins.push({
      platform: profile.platform,
      confidence,
      evidence,
    });
  }

  const best = origins.toSorted((a, b) => b.confidence - a.confidence)[0];
  if (!best || best.confidence < PLATFORM_CONFIDENCE_THRESHOLD) {
    return { platform: null, confidence: 0, evidence: [] };
  }
  return best;
}
