import { z } from "zod";
import type { SeRankingClient } from "./client";
import { SeRankingError } from "./errors";
import {
  seRankingAuthorityHistoryItemSchema,
  seRankingBacklinkItemSchema,
  seRankingBacklinkPageItemSchema,
  seRankingBacklinksHistoryItemSchema,
  seRankingBacklinksSummarySchema,
  seRankingReferringDomainItemSchema,
} from "./schemas";
import type {
  SeRankingAuthorityHistoryItem,
  SeRankingBacklinkItem,
  SeRankingBacklinkPageItem,
  SeRankingBacklinksHistoryItem,
  SeRankingBacklinksSummary,
  SeRankingReferringDomainItem,
} from "./types";

function extractArrayData(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object" && raw !== null) {
    if ("data" in raw && Array.isArray(raw.data)) return raw.data;
    if ("items" in raw && Array.isArray(raw.items)) return raw.items;
    // oxlint-disable-next-line typescript/no-explicit-any
    if (
      "new_lost_backlinks_count" in raw &&
      Array.isArray((raw as any).new_lost_backlinks_count)
    ) {
      // oxlint-disable-next-line typescript/no-explicit-any
      return (raw as any).new_lost_backlinks_count;
    }
  }
  return [];
}

export type BacklinksSummaryOptions = {
  target: string;
  mode?: "domain" | "host" | "url";
};

export async function getBacklinksSummary(
  client: SeRankingClient,
  options: BacklinksSummaryOptions,
): Promise<SeRankingBacklinksSummary> {
  const raw = await client.request<unknown>("/backlinks/summary", {
    method: "GET",
    params: {
      target: options.target,
      mode: options.mode ?? "domain",
    },
  });

  return seRankingBacklinksSummarySchema.parse(raw);
}

export type BacklinksListOptions = {
  target: string;
  mode?: "domain" | "host" | "url";
  limit?: number;
  offset?: number;
  sort?: string;
  sortOrder?: "asc" | "desc";
};

export async function getReferringDomains(
  client: SeRankingClient,
  options: BacklinksListOptions,
): Promise<{
  items: SeRankingReferringDomainItem[];
  totalCount: number | null;
}> {
  const raw = await client.request<unknown>("/backlinks/refdomains", {
    method: "GET",
    params: {
      target: options.target,
      mode: options.mode ?? "domain",
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
      sort: options.sort,
      sort_order: options.sortOrder,
    },
  });

  const array = extractArrayData(raw);
  const totalCount =
    typeof raw === "object" &&
    raw !== null &&
    "total" in raw &&
    typeof raw.total === "number"
      ? raw.total
      : null;

  return {
    items: z.array(seRankingReferringDomainItemSchema).parse(array),
    totalCount,
  };
}

export async function getBacklinks(
  client: SeRankingClient,
  options: BacklinksListOptions,
): Promise<{ items: SeRankingBacklinkItem[]; totalCount: number | null }> {
  const raw = await client.request<unknown>("/backlinks/all", {
    method: "GET",
    params: {
      target: options.target,
      mode: options.mode ?? "domain",
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
      sort: options.sort,
      sort_order: options.sortOrder,
    },
  });

  const array = extractArrayData(raw);
  const totalCount =
    typeof raw === "object" &&
    raw !== null &&
    "total" in raw &&
    typeof raw.total === "number"
      ? raw.total
      : null;

  return {
    items: z.array(seRankingBacklinkItemSchema).parse(array),
    totalCount,
  };
}

export async function getBacklinkPages(
  client: SeRankingClient,
  options: BacklinksListOptions,
): Promise<{ items: SeRankingBacklinkPageItem[]; totalCount: number | null }> {
  const raw = await client.request<unknown>("/backlinks/indexed-pages", {
    method: "GET",
    params: {
      target: options.target,
      mode: options.mode ?? "domain",
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
    },
  });

  const array = extractArrayData(raw);
  const totalCount =
    typeof raw === "object" &&
    raw !== null &&
    "total" in raw &&
    typeof raw.total === "number"
      ? raw.total
      : null;

  return {
    items: z.array(seRankingBacklinkPageItemSchema).parse(array),
    totalCount,
  };
}

export type BacklinksHistoryOptions = {
  target: string;
  mode?: "domain" | "host" | "url";
  dateFrom?: string;
  dateTo?: string;
};

export async function getBacklinksHistory(
  client: SeRankingClient,
  options: BacklinksHistoryOptions,
): Promise<SeRankingBacklinksHistoryItem[]> {
  // Official SE Ranking endpoint: /backlinks/history/cumulative (or /backlinks/history)
  let raw: unknown;
  try {
    raw = await client.request<unknown>("/backlinks/history/cumulative", {
      method: "GET",
      params: {
        target: options.target,
        mode: options.mode ?? "domain",
        date_from: options.dateFrom,
        date_to: options.dateTo,
      },
    });
  } catch (err: unknown) {
    if (err instanceof SeRankingError && err.statusCode === 404) {
      raw = await client.request<unknown>("/backlinks/history", {
        method: "GET",
        params: {
          target: options.target,
          mode: options.mode ?? "domain",
          date_from: options.dateFrom,
          date_to: options.dateTo,
        },
      });
    } else {
      throw err;
    }
  }

  const array = extractArrayData(raw);
  return z.array(seRankingBacklinksHistoryItemSchema).parse(array);
}

export type DomainAuthorityHistoryOptions = {
  target: string;
  dateFrom?: string;
  dateTo?: string;
  granularity?: "by_day" | "by_week" | "by_month";
};

export async function getDomainAuthorityHistory(
  client: SeRankingClient,
  options: DomainAuthorityHistoryOptions,
): Promise<SeRankingAuthorityHistoryItem[]> {
  const raw = await client.request<unknown>(
    "/backlinks/authority/domain/history",
    {
      method: "GET",
      params: {
        target: options.target,
        date_from: options.dateFrom,
        date_to: options.dateTo,
        granularity: options.granularity ?? "by_day",
      },
    },
  );

  const array = extractArrayData(raw);
  return z.array(seRankingAuthorityHistoryItemSchema).parse(array);
}
