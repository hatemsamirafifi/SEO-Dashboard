import type { Dispatch, SetStateAction } from "react";
import { Loader2 } from "lucide-react";
import { GoogleAdsOverviewSection } from "./GoogleAdsOverviewSection";
import { GoogleAdsBreakdownsSection } from "./GoogleAdsBreakdownsSection";
import {
  GOOGLE_ADS_RANGE_OPTIONS,
  type GoogleAdsRangePreset,
} from "./googleAdsCopy";
import type {
  GoogleAdsAnalyticsOverview,
  GoogleAdsCampaignBreakdown,
  GoogleAdsDeviceBreakdown,
  GoogleAdsKeywordBreakdown,
  GoogleAdsLandingPageBreakdown,
  GoogleAdsSearchTermBreakdown,
} from "./googleAdsTypes";

/** The honest, busy view: toolbar + overview + every breakdown table. All
 *  numbers come from the stored-data queries; a breakdown still loading
 *  renders empty instead of fabricated. */

export type GoogleAdsFilters = {
  preset: GoogleAdsRangePreset;
  startDate: string | null;
  endDate: string | null;
  searchTextLike: string;
  campaignResourceId: string;
};

export type GoogleAdsBreakdowns = {
  campaigns: GoogleAdsCampaignBreakdown | null;
  keywords: GoogleAdsKeywordBreakdown | null;
  searchTerms: GoogleAdsSearchTermBreakdown | null;
  devices: GoogleAdsDeviceBreakdown | null;
  landingPages: GoogleAdsLandingPageBreakdown | null;
};

export function GoogleAdsDataView({
  overview,
  currencyCode,
  filters,
  setFilters,
  campaigns,
  breakdowns,
  isFetching,
}: {
  overview: GoogleAdsAnalyticsOverview;
  currencyCode: string | null;
  filters: GoogleAdsFilters;
  setFilters: Dispatch<SetStateAction<GoogleAdsFilters>>;
  campaigns: GoogleAdsCampaignBreakdown | null;
  breakdowns: GoogleAdsBreakdowns;
  isFetching: boolean;
}) {
  return (
    <>
      <Toolbar
        filters={filters}
        setFilters={setFilters}
        campaigns={campaigns}
        isFetching={isFetching}
      />
      <GoogleAdsOverviewSection
        overview={overview}
        currencyCode={currencyCode}
      />
      <GoogleAdsBreakdownsSection {...breakdowns} currencyCode={currencyCode} />
    </>
  );
}

function Toolbar({
  filters,
  setFilters,
  campaigns,
  isFetching,
}: {
  filters: GoogleAdsFilters;
  setFilters: Dispatch<SetStateAction<GoogleAdsFilters>>;
  campaigns: GoogleAdsCampaignBreakdown | null;
  isFetching: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 border-b border-base-300 p-4">
      <label className="form-control w-40">
        <span className="label-text pb-1 text-xs">Date range</span>
        <select
          className="select select-bordered select-sm w-full"
          value={filters.preset}
          onChange={(event) => {
            const preset = GOOGLE_ADS_RANGE_OPTIONS.find(
              (option) => option.value === event.target.value,
            )?.value;
            if (!preset) return;
            setFilters((f) => ({ ...f, preset }));
          }}
        >
          {GOOGLE_ADS_RANGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {filters.preset === "custom" ? (
        <>
          <label className="form-control w-40">
            <span className="label-text pb-1 text-xs">Start</span>
            <input
              type="date"
              className="input input-bordered input-sm"
              value={filters.startDate ?? ""}
              onChange={(event) =>
                setFilters((f) => ({ ...f, startDate: event.target.value }))
              }
            />
          </label>
          <label className="form-control w-40">
            <span className="label-text pb-1 text-xs">End</span>
            <input
              type="date"
              className="input input-bordered input-sm"
              value={filters.endDate ?? ""}
              onChange={(event) =>
                setFilters((f) => ({ ...f, endDate: event.target.value }))
              }
            />
          </label>
        </>
      ) : null}
      <label className="form-control w-56">
        <span className="label-text pb-1 text-xs">Search term filter</span>
        <input
          type="search"
          className="input input-bordered input-sm"
          value={filters.searchTextLike}
          placeholder="Contains…"
          onChange={(event) =>
            setFilters((f) => ({ ...f, searchTextLike: event.target.value }))
          }
        />
      </label>
      <label className="form-control min-w-56">
        <span className="label-text pb-1 text-xs">Campaign focus</span>
        <select
          className="select select-bordered select-sm w-full"
          value={filters.campaignResourceId}
          onChange={(event) =>
            setFilters((f) => ({
              ...f,
              campaignResourceId: event.target.value,
            }))
          }
        >
          <option value="">All campaigns</option>
          {(campaigns?.campaigns ?? []).map((campaign) => (
            <option
              key={campaign.campaignResourceId}
              value={campaign.campaignResourceId}
            >
              {campaign.campaignName ?? campaign.campaignResourceId}
            </option>
          ))}
        </select>
      </label>
      {isFetching ? (
        <span className="flex items-center gap-2 pb-1 text-xs text-base-content/50">
          <Loader2 className="size-3.5 animate-spin" /> Updating…
        </span>
      ) : null}
    </div>
  );
}
