import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { InternalLinkingService } from "@/server/features/audit/services/InternalLinkingService";
import { SchemaService } from "@/server/features/audit/services/SchemaService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  cancelAuditSchema,
  deleteAuditSchema,
  getAuditHistorySchema,
  getAuditPageSchemaSchema,
  getAuditResultsSchema,
  getAuditStatusSchema,
  getCrawlProgressSchema,
  startAuditSchema,
} from "@/types/schemas/audit";

function shouldUseAuditE2eFixtures() {
  return import.meta.env.VITE_E2E_AUDIT_FIXTURES === "1";
}

async function getAuditE2eFixtures() {
  return import("../../e2e/fixtures/audit-schema-fixtures");
}

async function getLinkingE2eFixtures() {
  return import("../../e2e/fixtures/audit-linking-fixtures");
}

export const startAudit = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startAuditSchema)
  .handler(async ({ data, context }) => {
    const limitTier = await AuditService.resolveAuditLimitTier(
      context.organizationId,
    );

    const result = await AuditService.startAudit({
      actorUserId: context.userId,
      billingCustomer: context,
      projectId: context.projectId,
      startUrl: data.startUrl,
      maxPages: data.maxPages,
      lighthouseStrategy: data.lighthouseStrategy,
      limitTier,
    });

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "site_audit:start",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          max_pages: data.maxPages ?? 50,
          run_lighthouse: data.lighthouseStrategy !== "none",
          plan_tier: limitTier,
        },
      }),
    );

    return result;
  });

export const getAuditStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getAuditStatusSchema)
  .handler(async ({ data, context }) => {
    if (shouldUseAuditE2eFixtures()) {
      const fixtures = await getAuditE2eFixtures();
      const status = fixtures.getStatusFixture(data.auditId);
      if (status) return status;
    }
    return AuditService.getStatus(data.auditId, context.projectId);
  });

export const getAuditResults = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getAuditResultsSchema)
  .handler(async ({ data, context }) => {
    if (shouldUseAuditE2eFixtures()) {
      const fixtures = await getAuditE2eFixtures();
      const results = fixtures.getResultsFixture(data.auditId);
      if (results) return results;
    }
    return AuditService.getResults(data.auditId, context.projectId);
  });

export const getInternalLinkingReport = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getAuditResultsSchema)
  .handler(async ({ data, context }) => {
    if (shouldUseAuditE2eFixtures()) {
      const fixtures = await getLinkingE2eFixtures();
      const report = fixtures.getInternalLinkingFixture(data.auditId);
      if (report) return report;
    }
    return InternalLinkingService.getReport({
      auditId: data.auditId,
      projectId: context.projectId,
    });
  });

export const getAuditHistory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getAuditHistorySchema)
  .handler(async ({ context }) => {
    return AuditService.getHistory(context.projectId);
  });

export const getCrawlProgress = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getCrawlProgressSchema)
  .handler(async ({ data, context }) => {
    return AuditService.getCrawlProgress(data.auditId, context.projectId);
  });

export const getAuditPageSchema = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getAuditPageSchemaSchema)
  .handler(async ({ data, context }) => {
    if (shouldUseAuditE2eFixtures()) {
      const fixtures = await getAuditE2eFixtures();
      const result = fixtures.getPageSchemaFixture({
        pageId: data.pageId,
        type: data.type,
      });
      if (result) return result;
    }
    return SchemaService.getPageSchema({
      pageId: data.pageId,
      auditId: data.auditId,
      projectId: context.projectId,
      type: data.type,
    });
  });

export const cancelAudit = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(cancelAuditSchema)
  .handler(async ({ data, context }) => {
    const result = await AuditService.cancelAudit({
      actorUserId: context.userId,
      auditId: data.auditId,
      projectId: context.projectId,
    });

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "site_audit:cancel",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          status: result.status ?? "cancelled",
        },
      }),
    );

    return result;
  });

export const deleteAudit = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(deleteAuditSchema)
  .handler(async ({ data, context }) => {
    await AuditService.remove(data.auditId, context.projectId);
    return { success: true };
  });
