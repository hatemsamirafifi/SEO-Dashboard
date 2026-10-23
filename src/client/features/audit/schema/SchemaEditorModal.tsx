import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Copy, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getAuditPageSchema } from "@/serverFunctions/audit";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { downloadFile } from "@/client/lib/download";
import type { SchemaEntityType } from "@/shared/schema-types";

interface SchemaEditorPage {
  id: string;
  url: string;
  pageType: string | null;
  extractionState: string;
}

const DIFF_BADGE: Record<string, string> = {
  kept: "badge-ghost",
  added: "badge-success",
  changed: "badge-warning",
  conflicting: "badge-error",
  existing_only: "badge-info",
};

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return json ?? "null";
}

function fileSlug(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const last = path.split("/").filter(Boolean).at(-1) ?? "page";
    return last.replace(/[^a-z0-9-]+/gi, "-").slice(0, 40) || "page";
  } catch {
    return "page";
  }
}

export function SchemaEditorModal({
  projectId,
  auditId,
  page,
  onClose,
}: {
  projectId: string;
  auditId: string;
  page: SchemaEditorPage;
  onClose: () => void;
}) {
  const [selectedType, setSelectedType] = useState<SchemaEntityType | null>(
    null,
  );
  const [confirmed, setConfirmed] = useState(false);

  const query = useQuery({
    queryKey: ["audit-page-schema", projectId, auditId, page.id, selectedType],
    queryFn: () =>
      getAuditPageSchema({
        data: {
          projectId,
          auditId,
          pageId: page.id,
          ...(selectedType ? { type: selectedType } : {}),
        },
      }),
  });

  const data = query.data;
  const proposal = data?.proposal ?? null;
  const diff = data?.diff ?? null;
  const validation = data?.validation ?? null;
  const json = proposal ? JSON.stringify(proposal.jsonLd, null, 2) : null;
  const needsConfirmation = Boolean(
    diff?.entries.some(
      (entry) => entry.status === "changed" || entry.status === "conflicting",
    ),
  );
  const canExport = Boolean(json) && (!needsConfirmation || confirmed);

  const chooseType = (type: SchemaEntityType) => {
    setSelectedType(type);
    setConfirmed(false);
  };

  const copyJson = () => {
    if (!json) return;
    void navigator.clipboard.writeText(json).then(
      () => toast.success("JSON-LD copied."),
      () => toast.error("Copy failed - select the JSON manually."),
    );
  };

  const exportJson = () => {
    if (!json || !selectedType) return;
    downloadFile(
      json,
      `schema-${selectedType.toLowerCase()}-${fileSlug(page.url)}.json`,
      "application/ld+json",
    );
  };

  return (
    <div
      className="modal modal-open"
      role="dialog"
      aria-modal="true"
      aria-label="Schema editor"
      data-testid="schema-editor"
    >
      <div className="modal-box max-w-3xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Schema editor</h2>
            <p className="truncate text-sm text-base-content/70">{page.url}</p>
          </div>
          <span className="badge badge-ghost shrink-0">
            {page.pageType ?? "unclassified"}
          </span>
        </div>

        {query.isPending ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin" />
          </div>
        ) : query.isError ? (
          <div className="alert alert-error mt-4">
            <AlertCircle className="size-5" />
            <span>
              {getStandardErrorMessage(
                query.error,
                "Could not load the schema proposal.",
              )}
            </span>
          </div>
        ) : !data ? (
          <div className="alert alert-error mt-4">
            <AlertCircle className="size-5" />
            <span>This page is not part of the selected audit.</span>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <section>
              <h3 className="mb-2 text-sm font-medium">
                Generatable types for this page
              </h3>
              <div className="flex flex-wrap gap-2">
                {data.availableTypes.map((entry) => (
                  <button
                    key={entry.type}
                    type="button"
                    className={`btn btn-sm ${selectedType === entry.type ? "btn-primary" : "btn-outline"}`}
                    disabled={!entry.ok}
                    title={entry.ok ? undefined : entry.reasons.join("; ")}
                    onClick={() => chooseType(entry.type)}
                    data-testid={`schema-type-${entry.type}`}
                  >
                    {entry.type}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-base-content/60">
                Every property is generated from evidence this audit already
                stored. Missing values are omitted, never guessed.
              </p>
            </section>

            {data.requestedType && !proposal && (
              <div className="alert alert-warning">
                <AlertCircle className="size-5" />
                <div>
                  <p className="font-medium">
                    {data.requestedType} cannot be generated for this page.
                  </p>
                  <ul className="mt-1 list-inside list-disc text-sm">
                    {data.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {proposal && validation && (
              <>
                <section className="flex flex-wrap items-center gap-2">
                  <span
                    className={`badge ${validation.valid ? "badge-success" : "badge-error"}`}
                  >
                    {validation.valid ? "Structurally valid" : "Invalid"}
                  </span>
                  <span
                    className={`badge ${
                      validation.richResultEligible === null
                        ? "badge-ghost"
                        : validation.richResultEligible
                          ? "badge-success"
                          : "badge-warning"
                    }`}
                  >
                    {validation.richResultEligible === null
                      ? "No rich-result feature"
                      : validation.richResultEligible
                        ? "Rich-result eligible"
                        : "Not rich-result eligible"}
                  </span>
                  {validation.missingRichResultRequired.length > 0 && (
                    <span className="text-sm text-base-content/70">
                      Missing required:{" "}
                      {validation.missingRichResultRequired.join(", ")}
                    </span>
                  )}
                </section>

                {validation.errors.length > 0 && (
                  <ul className="list-inside list-disc text-sm text-error">
                    {validation.errors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                )}

                {diff && diff.entries.length > 0 && (
                  <section data-testid="schema-diff">
                    <h3 className="mb-2 text-sm font-medium">
                      Existing vs proposed
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="table table-sm">
                        <thead>
                          <tr>
                            <th>Property</th>
                            <th>Status</th>
                            <th>Existing</th>
                            <th>Proposed</th>
                            <th>Source</th>
                          </tr>
                        </thead>
                        <tbody>
                          {diff.entries.map((entry) => (
                            <tr key={`${entry.path}-${entry.status}`}>
                              <td className="font-mono text-xs">
                                {entry.path}
                              </td>
                              <td>
                                <span
                                  className={`badge badge-sm ${DIFF_BADGE[entry.status] ?? "badge-ghost"}`}
                                >
                                  {entry.status.replace("_", " ")}
                                </span>
                              </td>
                              <td className="max-w-48 truncate font-mono text-xs">
                                {formatValue(entry.existing)}
                              </td>
                              <td className="max-w-48 truncate font-mono text-xs">
                                {formatValue(entry.proposed)}
                              </td>
                              <td className="text-xs text-base-content/60">
                                {entry.source ?? "-"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {diff.notes.length > 0 && (
                      <ul className="mt-2 list-inside list-disc text-xs text-base-content/60">
                        {diff.notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}

                {needsConfirmation && (
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-warning checkbox-sm mt-0.5"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                      data-testid="schema-confirm"
                    />
                    <span>
                      I reviewed the changed and conflicting values above. The
                      existing markup is never edited automatically - export
                      only replaces what I choose to publish.
                    </span>
                  </label>
                )}

                <section>
                  <h3 className="mb-2 text-sm font-medium">JSON-LD preview</h3>
                  <pre
                    className="max-h-72 overflow-auto rounded-lg bg-base-200 p-3 text-xs"
                    data-testid="schema-json"
                  >
                    {json}
                  </pre>
                  {proposal.notes.length > 0 && (
                    <ul className="mt-2 list-inside list-disc text-xs text-base-content/60">
                      {proposal.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  )}
                </section>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={!canExport}
                    onClick={copyJson}
                    data-testid="schema-copy"
                  >
                    <Copy className="size-4" />
                    Copy JSON-LD
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!canExport}
                    onClick={exportJson}
                    data-testid="schema-export"
                  >
                    <Download className="size-4" />
                    Export JSON-LD
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <div className="modal-action">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            data-testid="schema-close"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
