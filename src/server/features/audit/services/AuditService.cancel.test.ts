import { describe, expect, it, vi, beforeEach } from "vitest";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { AppError } from "@/server/lib/errors";

vi.mock("cloudflare:workers", () => ({
  env: { KV: {}, SITE_AUDIT_WORKFLOW: {} },
}));
vi.mock("@/server/lib/audit/progress-kv", () => ({ AuditProgressKV: {} }));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: hoistedRepoMocks.AuditRepository,
}));

const hoistedRepoMocks = vi.hoisted(() => ({
  AuditRepository: {
    getAuditForProject: vi.fn(),
    cancelAudit: vi.fn(),
  },
}));

const repo = hoistedRepoMocks.AuditRepository;

function getAuditResult(status: string) {
  return {
    id: "a1",
    projectId: "p1",
    startUrl: "https://example.com/",
    maxPages: 50,
    lighthouseStrategy: "none",
    status,
    pagesCrawled: 3,
    pagesTotal: 5,
    urlsDiscovered: 8,
    urlsFetched: 3,
    urlsAnalyzed: 3,
    urlsBlocked: 0,
    urlsFailed: 0,
    urlsSkipped: 0,
    urlsRenderingRequired: 0,
    urlsExtractionComplete: 3,
    ranLighthouse: 0,
    lighthouseTotal: 0,
    lighthouseFailed: 0,
    currentPhase: "crawling",
    workflowInstanceId: "wf-1",
    startedAt: 1,
    completedAt: null,
    organizationId: "org-1",
  };
}

describe("AuditService.cancelAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flips a running audit to cancelled and reports it", async () => {
    repo.getAuditForProject.mockResolvedValue(getAuditResult("running"));
    repo.cancelAudit.mockResolvedValue(true);

    const result = await AuditService.cancelAudit({
      actorUserId: "u1",
      auditId: "a1",
      projectId: "p1",
    });

    expect(repo.cancelAudit).toHaveBeenCalledWith("a1", "p1");
    expect(result).toEqual({ auditId: "a1", status: "cancelled" });
  });

  it("throws NOT_FOUND for an audit outside the project", async () => {
    repo.getAuditForProject.mockResolvedValue(null);

    await expect(
      AuditService.cancelAudit({
        actorUserId: "u1",
        auditId: "a1",
        projectId: "p1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(repo.cancelAudit).not.toHaveBeenCalled();
  });

  it("refuses to cancel a terminal audit", async () => {
    repo.getAuditForProject.mockResolvedValue(getAuditResult("completed"));

    await expect(
      AuditService.cancelAudit({
        actorUserId: "u1",
        auditId: "a1",
        projectId: "p1",
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(repo.cancelAudit).not.toHaveBeenCalled();
  });

  it("falls back to the reconciled status when the flip loses a race", async () => {
    // The workflow finalized between the status read and the update.
    repo.getAuditForProject
      .mockResolvedValueOnce(getAuditResult("running"))
      .mockResolvedValueOnce(getAuditResult("completed_partial"));
    repo.cancelAudit.mockResolvedValue(false);

    const result = await AuditService.cancelAudit({
      actorUserId: "u1",
      auditId: "a1",
      projectId: "p1",
    });

    expect(result).toEqual({ auditId: "a1", status: "completed_partial" });
  });
});
