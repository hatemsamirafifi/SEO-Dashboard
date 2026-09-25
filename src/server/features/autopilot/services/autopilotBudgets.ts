import { checkUsageCreditsDepleted } from "@/server/billing/subscription";
import { resolveSamEffectiveConfig } from "@/server/features/sam/samEffectiveConfig";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";

// Budget-dependency seam (final-plan §13 + §23.3). Autopilot never consults
// the stale single-provider gate: credit checks go to the hosted balance and
// provider resolution goes to the six-provider effective config. Object
// shape (not bare imports) so tests can spy without module mocks.
export const AutopilotBudgets = {
  checkCreditsDepleted: checkUsageCreditsDepleted,
  resolveProvider: resolveSamEffectiveConfig,
  isHostedMode: isHostedServerAuthMode,
};
