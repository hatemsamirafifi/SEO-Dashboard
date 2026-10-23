import type { LinkingPage, LinkingSuggestion } from "./types";
import { isIndexablePage, isUtilityUrl } from "./rules";

const MAX_SUGGESTIONS = 3;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "you",
  "your",
  "our",
  "are",
  "was",
  "were",
  "will",
  "can",
  "all",
  "not",
  "but",
  "has",
  "have",
  "had",
  "its",
  "into",
  "about",
  "more",
  "than",
  "then",
  "when",
  "what",
  "who",
  "how",
  "why",
  "where",
  "page",
  "home",
  "shop",
  "store",
  "في",
  "من",
  "على",
  "إلى",
  "الى",
  "عن",
  "مع",
  "هذا",
  "هذه",
  "ذلك",
  "التي",
  "الذي",
  "كان",
  "كانت",
  "هو",
  "هي",
  "كل",
  "أو",
  "او",
  "ثم",
  "قد",
  "ما",
  "لا",
  "لم",
  "لن",
  "و",
]);

function tokenize(text: string | null): string[] {
  if (!text) return [];
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u);
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    seen.add(token);
  }
  return Array.from(seen);
}

function pathTokens(url: string): string[] {
  try {
    return tokenize(new URL(url).pathname.replace(/[-_/]+/g, " "));
  } catch {
    return [];
  }
}

function intersection(a: string[], b: string[]): string[] {
  const right = new Set(b);
  return a.filter((term) => right.has(term));
}

function scoreSuggestion(input: {
  source: LinkingPage;
  target: LinkingPage;
  targetTitle: string[];
  targetH1: string[];
  targetPath: string[];
}): LinkingSuggestion | null {
  const { source, target } = input;
  const titleShared = intersection(tokenize(source.title), input.targetTitle);
  const h1Shared = intersection(tokenize(source.h1Text), input.targetH1);
  if (titleShared.length === 0 && h1Shared.length === 0) return null;

  const sameType =
    source.pageType != null && source.pageType === target.pageType;
  const pathShared = intersection(pathTokens(source.url), input.targetPath);
  const score =
    titleShared.length * 3 +
    h1Shared.length * 4 +
    (sameType ? 2 : 0) +
    (pathShared.length > 0 ? 1 : 0);
  const sharedTerms = Array.from(new Set([...titleShared, ...h1Shared]));

  return {
    sourceUrl: source.url,
    sourceTitle: source.title,
    sourceH1: source.h1Text,
    sourcePageType: source.pageType,
    score,
    sharedTerms,
    reason: `Shares observed terms: ${sharedTerms.join(", ")}`,
  };
}

export function suggestSources(input: {
  target: LinkingPage;
  pages: LinkingPage[];
  existingSourceUrls: Set<string>;
}): LinkingSuggestion[] {
  const { target, pages, existingSourceUrls } = input;
  const targetTitle = tokenize(target.title);
  const targetH1 = tokenize(target.h1Text);
  const targetPath = pathTokens(target.url);

  const suggestions: LinkingSuggestion[] = [];
  for (const source of pages) {
    if (source.id === target.id || source.url === target.url) continue;
    if (existingSourceUrls.has(source.url)) continue;
    if (!isIndexablePage(source) || isUtilityUrl(source.url)) continue;
    const suggestion = scoreSuggestion({
      source,
      target,
      targetTitle,
      targetH1,
      targetPath,
    });
    if (suggestion) suggestions.push(suggestion);
  }

  return suggestions
    .toSorted(
      (a, b) => b.score - a.score || a.sourceUrl.localeCompare(b.sourceUrl),
    )
    .slice(0, MAX_SUGGESTIONS);
}
