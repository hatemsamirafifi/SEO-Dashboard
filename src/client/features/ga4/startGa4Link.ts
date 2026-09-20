import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { authClient } from "@/lib/auth-client";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import { startSelfHostedGa4Link } from "@/serverFunctions/ga4";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";

export async function startGa4Link(
  projectId: string,
  callbackURL: string,
): Promise<void> {
  try {
    if (!isHostedClientAuthMode()) {
      window.location.href = (
        await startSelfHostedGa4Link({ data: { projectId, callbackURL } })
      ).url;
      return;
    }
    const result = await authClient.oauth2.link({
      providerId: GA4_OAUTH_PROVIDER_ID,
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
