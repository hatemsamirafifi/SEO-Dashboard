import { AppError } from "@/server/lib/errors";
import {
  classifyGoogleAdsError,
  createGoogleAdsClient,
  type GoogleAdsCustomer,
} from "@/server/lib/googleAdsClient";
import { normalizeGoogleAdsCustomerId } from "@/shared/google-ads";
import {
  GoogleAdsGrantRepository,
  type GoogleAdsGrant,
} from "../repositories/GoogleAdsGrantRepository";
import {
  GoogleAdsConnectionRepository,
  type GoogleAdsConnection,
} from "../repositories/GoogleAdsConnectionRepository";

/** Safe failure shape: a stable class, a message free of upstream detail and
 *  whether another attempt could succeed. It is the only provider information
 *  that leaves the server. */
export type GoogleAdsFailure = {
  errorClass: string;
  message: string;
  retryable: boolean;
};

/** The client factory result. Typed once so the helpers below can accept a
 *  client without importing the module's private types. */
type GoogleAdsClient = ReturnType<typeof createGoogleAdsClient>;

/** Turns a provider failure into the safe, client-facing shape. Upstream
 *  bodies, request ids and tokens never reach the caller. */
export function googleAdsFailure(error: unknown): GoogleAdsFailure {
  const classified = classifyGoogleAdsError(error);
  return {
    errorClass: classified.errorClass,
    message: classified.message,
    retryable: classified.retryable,
  };
}

/** Maps a provider failure onto an application error code. Only the code
 *  reaches the browser; the message stays on the server. */
export function googleAdsAppError(error: unknown): AppError {
  const failure = googleAdsFailure(error);
  switch (failure.errorClass) {
    case "OAUTH_TOKEN_FAILURE":
    case "OAUTH_TOKEN_INVALID":
    case "PERMISSION_DENIED":
    case "API_ACCESS_RESTRICTED":
      return new AppError("FORBIDDEN", failure.message);
    case "CUSTOMER_NOT_FOUND":
    case "NOT_CONNECTED":
      return new AppError("NOT_FOUND", failure.message);
    case "QUOTA_TEMPORARILY_EXHAUSTED":
      return new AppError("TRANSIENT_UPSTREAM", failure.message);
    case "QUOTA_EXHAUSTED":
      return new AppError("RATE_LIMITED", failure.message);
    case "INVALID_REQUEST":
      return new AppError("VALIDATION_ERROR", failure.message);
    default:
      return new AppError("UPSTREAM_UNAVAILABLE", failure.message);
  }
}

/** Loads one of the caller's own Ads grants and enforces Ads consent. A grant
 *  the caller does not own is indistinguishable from one that does not exist:
 *  both answer NOT_FOUND. */
export async function requireConsentedGoogleAdsGrant(
  userId: string,
  grantAccountId: string,
): Promise<GoogleAdsGrant> {
  const grant = await GoogleAdsGrantRepository.getOwnedGrant(
    userId,
    grantAccountId,
  );
  if (!grant) {
    throw new AppError(
      "NOT_FOUND",
      "That Google Ads account isn't connected to your OpenSEO account.",
    );
  }
  if (!GoogleAdsGrantRepository.hasAdsConsent(grant.scope)) {
    throw new AppError(
      "FORBIDDEN",
      "That Google Ads account did not grant the required Google Ads access.",
    );
  }
  return grant;
}

/** Normalizes a customer id to its bare ten-digit form. */
export function requireGoogleAdsCustomerId(value: string): string {
  const normalized = normalizeGoogleAdsCustomerId(value);
  if (!normalized) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Google Ads customer IDs must be ten digits.",
    );
  }
  return normalized;
}

/** The project's stored connection. Database only: no token is minted and no
 *  Ads API call is made. */
async function getConnection(
  projectId: string,
  organizationId: string,
): Promise<GoogleAdsConnection | null> {
  return GoogleAdsConnectionRepository.getByProjectId(
    projectId,
    organizationId,
  );
}

/** Whether the caller holds a usable Ads grant. Database only. */
async function userHasGrant(userId: string): Promise<boolean> {
  const grants = await GoogleAdsGrantRepository.listForUser(userId);
  return grants.some((grant) =>
    GoogleAdsGrantRepository.hasAdsConsent(grant.scope),
  );
}

/** The accounts the grant can reach on its own. */
async function readAccessibleCustomers(
  client: GoogleAdsClient,
): Promise<string[]> {
  try {
    return await client.listAccessibleCustomers();
  } catch (error) {
    throw googleAdsAppError(error);
  }
}

/** Reads one customer through the grant that owns it. Manager children are
 *  read with the manager's login header — that read is what Google enforces
 *  the manager/customer path on, so no other root has to be traversed to
 *  validate a selection. */
async function readCustomer(
  client: GoogleAdsClient,
  customerId: string,
  loginCustomerId: string | null,
): Promise<GoogleAdsCustomer> {
  let customer: GoogleAdsCustomer | null;
  try {
    customer = await client.getCustomer(customerId, { loginCustomerId });
  } catch (error) {
    throw googleAdsAppError(error);
  }
  if (!customer) {
    throw new AppError("NOT_FOUND", "Google Ads did not return that customer.");
  }
  return customer;
}

export type GoogleAdsSelectCustomerInput = {
  projectId: string;
  organizationId: string;
  userId: string;
  grantAccountId: string;
  customerId: string;
  loginCustomerId?: string | null;
};

/** Maps a serving account to the project. The caller must own the grant and
 *  have Ads consent on it; a direct account must be one the grant can reach,
 *  and a manager login must itself be an accessible manager of that grant.
 *  Nothing is persisted until every check passed. */
async function selectCustomer(
  input: GoogleAdsSelectCustomerInput,
): Promise<GoogleAdsConnection> {
  await requireConsentedGoogleAdsGrant(input.userId, input.grantAccountId);
  const customerId = requireGoogleAdsCustomerId(input.customerId);
  const loginCustomerId = input.loginCustomerId
    ? requireGoogleAdsCustomerId(input.loginCustomerId)
    : null;

  const client = createGoogleAdsClient({
    userId: input.userId,
    grantAccountId: input.grantAccountId,
  });

  const accessible = await readAccessibleCustomers(client);
  if (loginCustomerId) {
    if (!accessible.includes(loginCustomerId)) {
      throw new AppError(
        "NOT_FOUND",
        "That Google Ads manager account isn't available on your connected Google account.",
      );
    }
    const manager = await readCustomer(client, loginCustomerId, null);
    if (manager.customerId !== loginCustomerId) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Google Ads returned a different customer than the one requested.",
      );
    }
    if (!manager.manager) {
      throw new AppError(
        "VALIDATION_ERROR",
        "That Google Ads account is not a manager account.",
      );
    }
  } else if (!accessible.includes(customerId)) {
    throw new AppError(
      "NOT_FOUND",
      "That Google Ads account isn't available on your connected Google account.",
    );
  }

  const customer = await readCustomer(client, customerId, loginCustomerId);
  if (customer.customerId !== customerId) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Google Ads returned a different customer than the one requested.",
    );
  }
  if (customer.manager) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A Google Ads manager account cannot be used as the analytics account.",
    );
  }

  return GoogleAdsConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    customerId,
    loginCustomerId,
    customerDisplayName: customer.displayName,
    grantAccountId: input.grantAccountId,
    connectedByUserId: input.userId,
    // Currency and time zone stay exactly as Google reported them: a missing
    // value is null, never a guessed default.
    currencyCode: customer.currencyCode,
    timeZone: customer.timeZone,
    isTestAccount: customer.isTestAccount,
  });
}

export type GoogleAdsConnectionTest = {
  ok: boolean;
  errorClass: string | null;
  message: string;
  retryable: boolean;
};

/** Explicit, single-attempt check of the project's stored connection. It
 *  distinguishes a missing scope, missing/revoked/expired credentials, a Cloud
 *  access restriction, an account permission problem and quota exhaustion.
 *  There is no retry loop: exactly one customer read is attempted. */
async function testConnection(input: {
  projectId: string;
  organizationId: string;
}): Promise<GoogleAdsConnectionTest> {
  const connection = await getConnection(input.projectId, input.organizationId);
  if (!connection) {
    return {
      ok: false,
      errorClass: "NOT_CONNECTED",
      message: "Google Ads is not connected for this project.",
      retryable: false,
    };
  }
  const grant = await GoogleAdsGrantRepository.getOwnedGrant(
    connection.connectedByUserId,
    connection.grantAccountId,
  );
  if (!grant) {
    return {
      ok: false,
      errorClass: "MISSING_CREDENTIALS",
      message:
        "The stored Google Ads authorization is gone. Reconnect the account.",
      retryable: false,
    };
  }
  if (!GoogleAdsGrantRepository.hasAdsConsent(grant.scope)) {
    return {
      ok: false,
      errorClass: "MISSING_SCOPE",
      message:
        "The stored Google Ads authorization is missing the Ads scope. Reconnect the account.",
      retryable: false,
    };
  }

  const client = createGoogleAdsClient({
    userId: connection.connectedByUserId,
    grantAccountId: connection.grantAccountId,
  });
  try {
    const customer = await client.getCustomer(connection.customerId, {
      loginCustomerId: connection.loginCustomerId,
    });
    if (!customer) {
      return {
        ok: false,
        errorClass: "CUSTOMER_NOT_FOUND",
        message: "Google Ads no longer returns the connected customer.",
        retryable: false,
      };
    }
    if (customer.customerId !== connection.customerId) {
      return {
        ok: false,
        errorClass: "CUSTOMER_MISMATCH",
        message:
          "Google Ads returned a different customer than the connected one.",
        retryable: false,
      };
    }
    return {
      ok: true,
      errorClass: null,
      message: "The Google Ads connection works.",
      retryable: false,
    };
  } catch (error) {
    return { ok: false, ...googleAdsFailure(error) };
  }
}

/** Removes only this project's mapping. The shared OAuth grant, other projects
 *  and other providers stay untouched: reconnecting starts OAuth again and no
 *  Google-side revocation happens. */
async function disconnect(input: {
  projectId: string;
  organizationId: string;
}): Promise<void> {
  await GoogleAdsConnectionRepository.deleteByProjectId(
    input.projectId,
    input.organizationId,
  );
}

export const GoogleAdsService = {
  getConnection,
  userHasGrant,
  selectCustomer,
  testConnection,
  disconnect,
};
