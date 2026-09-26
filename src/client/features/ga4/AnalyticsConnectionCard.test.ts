import { describe, expect, it } from "vitest";
import { shouldShowPropertyPicker } from "./connectionState";

describe("Analytics connection state", () => {
  it("opens the property picker when changing an existing connection", () => {
    expect(
      shouldShowPropertyPicker({
        connected: true,
        picking: true,
        hasGrant: true,
      }),
    ).toBe(true);
  });

  it("does not mistake a valid empty property list for a provider error", () => {
    expect(
      shouldShowPropertyPicker({
        connected: false,
        picking: false,
        hasGrant: true,
      }),
    ).toBe(true);
  });
});
