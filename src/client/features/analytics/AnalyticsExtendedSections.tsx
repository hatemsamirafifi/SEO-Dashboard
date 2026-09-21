import type {
  AnalyticsAudienceResult,
  AnalyticsConversionsResult,
  AnalyticsEcommerceResult,
  AnalyticsEventRow,
  AnalyticsEventsResult,
} from "@/server/features/ga4/services/AnalyticsService";
import { formatDelta, formatPctChange } from "./analyticsCopy";
import {
  SectionError,
  SectionLoading,
  StatCard,
  formatCount,
} from "./AnalyticsSections";

function formatCurrency(value: number, currencyCode: string | null): string {
  if (!currencyCode) return value.toLocaleString("en-US");
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
    }).format(value);
  } catch {
    return `${value.toLocaleString("en-US")} ${currencyCode}`;
  }
}

export function EventsTable({
  rows,
  title,
  emptyNote,
  showKeyBadge,
}: {
  rows: AnalyticsEventRow[];
  title: string;
  emptyNote: string;
  showKeyBadge: boolean;
}) {
  if (rows.length === 0) {
    return <div className="p-4 text-sm text-base-content/60">{emptyNote}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            <th>Event</th>
            {showKeyBadge ? <th>Key</th> : null}
            <th className="text-right">Count</th>
            <th className="text-right">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.eventName}>
              <td className="max-w-xs truncate" title={row.eventName}>
                {row.eventName}
              </td>
              {showKeyBadge ? (
                <td>
                  {row.isKeyEvent ? (
                    <span className="badge badge-primary badge-xs">Key</span>
                  ) : null}
                </td>
              ) : null}
              <td className="text-right">
                {formatCount(row.eventCount.current)}
              </td>
              <td className="text-right">
                {formatDelta(row.eventCount.change)} (
                {formatPctChange(row.eventCount.pctChange)})
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EventsSection({
  result,
  pending,
  queryError,
}: {
  result: AnalyticsEventsResult | undefined;
  pending: boolean;
  queryError: unknown;
}) {
  if (pending) return <SectionLoading label="events" />;
  if (queryError) return <SectionError error={queryError} />;
  if (!result || !result.connected) return null;
  return (
    <>
      <EventsTable
        rows={result.rows}
        title="Events"
        emptyNote="No events in this period."
        showKeyBadge
      />
      {result.reservedFilterNote ? (
        <p className="mt-2 text-xs text-base-content/60">
          {result.reservedFilterNote}
        </p>
      ) : null}
    </>
  );
}

export function ConversionsSection({
  result,
  pending,
  queryError,
}: {
  result: AnalyticsConversionsResult | undefined;
  pending: boolean;
  queryError: unknown;
}) {
  if (pending) return <SectionLoading label="conversions" />;
  if (queryError) return <SectionError error={queryError} />;
  if (!result || !result.connected) return null;
  return (
    <>
      <EventsTable
        rows={result.rows}
        title="Conversions"
        emptyNote="No key events in this period."
        showKeyBadge={false}
      />
      <p className="mt-2 text-xs text-base-content/60">
        {result.goalSelectionDeferredNote}
      </p>
      {result.reservedFilterNote ? (
        <p className="mt-1 text-xs text-base-content/60">
          {result.reservedFilterNote}
        </p>
      ) : null}
    </>
  );
}

export function EcommerceSection({
  result,
  pending,
  queryError,
}: {
  result: AnalyticsEcommerceResult | undefined;
  pending: boolean;
  queryError: unknown;
}) {
  if (pending) return <SectionLoading label="ecommerce" />;
  if (queryError) return <SectionError error={queryError} />;
  if (!result || !result.connected) return null;
  if (!result.available) {
    return (
      <div className="p-4 text-sm text-base-content/60">
        Ecommerce is hidden for this property: no purchase activity has been
        observed, so showing zero revenue would be misleading.
      </div>
    );
  }
  const currency = result.currencyCode;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="Revenue"
          delta={result.totals.totalRevenue}
          format={(value) => formatCurrency(value, currency)}
        />
        <StatCard
          label="Purchase revenue"
          delta={result.totals.purchaseRevenue}
          format={(value) => formatCurrency(value, currency)}
        />
        <StatCard
          label="Transactions"
          delta={result.totals.transactions}
          format={formatCount}
        />
        <StatCard
          label="Add to carts"
          delta={result.totals.addToCarts}
          format={formatCount}
        />
        <StatCard
          label="Checkouts"
          delta={result.totals.checkouts}
          format={formatCount}
        />
      </div>
      <p className="mt-2 text-xs text-base-content/60">{result.currencyNote}</p>
      {result.reservedFilterNote ? (
        <p className="mt-1 text-xs text-base-content/60">
          {result.reservedFilterNote}
        </p>
      ) : null}
    </>
  );
}

export function AudienceSection({
  result,
  pending,
  queryError,
}: {
  result: AnalyticsAudienceResult | undefined;
  pending: boolean;
  queryError: unknown;
}) {
  if (pending) return <SectionLoading label="audience" />;
  if (queryError) return <SectionError error={queryError} />;
  if (!result || !result.connected) return null;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard
          label="New users"
          delta={result.totals.newUsers}
          format={formatCount}
          footnote="New on each day"
        />
      </div>
      <p className="mt-2 text-xs text-base-content/60">
        {result.newUsersFootnote} {result.distinctUsersNote}
      </p>
      <p className="mt-1 text-xs text-base-content/60">
        {result.geoTechDeferredNote}
      </p>
      {result.reservedFilterNote ? (
        <p className="mt-1 text-xs text-base-content/60">
          {result.reservedFilterNote}
        </p>
      ) : null}
    </>
  );
}
