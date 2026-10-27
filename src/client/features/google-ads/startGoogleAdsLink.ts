import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { authClient } from "@/lib/auth-client";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import { startSelfHostedGoogleAdsLink } from "@/serverFunctions/google-ads";
import { GOOGLE_ADS_OAUTH_PROVIDER_ID } from "@/shared/google-ads";

/** Starts the Google Ads OAuth link. CallbackURL is NOT sent for self-hosted
 *  mode: the server builds the callback from the trusted project id. */
export async function startGoogleAdsLink(
  projectId: string,
  callbackURL: string,
): Promise<void> {
  try {
    if (!isHostedClientAuthMode()) {
      window.location.href = (
        await startSelfHostedGoogleAdsLink({ data: { projectId } })
      ).url;
      return;
    }
    const result = await authClient.oauth2.link({
      providerId: GOOGLE_ADS_OAUTH_PROVIDER_ID,
      callbackURL,
    });
    if (result.error) {
      toast.error(result.error.message ?? "Could not start Google sign-in");
      return;
    }
    if (result.data?.url) window.location.href = result.data.url;
  } catch (error) {
    toast.error(getStandardErrorMessage(error));
  }
}
