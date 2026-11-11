import { SeRankingClient } from "./client";
import type { SeRankingConfig } from "./types";

export * from "./types";
export * from "./schemas";
export * from "./errors";
export * from "./credits";
export * from "./region-map";
export * from "./rateLimiter";
export * from "./client";
export * from "./keywords";
export * from "./domains";
export * from "./backlinks";

export function createSeRankingClient(
  config: SeRankingConfig,
): SeRankingClient {
  return new SeRankingClient(config);
}
