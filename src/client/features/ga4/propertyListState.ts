export type PropertyListFailure = "permission" | "provider";

export function propertyListRecovery(failure: PropertyListFailure) {
  return failure === "permission"
    ? {
        message: "Analytics permission was revoked or is missing.",
        action: "Reconnect",
      }
    : { message: "Analytics is temporarily unavailable.", action: "Retry" };
}
