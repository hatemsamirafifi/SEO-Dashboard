import type { UseQueryResult } from "@tanstack/react-query";
import type {
  AnalyticsAcquisitionResult,
  AnalyticsAudienceResult,
  AnalyticsConversionsResult,
  AnalyticsEcommerceResult,
  AnalyticsEventsResult,
  AnalyticsGeoResult,
  AnalyticsLandingResult,
  AnalyticsOverviewResult,
  AnalyticsTechnologyResult,
} from "@/server/features/ga4/services/AnalyticsService";
import type { getSearchPerformanceTable } from "@/serverFunctions/searchPerformance";

type SearchPerformanceTableResult = Awaited<
  ReturnType<typeof getSearchPerformanceTable>
>;
import {
  AcquisitionSection,
  CoverageBadge,
  OverviewSection,
} from "./AnalyticsSections";
import { LandingSection } from "./AnalyticsLandingSections";
import {
  AudienceSection,
  ConversionsSection,
  EcommerceSection,
  EventsSection,
} from "./AnalyticsExtendedSections";
import {
  GeographySection,
  TechnologySection,
} from "./AnalyticsGeoTechSections";
import { GoalsManager } from "./GoalsManager";

export interface AnalyticsContentSectionsProps {
  projectId: string;
  overviewQuery: UseQueryResult<AnalyticsOverviewResult>;
  acquisitionQuery: UseQueryResult<AnalyticsAcquisitionResult>;
  organicQuery: UseQueryResult<AnalyticsAcquisitionResult>;
  landingQuery: UseQueryResult<AnalyticsLandingResult>;
  gscPagesQuery: UseQueryResult<SearchPerformanceTableResult>;
  eventsQuery: UseQueryResult<AnalyticsEventsResult>;
  conversionsQuery: UseQueryResult<AnalyticsConversionsResult>;
  ecommerceQuery: UseQueryResult<AnalyticsEcommerceResult>;
  audienceQuery: UseQueryResult<AnalyticsAudienceResult>;
  geoQuery: UseQueryResult<AnalyticsGeoResult>;
  prevGeoQuery: UseQueryResult<AnalyticsGeoResult>;
  techQuery: UseQueryResult<AnalyticsTechnologyResult>;
  prevTechQuery: UseQueryResult<AnalyticsTechnologyResult>;
  techDimension: "device" | "browser" | "os";
  setTechDimension: (dim: "device" | "browser" | "os") => void;
}

export function AnalyticsContentSections({
  projectId,
  overviewQuery,
  acquisitionQuery,
  organicQuery,
  landingQuery,
  gscPagesQuery,
  eventsQuery,
  conversionsQuery,
  ecommerceQuery,
  audienceQuery,
  geoQuery,
  prevGeoQuery,
  techQuery,
  prevTechQuery,
  techDimension,
  setTechDimension,
}: AnalyticsContentSectionsProps) {
  const overview = overviewQuery.data;

  return (
    <div className="space-y-6 p-4">
      <section aria-label="Overview">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="font-semibold">Overview</h2>
          <CoverageBadge result={overview} />
        </div>
        <OverviewSection
          result={overview}
          pending={overviewQuery.isPending}
          queryError={overviewQuery.isError ? overviewQuery.error : null}
        />
      </section>

      <section aria-label="Acquisition">
        <h2 className="mb-2 font-semibold">Acquisition</h2>
        <AcquisitionSection
          result={acquisitionQuery.data}
          pending={acquisitionQuery.isPending}
          queryError={acquisitionQuery.isError ? acquisitionQuery.error : null}
          title="Acquisition"
          emptyNote="No acquisition rows in this period."
        />
      </section>

      <section aria-label="Organic">
        <h2 className="mb-2 font-semibold">Organic</h2>
        <AcquisitionSection
          result={organicQuery.data}
          pending={organicQuery.isPending}
          queryError={organicQuery.isError ? organicQuery.error : null}
          title="Organic acquisition"
          emptyNote="No organic rows in this period."
        />
      </section>

      <section aria-label="Landing pages">
        <h2 className="mb-2 font-semibold">Landing pages</h2>
        <LandingSection
          projectId={projectId}
          result={landingQuery.data}
          gscPages={
            gscPagesQuery.data?.connected ? gscPagesQuery.data.rows : undefined
          }
          pending={landingQuery.isPending}
          queryError={landingQuery.isError ? landingQuery.error : null}
        />
      </section>

      <section aria-label="Events">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="font-semibold">Events</h2>
          <CoverageBadge result={eventsQuery.data} />
        </div>
        <EventsSection
          result={eventsQuery.data}
          pending={eventsQuery.isPending}
          queryError={eventsQuery.isError ? eventsQuery.error : null}
        />
      </section>

      <section aria-label="Conversions">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="font-semibold">Conversions</h2>
          <CoverageBadge result={conversionsQuery.data} />
        </div>
        <ConversionsSection
          result={conversionsQuery.data}
          pending={conversionsQuery.isPending}
          queryError={conversionsQuery.isError ? conversionsQuery.error : null}
        />
      </section>

      <section aria-label="Ecommerce">
        <h2 className="mb-2 font-semibold">Ecommerce</h2>
        <EcommerceSection
          result={ecommerceQuery.data}
          pending={ecommerceQuery.isPending}
          queryError={ecommerceQuery.isError ? ecommerceQuery.error : null}
        />
      </section>

      <section aria-label="Audience">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="font-semibold">Audience</h2>
          <CoverageBadge result={audienceQuery.data} />
        </div>
        <AudienceSection
          result={audienceQuery.data}
          pending={audienceQuery.isPending}
          queryError={audienceQuery.isError ? audienceQuery.error : null}
        />
      </section>

      <section aria-label="Geography">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="font-semibold">Geography</h2>
          <CoverageBadge result={geoQuery.data} />
        </div>
        <GeographySection
          result={geoQuery.data}
          prevResult={prevGeoQuery.data}
          pending={geoQuery.isPending}
          queryError={geoQuery.isError ? geoQuery.error : null}
        />
      </section>

      <section aria-label="Technology">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="font-semibold">Technology</h2>
          <CoverageBadge result={techQuery.data} />
        </div>
        <TechnologySection
          dimension={techDimension}
          onDimensionChange={setTechDimension}
          result={techQuery.data}
          prevResult={prevTechQuery.data}
          pending={techQuery.isPending}
          queryError={techQuery.isError ? techQuery.error : null}
        />
      </section>

      <GoalsManager projectId={projectId} />
    </div>
  );
}
