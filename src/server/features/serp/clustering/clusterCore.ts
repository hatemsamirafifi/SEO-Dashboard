/**
 * Pure clustering over observed organic results (spec 019).
 *
 * A cluster is a set of pages that keep appearing together on the tracked
 * keywords. The graph only keeps edges whose co-occurrence reaches the
 * threshold, so two groups that would only be joined by a weakly shared page
 * stay apart (the bridge guard). Nothing here infers intent: the evidence is
 * the observed co-occurrence.
 */

type SerpClusterPage = {
  url: string;
  normalizedUrl: string;
  domain: string | null;
  bestPosition: number;
  keywordCount: number;
};

type SerpCluster = {
  /** Deterministic identity: the sorted normalized URLs of the cluster. */
  id: string;
  pages: SerpClusterPage[];
  /** Number of tracked keywords the cluster was observed on. */
  keywordCount: number;
  /** Bounded sample of the keywords the cluster was observed on. */
  keywords: string[];
  /** Pages of the cluster that the project does not own. */
  newPageUrls: string[];
};

export type ClusterCoverageStatus =
  | "ready"
  | "awaiting_data"
  | "insufficient_data"
  | "stale_data";

export type ClusterCoverage = {
  status: ClusterCoverageStatus;
  trackedKeywords: number;
  coveredKeywords: number;
  /** Share of tracked keywords with usable organic data (0-100). */
  percent: number;
  freshestObservedAt: string | null;
};

export type ClusterInputPage = {
  url: string;
  normalizedUrl: string;
  domain: string | null;
  position: number;
};

export type ClusterInput = {
  /** The tracked keyword and the pages observed for it. */
  keyword: string;
  pages: ClusterInputPage[];
};

type ClusterOptions = {
  /** Minimum number of shared keywords for two pages to be clustered. */
  threshold: number;
  /** Minimum share of tracked keywords with usable data (0-1). */
  minCoverageRatio: number;
  /** The project's own domain; a cluster page outside it is a new page. */
  trackedDomain: string;
  /** How many keywords the project tracks for this market and device. */
  trackedKeywordCount: number;
  /** Freshest observation among the stored rows (ISO timestamp). */
  freshestObservedAt: string | null;
};

function isOwnDomain(domain: string | null, trackedDomain: string): boolean {
  if (!domain) return false;
  const target = trackedDomain.toLowerCase();
  const candidate = domain.toLowerCase();
  return candidate === target || candidate.endsWith(`.${target}`);
}

function clusterId(pages: SerpClusterPage[]): string {
  return pages
    .map((page) => page.normalizedUrl)
    .toSorted()
    .join("|");
}

export function computeClusterCoverage(input: {
  coveredKeywords: number;
  trackedKeywords: number;
  storedRows: number;
  freshestObservedAt: string | null;
  minCoverageRatio: number;
}): ClusterCoverage {
  const percent =
    input.trackedKeywords > 0
      ? Math.round((input.coveredKeywords / input.trackedKeywords) * 100)
      : 0;
  const status: ClusterCoverageStatus =
    input.storedRows === 0
      ? "awaiting_data"
      : input.trackedKeywords > 0 &&
          input.coveredKeywords / input.trackedKeywords < input.minCoverageRatio
        ? "insufficient_data"
        : input.freshestObservedAt === null
          ? "awaiting_data"
          : "ready";
  return {
    status,
    trackedKeywords: input.trackedKeywords,
    coveredKeywords: input.coveredKeywords,
    percent,
    freshestObservedAt: input.freshestObservedAt,
  };
}

export function clusterSerpPages(
  inputs: ClusterInput[],
  options: ClusterOptions,
): { clusters: SerpCluster[]; coverage: ClusterCoverage } {
  const coveredKeywords = new Set(inputs.map((input) => input.keyword));
  const coverage = computeClusterCoverage({
    coveredKeywords: coveredKeywords.size,
    trackedKeywords: options.trackedKeywordCount,
    storedRows: inputs.reduce((sum, input) => sum + input.pages.length, 0),
    freshestObservedAt: options.freshestObservedAt,
    minCoverageRatio: options.minCoverageRatio,
  });

  // Page -> the keywords it was observed on.
  const keywordsByPage = new Map<string, Set<string>>();
  const pageByKey = new Map<
    string,
    { url: string; normalizedUrl: string; domain: string | null; best: number }
  >();
  for (const input of inputs) {
    for (const page of input.pages) {
      const key = page.normalizedUrl;
      let keywords = keywordsByPage.get(key);
      if (!keywords) {
        keywords = new Set();
        keywordsByPage.set(key, keywords);
        pageByKey.set(key, {
          url: page.url,
          normalizedUrl: page.normalizedUrl,
          domain: page.domain,
          best: page.position,
        });
      }
      keywords.add(input.keyword);
      const known = pageByKey.get(key);
      if (known && page.position < known.best) known.best = page.position;
    }
  }

  // Co-occurrence edges, only where the shared keyword count reaches the
  // threshold. Weaker links never merge two groups (bridge guard).
  const edges = new Map<string, number>();
  const pages = [...keywordsByPage.keys()].toSorted();
  for (let i = 0; i < pages.length; i += 1) {
    for (let j = i + 1; j < pages.length; j += 1) {
      const left = pages[i];
      const right = pages[j];
      if (!left || !right) continue;
      const leftKeywords = keywordsByPage.get(left);
      const rightKeywords = keywordsByPage.get(right);
      if (!leftKeywords || !rightKeywords) continue;
      let shared = 0;
      for (const keyword of leftKeywords) {
        if (rightKeywords.has(keyword)) shared += 1;
      }
      if (shared < options.threshold) continue;
      edges.set(`${left}::${right}`, shared);
      edges.set(`${right}::${left}`, shared);
    }
  }

  // Connected components of the thresholded graph.
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    const current = parent.get(key) ?? key;
    if (current === key) return key;
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [keep, drop] =
      leftRoot < rightRoot ? [leftRoot, rightRoot] : [rightRoot, leftRoot];
    parent.set(drop, keep);
  };
  for (const key of pages) parent.set(key, key);
  for (const [edge] of edges) {
    const [left, right] = edge.split("::");
    if (!left || !right) continue;
    union(left, right);
  }

  const groups = new Map<string, string[]>();
  for (const key of pages) {
    const root = find(key);
    const group = groups.get(root) ?? [];
    group.push(key);
    groups.set(root, group);
  }

  const clusters: SerpCluster[] = [];
  for (const [, members] of groups) {
    const clusterPages: SerpClusterPage[] = members
      .map((key) => {
        const known = pageByKey.get(key);
        const keywords = keywordsByPage.get(key);
        if (!known || !keywords) return null;
        return {
          url: known.url,
          normalizedUrl: known.normalizedUrl,
          domain: known.domain,
          bestPosition: known.best,
          keywordCount: keywords.size,
        };
      })
      .filter((page): page is SerpClusterPage => page !== null)
      .toSorted((a, b) =>
        a.keywordCount === b.keywordCount
          ? a.normalizedUrl.localeCompare(b.normalizedUrl)
          : b.keywordCount - a.keywordCount,
      );
    if (clusterPages.length < 2) continue;
    const clusterKeywords = new Set<string>();
    for (const key of members) {
      for (const keyword of keywordsByPage.get(key) ?? []) {
        clusterKeywords.add(keyword);
      }
    }
    clusters.push({
      id: clusterId(clusterPages),
      pages: clusterPages,
      keywordCount: clusterKeywords.size,
      keywords: [...clusterKeywords].toSorted().slice(0, 10),
      newPageUrls: clusterPages
        .filter((page) => !isOwnDomain(page.domain, options.trackedDomain))
        .map((page) => page.url)
        .toSorted(),
    });
  }

  const sortedClusters = clusters.toSorted((a, b) =>
    b.keywordCount === a.keywordCount
      ? a.id.localeCompare(b.id)
      : b.keywordCount - a.keywordCount,
  );

  return { clusters: sortedClusters, coverage };
}
