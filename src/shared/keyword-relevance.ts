import type { KeywordResearchRow } from "@/types/keywords";

export type KeywordMatchType = "exact" | "phrase" | "partial" | "related";
export type KeywordRelevanceTier = "high" | "medium" | "low";
export type KeywordScriptKind = "arabic" | "latin" | "mixed" | "other";

export type KeywordRelevanceAssessment = {
  matchType: KeywordMatchType;
  relevanceScore: number;
  relevanceTier: KeywordRelevanceTier;
  isWeaklyRelated: boolean;
  scriptKind: KeywordScriptKind;
};

const ARABIC_CHAR_REGEX = /[\u0600-\u06FF]/;
const LATIN_CHAR_REGEX = /[a-zA-Z]/;
const ARABIC_DIACRITICS_REGEX = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
const ARABIC_ALEF_VARIANTS_REGEX = /[\u0622\u0623\u0625\u0671]/g;

const ARABIC_STOPWORDS = new Set([
  "في",
  "من",
  "على",
  "الى",
  "إلى",
  "عن",
  "مع",
  "هذا",
  "هذه",
  "او",
  "أو",
  "و",
  "ال",
]);

/**
 * Normalize Arabic and Latin text for deterministic keyword comparison while
 * callers keep the original keyword string for display.
 */
export function normalizeArabicKeyword(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(ARABIC_DIACRITICS_REGEX, "")
    .replace(ARABIC_ALEF_VARIANTS_REGEX, "\u0627") // ا
    .replace(/\u0649/g, "\u064A") // ى -> ي
    .replace(/\u0629/g, "\u0647") // ة -> ه
    .replace(/\s+/g, " ");
}

export function isExactKeywordMatch(
  candidate: string,
  seedKeyword: string,
): boolean {
  const normCandidate = normalizeArabicKeyword(candidate);
  const normSeed = normalizeArabicKeyword(seedKeyword);
  return normCandidate.length > 0 && normCandidate === normSeed;
}

export function detectScriptKind(text: string): KeywordScriptKind {
  const hasAr = ARABIC_CHAR_REGEX.test(text);
  const hasLat = LATIN_CHAR_REGEX.test(text);
  if (hasAr && hasLat) return "mixed";
  if (hasAr) return "arabic";
  if (hasLat) return "latin";
  return "other";
}

function stripArabicDefiniteArticle(token: string): string {
  if (token.startsWith("\u0627\u0644") && token.length > 4) {
    return token.slice(2);
  }
  return token;
}

function normalizeArabicTokenStem(token: string): string {
  const withoutArticle = stripArabicDefiniteArticle(token);
  // Plural feminine suffix ات -> ه (e.g. شركات -> شركه / شرك)
  if (withoutArticle.endsWith("\u0627\u062A") && withoutArticle.length >= 5) {
    return withoutArticle.slice(0, -2);
  }
  if (withoutArticle.endsWith("\u0647") && withoutArticle.length >= 4) {
    return withoutArticle.slice(0, -1);
  }
  return withoutArticle;
}

function tokenizeNormalized(normalized: string): string[] {
  return normalized
    .split(/[\s\-_,./\\()[\]{}:;"'|+!?]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !ARABIC_STOPWORDS.has(t));
}

function tokensMatch(tokenA: string, tokenB: string): boolean {
  if (tokenA === tokenB) return true;
  const stemA = normalizeArabicTokenStem(tokenA);
  const stemB = normalizeArabicTokenStem(tokenB);
  if (stemA.length >= 3 && stemA === stemB) return true;
  if (
    stemA.length >= 3 &&
    stemB.length >= 3 &&
    (stemA.includes(stemB) || stemB.includes(stemA))
  ) {
    return true;
  }
  return false;
}

export function scoreKeywordRelevance(
  candidate: string,
  seedKeyword: string,
  languageCode: string = "en",
): KeywordRelevanceAssessment {
  const normCandidate = normalizeArabicKeyword(candidate);
  const normSeed = normalizeArabicKeyword(seedKeyword);
  const candidateScript = detectScriptKind(candidate);
  const seedScript = detectScriptKind(seedKeyword);

  if (!normSeed || normCandidate === normSeed) {
    return {
      matchType: "exact",
      relevanceScore: 100,
      relevanceTier: "high",
      isWeaklyRelated: false,
      scriptKind: candidateScript,
    };
  }

  const seedTokens = tokenizeNormalized(normSeed);
  const candidateTokens = tokenizeNormalized(normCandidate);

  // Check full phrase containment
  if (normCandidate.includes(normSeed) || normSeed.includes(normCandidate)) {
    return {
      matchType: "phrase",
      relevanceScore: 92,
      relevanceTier: "high",
      isWeaklyRelated: false,
      scriptKind: candidateScript,
    };
  }

  // Check token overlap
  if (seedTokens.length > 0 && candidateTokens.length > 0) {
    const matchedSeedTokens = seedTokens.filter((seedToken) =>
      candidateTokens.some((candToken) => tokensMatch(seedToken, candToken)),
    );
    const overlapRatio = matchedSeedTokens.length / seedTokens.length;

    if (matchedSeedTokens.length === seedTokens.length) {
      return {
        matchType: "phrase",
        relevanceScore: Math.round(88 + overlapRatio * 6),
        relevanceTier: "high",
        isWeaklyRelated: false,
        scriptKind: candidateScript,
      };
    }

    if (matchedSeedTokens.length > 0) {
      return {
        matchType: "partial",
        relevanceScore: Math.round(68 + overlapRatio * 16),
        relevanceTier: "high",
        isWeaklyRelated: false,
        scriptKind: candidateScript,
      };
    }
  }

  // Zero token overlap (semantic / SERP co-occurring related keyword)
  const isArabicQuery =
    seedScript === "arabic" ||
    (languageCode.toLowerCase() === "ar" && seedScript !== "mixed");

  if (isArabicQuery) {
    if (candidateScript === "arabic") {
      return {
        matchType: "related",
        relevanceScore: 52,
        relevanceTier: "medium",
        isWeaklyRelated: false,
        scriptKind: candidateScript,
      };
    }
    if (candidateScript === "mixed") {
      return {
        matchType: "related",
        relevanceScore: 42,
        relevanceTier: "medium",
        isWeaklyRelated: false,
        scriptKind: candidateScript,
      };
    }
    // Purely Latin/English keyword on a purely Arabic query with zero token overlap
    return {
      matchType: "related",
      relevanceScore: 15,
      relevanceTier: "low",
      isWeaklyRelated: true,
      scriptKind: candidateScript,
    };
  }

  if (seedScript === "latin" && candidateScript === "arabic") {
    return {
      matchType: "related",
      relevanceScore: 20,
      relevanceTier: "low",
      isWeaklyRelated: true,
      scriptKind: candidateScript,
    };
  }

  // Mixed-language seed query or matching script related keyword
  return {
    matchType: "related",
    relevanceScore: 50,
    relevanceTier: "medium",
    isWeaklyRelated: false,
    scriptKind: candidateScript,
  };
}

const TIER_RANK: Record<KeywordRelevanceTier, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export function annotateAndSortKeywordRows(
  rows: KeywordResearchRow[],
  seedKeyword: string,
  languageCode: string = "en",
): KeywordResearchRow[] {
  const annotated = rows.map((row) => {
    const assessment = scoreKeywordRelevance(
      row.keyword,
      seedKeyword,
      languageCode,
    );
    return {
      ...row,
      matchType: assessment.matchType,
      relevanceScore: assessment.relevanceScore,
      relevanceTier: assessment.relevanceTier,
      isWeaklyRelated: assessment.isWeaklyRelated,
    };
  });

  return annotated.toSorted((a, b) => {
    // 1. Exact match always first
    const aExact = a.matchType === "exact" ? 1 : 0;
    const bExact = b.matchType === "exact" ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;

    // 2. Relevance tier (high > medium > low)
    const aTier = TIER_RANK[a.relevanceTier ?? "medium"];
    const bTier = TIER_RANK[b.relevanceTier ?? "medium"];
    if (aTier !== bTier) return bTier - aTier;

    // 3. Match type priority within high tier (phrase > partial)
    if (a.relevanceTier === "high" && b.relevanceTier === "high") {
      const aPhrase = a.matchType === "phrase" ? 1 : 0;
      const bPhrase = b.matchType === "phrase" ? 1 : 0;
      if (aPhrase !== bPhrase) return bPhrase - aPhrase;
    }

    // 4. Search volume descending (genuine positive/zero volume before null)
    const aHasVol = typeof a.searchVolume === "number" ? 1 : 0;
    const bHasVol = typeof b.searchVolume === "number" ? 1 : 0;
    if (aHasVol !== bHasVol) return bHasVol - aHasVol;
    const aVol = a.searchVolume ?? -1;
    const bVol = b.searchVolume ?? -1;
    if (aVol !== bVol) return bVol - aVol;

    // 5. Relevance score tie-breaker
    return (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
  });
}
