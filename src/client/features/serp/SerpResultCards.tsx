/* SERP mobile card view (spec 011, PR7 / S9 UI — T018).
 *
 *  Responsive card list rendering the same stored rows + derived feature
 *  blocks as the dense table (one data path, two layouts). Each card shows
 *  position / result / summary; metrics live behind a per-card disclosure.
 *  Feature blocks join the card rhythm as their own cards. Enrichment
 *  failure annotates explicitly and never hides rows or blocks (FR-006). */
import { useState } from "react";
import {
  familyLabelOf,
  stringField,
  type SerpFeatureBlock,
} from "@/server/features/serp/featurePresentation";

export type SerpResultCardMetrics = {
  status: "available" | "partial" | "unavailable" | "failed";
  domainRank: number | null;
  pageRank: number | null;
  referringDomains: number | null;
  backlinks: number | null;
  etv: number | null;
};

export type SerpResultCardRow = {
  position: number;
  title: string;
  url: string;
  domain: string;
  summary: string | null;
  /** Frozen family keys (see SERP_FEATURE_KEYS) — chips only, never ranks. */
  featureRefs: string[];
  metrics: SerpResultCardMetrics | null;
};

function chipLabel(ref: string): string | null {
  return familyLabelOf(ref);
}

function MetricValue({ value }: { value: number | null }) {
  if (typeof value !== "number") return null;
  return <>{String(value)}</>;
}

function MetricsBody({ metrics }: { metrics: SerpResultCardMetrics }) {
  return (
    <div className="text-xs text-base-content/60 flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
      {metrics.domainRank !== null || metrics.pageRank !== null ? (
        <span>
          DR <MetricValue value={metrics.domainRank} /> · PR{" "}
          <MetricValue value={metrics.pageRank} />
        </span>
      ) : null}
      <span>
        Ref.domains <MetricValue value={metrics.referringDomains} />
      </span>
      <span>
        Links <MetricValue value={metrics.backlinks} />
      </span>
      <span>
        Est.traffic <MetricValue value={metrics.etv} />
      </span>
      {metrics.status !== "available" ? (
        <span className="text-warning">{metrics.status}</span>
      ) : null}
    </div>
  );
}

function ResultCard({
  row,
  expanded,
  onToggle,
}: {
  row: SerpResultCardRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <article
      data-testid="serp-result-card"
      className="rounded-lg border border-base-200 bg-base-100 p-3 min-w-0"
    >
      <div className="flex items-start gap-2 min-w-0">
        <span className="font-mono text-xs text-base-content/50 shrink-0 pt-0.5">
          {row.position}
        </span>
        <div className="min-w-0 flex-1">
          <a
            href={row.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-sm text-primary hover:underline line-clamp-2 break-words"
            title={row.title}
          >
            {row.title || row.url}
          </a>
          <p className="text-xs text-base-content/40 truncate">{row.url}</p>
          {row.summary ? (
            <p className="text-xs text-base-content/60 mt-0.5 line-clamp-2 break-words">
              {row.summary}
            </p>
          ) : null}
          {row.featureRefs.length > 0 ? (
            <div className="flex gap-1 flex-wrap mt-1">
              {row.featureRefs.flatMap((ref) => {
                const label = chipLabel(ref);
                return label ? (
                  <span
                    key={ref}
                    className="badge badge-xs bg-base-300 border-0 text-base-content/70"
                  >
                    {label}
                  </span>
                ) : (
                  []
                );
              })}
            </div>
          ) : null}
          {row.metrics ? (
            <div className="mt-1">
              <button
                type="button"
                data-testid="serp-card-expand"
                aria-expanded={expanded}
                onClick={onToggle}
                className="btn btn-ghost btn-xs px-1"
              >
                {expanded ? "Hide metrics" : "Show metrics"}
              </button>
              {row.metrics.status !== "available" ? (
                <span className="text-xs text-warning ml-1">
                  {row.metrics.status === "failed"
                    ? "metrics unavailable"
                    : `metrics ${row.metrics.status}`}
                </span>
              ) : null}
              {expanded ? <MetricsBody metrics={row.metrics} /> : null}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function FeatureCard({ block }: { block: SerpFeatureBlock }) {
  return (
    <article
      data-testid={`serp-feature-block-${block.family}`}
      className="rounded-lg border border-base-200 bg-base-100 p-3 min-w-0"
    >
      <h4 className="text-xs font-semibold text-base-content/70 mb-1">
        {block.label}
      </h4>
      {block.family === "peopleAlsoAsk" ? (
        <>
          {block.placement !== null ? (
            <p className="text-xs text-base-content/50 mb-1">
              Appears alongside results (observed near placement{" "}
              {block.placement}).
            </p>
          ) : null}
          <ul className="flex flex-col gap-1 max-h-[320px] overflow-y-auto">
            {block.items.map((raw, index) => {
              const question = stringField(raw, "question");
              if (!question) return null;
              return (
                <li
                  key={`${question}-${index}`}
                  className="text-sm rounded bg-base-200/60 px-2 py-1 break-words"
                >
                  {question}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <ul className="flex flex-col gap-1 text-sm min-w-0">
          {block.items.map((raw, index) => {
            const label =
              stringField(raw, "title") ?? stringField(raw, "url") ?? "";
            const url = stringField(raw, "url");
            return (
              <li key={`${label}-${index}`} className="truncate">
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                    title={label}
                  >
                    {label}
                  </a>
                ) : (
                  label
                )}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

type CardNode =
  | { kind: "row"; row: SerpResultCardRow }
  | { kind: "block"; block: SerpFeatureBlock };

/** Interleave feature cards with result cards (spec 011, R3): a block with
 *  recorded placement renders after the result with the largest position at
 *  or above that placement; blocks without placement render after the top
 *  result (post-top-results fallback). Organic positions are never altered —
 *  only card order changes. */
function interleave(
  rows: SerpResultCardRow[],
  blocks: SerpFeatureBlock[],
): CardNode[] {
  const nodes: CardNode[] = rows.map((row) => ({ kind: "row", row }));
  // Insert blocks latest-first so earlier insertions keep their indexes.
  const bySlot = blocks
    .map((block) => {
      let slot = 1;
      if (block.placement !== null) {
        const atOrAbove = rows.filter((r) => r.position <= block.placement!);
        slot =
          atOrAbove.length > 0
            ? Math.max(...atOrAbove.map((r) => r.position))
            : 1;
      }
      return { block, slot };
    })
    .toSorted((a, b) => b.slot - a.slot);
  for (const { block, slot } of bySlot) {
    // Insert AFTER the slot row: at the first row strictly greater than
    // the slot, else append. Rows share the card rhythm; blocks never take
    // a numbered position.
    const after = nodes.findIndex(
      (n) => n.kind === "row" && n.row.position > slot,
    );
    nodes.splice(after === -1 ? nodes.length : after, 0, {
      kind: "block",
      block,
    });
  }
  return nodes;
}

export function SerpResultCards({
  rows,
  blocks,
  expandedPositions = [],
}: {
  rows: SerpResultCardRow[];
  blocks: SerpFeatureBlock[];
  expandedPositions?: number[];
}) {
  const [open, setOpen] = useState<ReadonlySet<number>>(
    () => new Set(expandedPositions),
  );
  if (rows.length === 0 && blocks.length === 0) {
    return (
      <div
        data-testid="serp-results-mobile"
        className="text-sm text-base-content/50 text-center py-8"
      >
        No SERP details available for this keyword yet.
      </div>
    );
  }
  const toggle = (position: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(position)) next.delete(position);
      else next.add(position);
      return next;
    });
  return (
    <div
      data-testid="serp-results-mobile"
      className="flex flex-col gap-2 min-w-0"
    >
      {interleave(rows, blocks).map((node, i) =>
        node.kind === "row" ? (
          <ResultCard
            key={`row-${node.row.position}-${i}`}
            row={node.row}
            expanded={open.has(node.row.position)}
            onToggle={() => toggle(node.row.position)}
          />
        ) : (
          <FeatureCard
            key={`block-${node.block.family}-${i}`}
            block={node.block}
          />
        ),
      )}
    </div>
  );
}
