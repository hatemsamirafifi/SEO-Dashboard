import {
  scrubGlobalTraceText,
  type GlobalTraceKeywordChild,
  type GlobalTraceProviderCall,
} from "@/shared/globalTraceTypes";
import { parseDataforseoDiagnosticsFromErrorMessage } from "@/shared/dataforseoDiagnosticsParser";
import type {
  RankCompletionPatch,
  RankRowForTrace,
  RankRunForTrace,
} from "./rankTraceCompletion";

export function providerLabel(provider: string | null | undefined): string {
  if (provider === "seranking") return "SE Ranking";
  if (provider === "dataforseo") return "DataForSEO";
  if (provider === "serper") return "Serper.dev";
  if (provider === "zenserp") return "Zenserp";
  return provider ?? "DataForSEO";
}

export function isFreshSnapshot(
  checkedAt: string | null | undefined,
  runStartedAt: string | null | undefined,
): boolean {
  if (!checkedAt) return false;
  if (!runStartedAt) return true;
  return checkedAt >= runStartedAt;
}

export const PROVIDER_MARKER_RE =
  /DataForSEO HTTP \d{3}|DataForSEO task error \(\d+\)/i;

function buildMissingSnapshotChild(
  id: string,
  row: RankRowForTrace | undefined,
  run: RankRunForTrace,
): GlobalTraceKeywordChild {
  if (run.status === "cancelled") {
    return {
      keywordId: id,
      keyword: row?.keyword,
      status: "cancelled",
      rankingStatus: "NOT_CHECKED",
      error: "Cancelled before check",
    };
  }

  const hasProviderMarker = run.errorMessage
    ? PROVIDER_MARKER_RE.test(run.errorMessage)
    : false;
  const diag = hasProviderMarker
    ? parseDataforseoDiagnosticsFromErrorMessage(run.errorMessage)
    : null;
  return {
    keywordId: id,
    keyword: row?.keyword,
    status: "failed",
    rankingStatus: "CHECK_FAILED",
    provider: providerLabel(row?.desktop?.provider ?? row?.mobile?.provider),
    httpStatus: diag?.httpStatus ?? undefined,
    taskStatus: diag?.dataforseoStatusCode ?? undefined,
    error: run.errorMessage
      ? scrubGlobalTraceText(run.errorMessage)
      : "No snapshot recorded for this run",
  };
}

function buildFailedDeviceChild(
  id: string,
  row: RankRowForTrace | undefined,
  failedDevice: NonNullable<RankRowForTrace["desktop"]>,
  run: RankRunForTrace,
): GlobalTraceKeywordChild {
  const childErrMsg = failedDevice.errorMessage || run.errorMessage;
  const hasProviderMarker = childErrMsg
    ? PROVIDER_MARKER_RE.test(childErrMsg)
    : false;
  const diag = hasProviderMarker
    ? parseDataforseoDiagnosticsFromErrorMessage(childErrMsg)
    : null;
  const taskStatus =
    failedDevice.providerStatusCode ?? diag?.dataforseoStatusCode ?? undefined;
  const httpStatus = diag?.httpStatus ?? undefined;

  return {
    keywordId: id,
    keyword: row?.keyword,
    status: "failed",
    rankingStatus: "CHECK_FAILED",
    provider: providerLabel(
      failedDevice.provider ?? row?.desktop?.provider ?? row?.mobile?.provider,
    ),
    httpStatus,
    taskStatus,
    error: childErrMsg
      ? scrubGlobalTraceText(childErrMsg)
      : "Rank check attempt failed",
  };
}

type DeviceSnapshot = NonNullable<RankRowForTrace["desktop"]>;

export function buildKeywordChild(
  id: string,
  row: RankRowForTrace | undefined,
  run: RankRunForTrace,
): GlobalTraceKeywordChild {
  // Device names are preserved so the trace can report per-device positions
  // instead of a device-blind aggregate.
  const deviceEntries: Array<{
    device: "desktop" | "mobile";
    snapshot?: DeviceSnapshot | null;
  }> = [
    { device: "desktop", snapshot: row?.desktop },
    { device: "mobile", snapshot: row?.mobile },
  ];
  const fresh = deviceEntries.filter(
    (
      entry,
    ): entry is { device: "desktop" | "mobile"; snapshot: DeviceSnapshot } =>
      entry.snapshot != null &&
      isFreshSnapshot(entry.snapshot.checkedAt, run.startedAt),
  );

  if (fresh.length === 0) {
    return buildMissingSnapshotChild(id, row, run);
  }

  const failedDevice = fresh.find(
    (entry) =>
      entry.snapshot.status === "failed" ||
      entry.snapshot.rankingStatus === "CHECK_FAILED",
  );

  // One entry per fresh device; each pair comes from a SINGLE device.
  const perDevice = fresh.map((entry) => ({
    device: entry.device,
    positionBefore: entry.snapshot.previousPosition ?? null,
    positionAfter: entry.snapshot.position ?? null,
  }));

  if (failedDevice) {
    return {
      ...buildFailedDeviceChild(id, row, failedDevice.snapshot, run),
      devices: perDevice,
    };
  }

  // The aggregate pair must never cross devices: both before and after come
  // from the preferred device (the ranked device if any, else the first one).
  const preferred =
    fresh.find((entry) => entry.snapshot.position != null) ?? fresh[0];
  return {
    keywordId: id,
    keyword: row?.keyword,
    status: preferred.snapshot.position != null ? "success" : "no_result",
    rankingStatus: preferred.snapshot.position != null ? "RANKED" : "NO_RESULT",
    provider: providerLabel(preferred.snapshot.provider),
    positionBefore: preferred.snapshot.previousPosition ?? null,
    positionAfter: preferred.snapshot.position ?? null,
    devices: perDevice,
  };
}

export function applyProviderDiagnostics(
  patch: RankCompletionPatch,
  rawMessage: string,
  succeeded: number,
): boolean {
  if (!PROVIDER_MARKER_RE.test(rawMessage)) return false;
  const d = parseDataforseoDiagnosticsFromErrorMessage(rawMessage);
  const isCreditBlocked = d.errorClass === "CREDITS_UNAVAILABLE";
  const providerCall: GlobalTraceProviderCall = {
    provider: d.provider,
    endpoint: d.endpoint,
    httpStatus: d.httpStatus,
    taskStatus: d.dataforseoStatusCode,
    statusMessage: d.dataforseoStatusMessage,
    transport: d.transport,
    billing: "Paid",
    metered: true,
    budgetGuard: isCreditBlocked ? "BLOCKED" : "PASS",
  };
  patch.providers = [providerCall];
  patch.httpStatus = d.httpStatus ?? undefined;
  patch.errorClass = d.errorClass;
  patch.budget = isCreditBlocked ? "BLOCKED" : "PASS";
  if (isCreditBlocked) {
    patch.blockedReason = scrubGlobalTraceText(rawMessage);
    if (succeeded === 0) {
      patch.providerCalls = 0;
    }
  }
  return true;
}
