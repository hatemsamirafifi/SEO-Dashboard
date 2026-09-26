import { describe, expect, it } from "vitest";
import {
  getErrorCode,
  getErrorMessage,
  getStandardErrorMessage,
} from "@/client/lib/error-messages";

describe("getStandardErrorMessage", () => {
  it("maps known error codes to standard copy", () => {
    expect(getStandardErrorMessage(new Error("PAYMENT_REQUIRED"))).toBe(
      "An active hosted subscription is required before you can use OpenSEO.",
    );
    expect(getStandardErrorMessage(new Error("DATAFORSEO_ACCESS_PAUSED"))).toContain(
      "support@dataforseo.com",
    );
  });

  it("maps DATAFORSEO_ACCOUNT_PAUSED to actionable user-facing copy", () => {
    const error = new Error("DATAFORSEO_ACCOUNT_PAUSED");
    expect(getErrorCode(error)).toBe("DATAFORSEO_ACCOUNT_PAUSED");
    const message = getStandardErrorMessage(error);
    expect(message).toContain("DataForSEO access is temporarily paused");
    expect(message).toContain("support@dataforseo.com");
    expect(message).toContain("security precaution");
  });

  it("returns custom messages when the error is not a shared code", () => {
    expect(
      getStandardErrorMessage(
        new Error("DataForSEO task missing billing metadata. Response: {...}"),
      ),
    ).toBe("DataForSEO task missing billing metadata. Response: {...}");
  });
});

describe("getErrorMessage", () => {
  it("maps known error codes to message strings", () => {
    expect(getErrorMessage("PAYMENT_REQUIRED")).toBe(
      "An active hosted subscription is required before you can use OpenSEO.",
    );
    expect(getErrorMessage("DATAFORSEO_ACCESS_PAUSED")).toContain(
      "support@dataforseo.com",
    );
  });

  it("returns null for null, undefined, or empty code", () => {
    expect(getErrorMessage(null)).toBeNull();
    expect(getErrorMessage(undefined)).toBeNull();
    expect(getErrorMessage("")).toBeNull();
  });

  it("returns null for unknown error codes", () => {
    expect(getErrorMessage("UNKNOWN_CODE")).toBeNull();
  });
});

describe("coded error messages (CODE: detail)", () => {
  const coded = new Error(
    "AUTH_CONFIG_MISSING: TEAM_DOMAIN must be a full https URL like https://your-team.cloudflareaccess.com",
  );

  it("extracts the code from a coded message", () => {
    expect(getErrorCode(coded)).toBe("AUTH_CONFIG_MISSING");
  });

  it("shows the server detail instead of the generic text", () => {
    expect(getStandardErrorMessage(coded)).toBe(
      "TEAM_DOMAIN must be a full https URL like https://your-team.cloudflareaccess.com",
    );
  });

  it("keeps bare codes mapping to the standard copy", () => {
    const bare = new Error("AUTH_CONFIG_MISSING");
    expect(getErrorCode(bare)).toBe("AUTH_CONFIG_MISSING");
    expect(getStandardErrorMessage(bare)).toContain("not configured");
  });

  it("does not treat arbitrary colon messages as coded", () => {
    const arbitrary = new Error("Something failed: try again");
    expect(getErrorCode(arbitrary)).toBeNull();
    expect(getStandardErrorMessage(arbitrary)).toBe(
      "Something failed: try again",
    );
  });
});

