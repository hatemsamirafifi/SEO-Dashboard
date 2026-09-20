import { describe, expect, it } from "vitest";
import { propertyListRecovery } from "./propertyListState";

describe("GA4 property-list recovery", () => {
  it("only offers reconnect for a permission failure", () => {
    expect(propertyListRecovery("permission").action).toBe("Reconnect");
    expect(propertyListRecovery("provider").action).toBe("Retry");
  });
});
