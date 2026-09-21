/**
 * Versioned opportunity scoring weights (final-plan §10). Impact factors are
 * renormalized over the available set: missing optional data shrinks the
 * divisor instead of scoring zero.
 */

export const SCORE_VERSION = 1;

export type ImpactFactorName =
  | "trafficPotential"
  | "proximity"
  | "decline"
  | "businessIntent"
  | "conversionSignal";

/** Weights sum to 100 when every factor is available. */
export const OPPORTUNITY_WEIGHTS: Record<ImpactFactorName, number> = {
  trafficPotential: 30,
  proximity: 25,
  decline: 20,
  businessIntent: 15,
  conversionSignal: 10,
};
