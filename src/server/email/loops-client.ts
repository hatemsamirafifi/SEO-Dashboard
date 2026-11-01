const LOOPS_CONTACT_UPDATE_URL = "https://app.loops.so/api/v1/contacts/update";
const LOOPS_EVENT_SEND_URL = "https://app.loops.so/api/v1/events/send";

type LoopsEventPayload = {
  email?: string;
  userId?: string;
  eventName: string;
  eventProperties?: Record<string, unknown>;
  mailingLists?: Record<string, boolean>;
};

export async function sendLoopsEvent({
  apiKey,
  payload,
  idempotencyKey,
  logContext,
}: {
  apiKey: string;
  payload: LoopsEventPayload;
  idempotencyKey?: string;
  logContext?: Record<string, unknown>;
}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  const response = await fetch(LOOPS_EVENT_SEND_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (response.ok) {
    return;
  }

  const errorPayload = await response.json().catch(() => null);
  console.error("Loops send event error:", {
    status: response.status,
    email: payload.email,
    userId: payload.userId,
    eventName: payload.eventName,
    ...logContext,
    errorPayload,
  });

  throw new Error(`Failed to send Loops event (${response.status})`);
}

type LoopsContactProperty =
  | string
  | number
  | boolean
  | null
  | undefined
  | Record<string, boolean>;

type LoopsContactUpdatePayload = {
  email?: string;
  userId?: string;
  firstName?: string;
  lastName?: string;
  source?: string;
  subscribed?: boolean;
  userGroup?: string;
  mailingLists?: Record<string, boolean>;
} & Record<string, LoopsContactProperty>;

export async function updateLoopsContact({
  apiKey,
  payload,
  logContext,
}: {
  apiKey: string;
  payload: LoopsContactUpdatePayload;
  logContext?: Record<string, unknown>;
}) {
  const response = await fetch(LOOPS_CONTACT_UPDATE_URL, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (response.ok) {
    return;
  }

  const errorPayload = await response.json().catch(() => null);
  console.error("Loops contact update error:", {
    status: response.status,
    email: payload.email,
    userId: payload.userId,
    ...logContext,
    errorPayload,
  });

  throw new Error(`Failed to update Loops contact (${response.status})`);
}

export function getContactNameParts(name: string | null | undefined) {
  const trimmedName = name?.trim();

  if (!trimmedName) {
    return {};
  }

  const [firstName, ...lastNameParts] = trimmedName.split(/\s+/);
  const lastName = lastNameParts.join(" ");

  return {
    firstName,
    ...(lastName ? { lastName } : {}),
  };
}
