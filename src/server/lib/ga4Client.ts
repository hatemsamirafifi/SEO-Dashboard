import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";

const accountSummariesSchema = z
  .object({
    accountSummaries: z
      .array(
        z
          .object({
            account: z.string().regex(/^accounts\/[^/]+$/),
            propertySummaries: z
              .array(
                z
                  .object({
                    property: z.string().regex(/^properties\/[^/]+$/),
                    displayName: z.string().min(1),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    nextPageToken: z.string().min(1).optional(),
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
      const token = await getToken();
      const properties: Ga4Property[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(
          "https://analyticsadmin.googleapis.com/v1beta/accountSummaries",
        );
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok)
          throw new Ga4ApiError(
            response.status,
            `Google Analytics Admin API error (${response.status}).`,
          );
        const parsed = accountSummariesSchema.parse(await response.json());
        for (const account of parsed.accountSummaries ?? []) {
          for (const property of account.propertySummaries ?? []) {
            properties.push({
              propertyId: property.property.slice("properties/".length),
              displayName: property.displayName,
              currencyCode: null,
            });
          }
        }
        pageToken = parsed.nextPageToken;
      } while (pageToken);
      return properties;
    },
  };
}
