import { SeRankingSettingsCard } from "./SeRankingSettingsCard";
import { DataforseoSettingsSection } from "./DataforseoSettingsSection";
import { AdditionalSerpProviderCard } from "./AdditionalSerpProviderCard";

export function SerpProvidersSettingsSection({
  projectId,
}: {
  projectId?: string;
}) {
  return (
    <div className="space-y-4">
      <SeRankingSettingsCard projectId={projectId} />
      <DataforseoSettingsSection
        scope={projectId ? "project" : "organization"}
        projectId={projectId}
      />
      <AdditionalSerpProviderCard provider="serper" projectId={projectId} />
      <AdditionalSerpProviderCard provider="zenserp" projectId={projectId} />
    </div>
  );
}
