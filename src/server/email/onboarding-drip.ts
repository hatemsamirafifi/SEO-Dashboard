import { waitUntil } from "cloudflare:workers";
import {
  sendLoopsEvent,
  updateLoopsContact,
} from "@/server/email/loops-client";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

/**
 * Server half of the onboarding email drip. Loops owns the timing, filters and
 * copy; the server only reports what a user has done. Milestones land as
 * contact properties the drip's emails filter on, and emails that react to
 * something happening are sent as events (the first audit's results go from
 * firstAuditEmails.ts). Every send is best-effort: a Loops outage must never
 * fail the action that triggered it.
 */

type OnboardingRecipient = { userId: string; userEmail: string };

type OnboardingMilestone =
  | "auditStarted"
  | "gscConnected"
  | "rankTrackingSetUp"
  | "mcpConnected";

export async function markOnboardingMilestone(
  recipient: OnboardingRecipient,
  milestone: OnboardingMilestone,
) {
  await sendOnce(`${milestone}:${recipient.userId}`, (apiKey) =>
    updateLoopsContact({
      apiKey,
      payload: {
        email: recipient.userEmail,
        userId: recipient.userId,
        [milestone]: true,
      },
      logContext: { action: "onboarding-milestone", milestone },
    }),
  );
}

export async function sendCreditsExhaustedEvent(
  recipient: OnboardingRecipient,
) {
  const key = `credits_exhausted:${recipient.userId}:${new Date().toISOString().slice(0, 10)}`;
  await sendOnce(key, (apiKey) =>
    sendLoopsEvent({
      apiKey,
      idempotencyKey: key,
      payload: {
        email: recipient.userEmail,
        userId: recipient.userId,
        eventName: "credits_exhausted",
      },
    }),
  );
}

// Some callers are hot paths (every API-key MCP request, every request
// refused for credits), and Loops rate-limits the whole team, transactional
// emails included. So each isolate sends each update once.
const sentKeys = new Set<string>();

async function sendOnce(
  key: string,
  send: (apiKey: string) => Promise<unknown>,
) {
  if (sentKeys.has(key)) return;
  const apiKey = await getOptionalEnvValue("LOOPS_API_KEY");
  if (!apiKey) return;
  sentKeys.add(key);
  waitUntil(
    send(apiKey).catch((error: unknown) => {
      console.error(`onboarding drip: ${key} failed`, error);
    }),
  );
}
