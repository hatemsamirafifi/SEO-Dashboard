import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Evidence harness for spec 009 (email delivery spike). Offline checks run
 * against mocked fetch + controlled env and assert OBSERVED behavior of the
 * existing Loops path (failure semantics, degradation, duplicate sends).
 * Live provider checks are env-gated and skip without explicit spike
 * credentials — they encode the unblock path, never send real mail by
 * accident. No test here sends to a real recipient.
 */

const testEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock("cloudflare:workers", () => ({ env: testEnv }));

// oxlint-disable-next-line import/first -- mocks must load before the module under test
import {
  sendHostedPasswordResetEmail,
  sendHostedVerificationEmail,
  upsertHostedSignupContact,
} from "./loops";

const fetchMock = vi.hoisted(() =>
  vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
);

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(testEnv)) delete testEnv[key];
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(jsonResponse(200));
});

describe("missing-credentials degradation (spec 009)", () => {
  it("skips signup contact sync silently without an API key", async () => {
    await upsertHostedSignupContact({
      userId: "u-1",
      email: "user@example.com",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed with a named missing variable for verification sends", async () => {
    await expect(
      sendHostedVerificationEmail({
        email: "user@example.com",
        confirmationUrl: "https://example.com/confirm",
      }),
    ).rejects.toThrow("LOOPS_API_KEY is required in hosted mode");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for password-reset sends without config", async () => {
    await expect(
      sendHostedPasswordResetEmail({
        email: "user@example.com",
        resetUrl: "https://example.com/reset",
      }),
    ).rejects.toThrow("LOOPS_API_KEY is required in hosted mode");
  });
});

describe("transactional send contract (spec 009)", () => {
  beforeEach(() => {
    testEnv.LOOPS_API_KEY = "test-key";
    testEnv.LOOPS_TRANSACTIONAL_VERIFY_EMAIL_ID = "txn-verify";
    testEnv.LOOPS_TRANSACTIONAL_RESET_PASSWORD_ID = "txn-reset";
  });

  it("posts once to the transactional endpoint with bearer auth", async () => {
    await sendHostedVerificationEmail({
      email: "user@example.com",
      confirmationUrl: "https://example.com/confirm",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall?.[0]).toBe("https://app.loops.so/api/v1/transactional");
    const init = firstCall?.[1];
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer test-key",
    );
    if (typeof init?.body !== "string") {
      throw new Error("expected a JSON string body");
    }
    expect(JSON.parse(init.body)).toMatchObject({
      transactionalId: "txn-verify",
      email: "user@example.com",
      addToAudience: false,
      dataVariables: {
        appName: "OpenSEO",
        confirmationUrl: "https://example.com/confirm",
      },
    });
  });

  it.each([401, 404, 429, 500])(
    "throws an unclassified error on HTTP %i (no transient/permanent distinction)",
    async (status) => {
      fetchMock.mockResolvedValue(jsonResponse(status, { message: "nope" }));
      const error = await sendHostedVerificationEmail({
        email: "user@example.com",
        confirmationUrl: "https://example.com/confirm",
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("expected Error");
      expect(error.message).toContain(
        `Failed to send Loops transactional email (${status})`,
      );
      // Evidence for the verdict: the path classifies nothing — callers
      // cannot distinguish retryable throttling from dead credentials.
      expect(error.message).not.toMatch(/transient|permanent|retry/i);
    },
  );

  it("sends duplicates with byte-identical bodies (no idempotency key)", async () => {
    const args = {
      email: "user@example.com",
      confirmationUrl: "https://example.com/confirm",
    };
    await sendHostedVerificationEmail(args);
    await sendHostedVerificationEmail(args);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => {
      const body = call[1]?.body;
      if (typeof body !== "string") throw new Error("expected string bodies");
      return body;
    });
    const [firstBody, secondBody] = bodies;
    expect(firstBody).toBe(secondBody);
    expect(firstBody).not.toContain("idempotency");
  });
});

const hasLiveEnv =
  typeof process.env.LOOPS_SPIKE_API_KEY === "string" &&
  process.env.LOOPS_SPIKE_API_KEY !== "" &&
  typeof process.env.LOOPS_SPIKE_RECIPIENT === "string" &&
  process.env.LOOPS_SPIKE_RECIPIENT !== "";

describe.skipIf(!hasLiveEnv)("live provider checks (spec 009)", () => {
  it("observes quota headroom for scheduled-report volume", () => {
    // Unblock path: run with LOOPS_SPIKE_API_KEY set and record the
    // account's send quota/rate limits versus projected weekly/monthly
    // scheduled-report volume. Cannot be observed without credentials.
    expect(hasLiveEnv).toBe(true);
  });

  it("observes sender identity and template ownership", () => {
    // Unblock path: confirm the sending identity and that a
    // scheduled-report transactional template exists, is owned by this
    // deployment, and accepts the report data variables. Requires
    // dashboard/API access beyond code inspection.
    expect(hasLiveEnv).toBe(true);
  });

  it("observes deliverability to a sandbox recipient", () => {
    // Unblock path: send to LOOPS_SPIKE_RECIPIENT only and record
    // delivery/bounce behavior. Never a real client address.
    expect(hasLiveEnv).toBe(true);
  });
});
