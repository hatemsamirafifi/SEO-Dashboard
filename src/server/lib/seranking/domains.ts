import { z } from "zod";
import type { SeRankingClient } from "./client";
import {
  seRankingDomainCompetitorItemSchema,
  seRankingDomainKeywordItemSchema,
  seRankingDomainOverviewSchema,
  seRankingDomainPageItemSchema,
} from "./schemas";
import type {
  SeRankingDomainCompetitorItem,
  SeRankingDomainKeywordItem,
  SeRankingDomainOverview,
  SeRankingDomainPageItem,
} from "./types";

function extractArrayData(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object" && raw !== null) {
    if ("data" in raw && Array.isArray(raw.data)) return raw.data;
    if ("items" in raw && Array.isArray(raw.items)) return raw.items;
  }
  return [];
}

export type DomainOverviewOptions = {
  domain: string;
  source?: string;
  withSubdomains?: boolean;
};

export async function getDomainOverview(
  client: SeRankingClient,
  options: DomainOverviewOptions,
): Promise<SeRankingDomainOverview> {
  const raw = await client.request<unknown>("/domain/overview/db", {
    method: "GET",
    params: {
      domain: options.domain,
      source: options.source ?? "us",
      with_subdomains: options.withSubdomains ? 1 : 0,
    },
  });

  return seRankingDomainOverviewSchema.parse(raw);
}

export type DomainKeywordsOptions = {
  domain: string;
  source?: string;
  limit?: number;
  offset?: number;
  type?: "organic" | "adv";
};

export async function getDomainKeywords(
  client: SeRankingClient,
  options: DomainKeywordsOptions,
): Promise<{ items: SeRankingDomainKeywordItem[]; totalCount: number | null }> {
  const raw = await client.request<unknown>("/domain/keywords", {
    method: "GET",
    params: {
      domain: options.domain,
      source: options.source ?? "us",
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
      type: options.type ?? "organic",
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
    items: z.array(seRankingDomainKeywordItemSchema).parse(array),
    totalCount,
  };
}

export type DomainPagesOptions = {
  domain: string;
  source?: string;
  limit?: number;
  offset?: number;
};

export async function getDomainPages(
  client: SeRankingClient,
  options: DomainPagesOptions,
): Promise<{ items: SeRankingDomainPageItem[]; totalCount: number | null }> {
  const raw = await client.request<unknown>("/domain/pages", {
    method: "GET",
    params: {
      domain: options.domain,
      source: options.source ?? "us",
      limit: options.limit ?? 50,
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
    items: z.array(seRankingDomainPageItemSchema).parse(array),
    totalCount,
  };
}

export type DomainCompetitorsOptions = {
  domain: string;
  source?: string;
  limit?: number;
  offset?: number;
  type?: "organic" | "adv";
};

export async function getDomainCompetitors(
  client: SeRankingClient,
  options: DomainCompetitorsOptions,
): Promise<{
  items: SeRankingDomainCompetitorItem[];
  totalCount: number | null;
}> {
  const raw = await client.request<unknown>("/domain/competitors", {
    method: "GET",
    params: {
      domain: options.domain,
      source: options.source ?? "us",
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
      type: options.type ?? "organic",
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
    items: z.array(seRankingDomainCompetitorItemSchema).parse(array),
    totalCount,
  };
}
