import {
  hasOrgPermission,
  type OrgPermissionRequest,
} from "@/lib/org-permissions";
import { AppError } from "@/server/lib/errors";

// Server-side org-role gate for app resources (billing/project/integration).
export function requireOrgPermission(
  context: { role?: string | null },
  permissions: OrgPermissionRequest,
) {
  if (!context.role || !hasOrgPermission(context.role, permissions)) {
    throw new AppError(
      "FORBIDDEN",
      "Your organization role does not allow this action.",
    );
  }
}
