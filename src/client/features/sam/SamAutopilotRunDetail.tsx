import { Link } from "@tanstack/react-router";
import {
  AUTOPILOT_MAX_TOOL_CALLS,
  AUTOPILOT_WORKFLOW_LABELS,
  isAutopilotRunActive,
  isAutopilotRunStatus,
  isAutopilotWorkflowType,
} from "@/shared/autopilot";
import {
  attemptNote,
  correlationRows,
  monthlySummary,
  recommendationCards,
  runStatusLabel,
  technicalFacts,
  type AutopilotAttemptLike,
  type AutopilotRunLike,
  type AutopilotStepLike,
} from "./autopilotEvidence";

export function RunDetail({
  projectId,
  view,
  onCancel,
  onResume,
  cancelPending,
  resumePending,
}: {
  projectId: string;
  view: {
    run: AutopilotRunLike;
    attempts: AutopilotAttemptLike[];
    steps: AutopilotStepLike[];
  };
  onCancel: () => void;
  onResume: () => void;
  cancelPending: boolean;
  resumePending: boolean;
}) {
  const active =
    isAutopilotRunStatus(view.run.status) &&
    isAutopilotRunActive(view.run.status);
  const cards = recommendationCards(view.steps);
  const correlations = correlationRows(view.steps);
  const facts = technicalFacts(view.steps);
  const monthly = monthlySummary(view.steps);
  const totalToolCalls = view.steps.reduce(
    (sum, step) => sum + (step.toolCalls ?? 0),
    0,
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-base-300 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {isAutopilotWorkflowType(view.run.workflowType)
            ? AUTOPILOT_WORKFLOW_LABELS[view.run.workflowType]
            : view.run.workflowType}{" "}
          ·{" "}
          {isAutopilotRunStatus(view.run.status)
            ? runStatusLabel(view.run.status)
            : view.run.status}
        </p>
        <div className="flex gap-2">
          {active ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={cancelPending}
              onClick={onCancel}
            >
              Cancel
            </button>
          ) : view.run.status === "cancelled" ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              disabled={resumePending}
              onClick={onResume}
            >
              Resume
            </button>
          ) : null}
        </div>
      </div>

      {view.run.status === "failed" && view.run.error ? (
        <div className="rounded-lg border border-error/30 bg-error/10 p-3 text-xs text-error">
          <p className="font-semibold">{view.run.errorClass ?? "Error"}</p>
          <p className="mt-0.5">{view.run.error}</p>
        </div>
      ) : null}

      <ol className="flex flex-col gap-1">
        {view.steps.map((step) => (
          <li
            key={step.seq}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span>
              {step.seq + 1}. {step.name}
              <span className="text-xs text-base-content/50">
                {" "}
                · {step.kind}
              </span>
            </span>
            <span className="text-xs text-base-content/60">{step.status}</span>
          </li>
        ))}
      </ol>

      {view.attempts.length > 1 ||
      view.attempts[0]?.status === "invalidated" ? (
        <ul className="flex flex-col gap-1 text-xs text-base-content/60">
          {view.attempts.map((attempt) => (
            <li key={attempt.id}>{attemptNote(attempt)}</li>
          ))}
        </ul>
      ) : null}

      {correlations.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Signal overlap</p>
          <ul className="flex flex-col gap-1 text-sm">
            {correlations.map((row) => (
              <li key={row.entity} className="text-base-content/80">
                {row.entity} — {row.agreement} ({row.signals} signal
                {row.signals === 1 ? "" : "s"})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {facts ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Findings</p>
          <p className="text-xs text-base-content/60">
            Audit coverage: {facts.coverageState}
          </p>
          {facts.rankedIssues.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm">
              {facts.rankedIssues.map((issue) => (
                <li
                  key={`${issue.severity}:${issue.type}`}
                  className="text-base-content/80"
                >
                  {issue.type} — {issue.severity} ({issue.count}{" "}
                  {issue.count === 1 ? "page" : "pages"})
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {monthly ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">What changed</p>
          {monthly.changed.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm">
              {monthly.changed.map((row) => (
                <li
                  key={`${row.source}:${row.metric}`}
                  className="text-base-content/80"
                >
                  {row.metric}: {row.monthValue ?? "—"} vs{" "}
                  {row.priorValue ?? "—"}
                  {row.agreement === "single_source" ? " (provisional)" : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {monthly.ratios.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm text-base-content/70">
              {monthly.ratios.map((row) => (
                <li key={row.metric}>
                  {row.metric}: {row.monthValue ?? "—"} vs{" "}
                  {row.priorValue ?? "—"}
                </li>
              ))}
            </ul>
          ) : null}
          {monthly.unavailable.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs text-base-content/60">
              {monthly.unavailable.map((row) => (
                <li key={row.source}>
                  {row.source}: {row.reason}
                </li>
              ))}
            </ul>
          ) : null}
          {monthly.unresolved.length > 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">Unresolved</p>
              <ul className="flex flex-col gap-1 text-sm">
                {monthly.unresolved.map((row) => (
                  <li
                    key={`${row.kind}:${row.label}:${row.title}`}
                    className="text-base-content/80"
                  >
                    {row.title} — {row.label}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {cards.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Summary</p>
          {cards.map((card) => (
            <div key={card.key} className="rounded-lg bg-base-200 p-3 text-sm">
              <p className="font-medium">{card.suggestedAction}</p>
              <p className="mt-1 text-base-content/70">
                {card.reasoningSummary}
              </p>
              <p className="mt-1 text-xs text-base-content/60">
                Confidence
                {card.confidenceValue !== null
                  ? ` ${card.confidenceValue}`
                  : ""}
                {card.confidenceWhy ? ` — ${card.confidenceWhy}` : ""}
              </p>
              <p className="mt-1 text-xs text-base-content/50">
                {card.dataSource}
              </p>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Link
              to="/p/$projectId/opportunities"
              params={{ projectId }}
              className="btn btn-outline btn-xs self-start"
            >
              Open opportunities
            </Link>
            {view.run.workflowType === "monthly_review" ? (
              <Link
                to="/p/$projectId/reports"
                params={{ projectId }}
                className="btn btn-outline btn-xs self-start"
              >
                Open reports
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between text-xs text-base-content/40">
        <span>
          {view.run.evidenceHash
            ? `Evidence ${view.run.evidenceHash.slice(0, 12)}`
            : ""}
        </span>
        <span>
          Tool calls: {totalToolCalls} / {AUTOPILOT_MAX_TOOL_CALLS}
        </span>
      </div>
    </div>
  );
}
