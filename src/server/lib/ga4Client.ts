import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";

const adminPropertiesSchema = z
  .object({
    properties: z
      .array(
        z
          .object({
            name: z.string().regex(/^properties\/[^/]+$/),
            displayName: z.string().min(1),
            currencyCode: z.string().min(1).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type Ga4Property = {
  propertyId: string;
  displayName: string;
  currencyCode: string | null;
};

export class Ga4TokenError extends Error {}
export class Ga4ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Minimal Admin API boundary. Reporting API belongs to the next slice. */
export function createGa4Client(options: {
  userId: string;
  ga4AccountId: string;
}) {
  async function getToken() {
    try {
      const result = await getAuth().api.getAccessToken({
        body: {
          providerId: GA4_OAUTH_PROVIDER_ID,
          userId: options.userId,
          accountId: options.ga4AccountId,
        },
      });
      if (!result?.accessToken) throw new Error("No token");
      return result.accessToken;
    } catch (cause) {
      throw new Ga4TokenError(
        "Could not mint a Google Analytics access token (grant revoked or expired).",
        { cause },
      );
    }
  }

  return {
    async listProperties(): Promise<Ga4Property[]> {
      const response = await fetch(
        "https://analyticsadmin.googleapis.com/v1beta/properties",
        {
          headers: { Authorization: `Bearer ${await getToken()}` },
        },
      );
      if (!response.ok)
        throw new Ga4ApiError(
          response.status,
          `Google Analytics Admin API error (${response.status}).`,
        );
      const parsed = adminPropertiesSchema.parse(await response.json());
      return (parsed.properties ?? []).map((property) => ({
        propertyId: property.name.slice("properties/".length),
        displayName: property.displayName,
        currencyCode: property.currencyCode ?? null,
      }));
    },
  };
}
