import { z } from "zod";
import { AppError } from "@/server/lib/errors";

// Evidence-type serializer (final-plan §13 + §10). MVP automated output is
// correlation-only: `observational` is the default and bans causal phrasing.
// Only `provider_confirmed` / `manual_user_assertion` unlock causal verbs.

export const AUTOPILOT_EVIDENCE_TYPES = [
  "observational",
  "provider_confirmed",
  "manual_user_assertion",
] as const;
export type AutopilotEvidenceType = (typeof AUTOPILOT_EVIDENCE_TYPES)[number];

const BANNED_CAUSAL = [
  /\bcaused\b/i,
  /\bcauses\b/i,
  /\bcausing\b/i,
  /\bbecause of/i,
  /\bdue to/i,
  /\bled to/i,
  /\bresulted in/i,
  /\btriggered\b/i,
];

export function containsBannedCausalVerb(text: string): boolean {
  return BANNED_CAUSAL.some((pattern) => pattern.test(text));
}

export function assertObservationalSafe(
  text: string,
  evidenceType: AutopilotEvidenceType,
): void {
  if (evidenceType !== "observational") return;
  if (containsBannedCausalVerb(text)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Observational evidence must not use causal phrasing",
    );
  }
}

const confidenceSchema = z
  .object({ value: z.number().min(0).max(100), why: z.string().min(1) })
  .strict();

const expectedImpactSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("quantified"),
      value: z.string().min(1),
      basis: z.string().min(1),
      explanation: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("qualitative"),
      explanation: z.string().min(1),
    })
    .strict(),
]);

export const autopilotRecommendationSchema = z
  .object({
    evidence: z
      .object({ metrics: z.string().min(1), periods: z.string().min(1) })
      .strict(),
    dataSource: z.string().min(1),
    reasoningSummary: z.string().min(1),
    confidence: confidenceSchema,
    expectedImpact: expectedImpactSchema,
    suggestedAction: z.string().min(1),
    evidenceType: z.enum(AUTOPILOT_EVIDENCE_TYPES).default("observational"),
  })
  .strict();

export type AutopilotRecommendation = z.infer<
  typeof autopilotRecommendationSchema
>;

function checkedTextOf(rec: AutopilotRecommendation): string {
  const impactText =
    rec.expectedImpact.kind === "quantified"
      ? `${rec.expectedImpact.value} ${rec.expectedImpact.basis}`
      : rec.expectedImpact.explanation;
  return [
    rec.reasoningSummary,
    rec.suggestedAction,
    rec.confidence.why,
    impactText,
  ].join("\n");
}

export function serializeRecommendation(
  input: unknown,
): AutopilotRecommendation {
  const parsed = autopilotRecommendationSchema.parse(input);
  assertObservationalSafe(checkedTextOf(parsed), parsed.evidenceType);
  return parsed;
}

export function serializeRecommendations(
  inputs: Record<string, unknown>[],
  fallbackEvidenceType: AutopilotEvidenceType = "observational",
): AutopilotRecommendation[] {
  return inputs.map((entry) => {
    const withDefault: Record<string, unknown> = {
      evidenceType: fallbackEvidenceType,
    };
    for (const [key, value] of Object.entries(entry)) {
      withDefault[key] = value;
    }
    return serializeRecommendation(withDefault);
  });
}
