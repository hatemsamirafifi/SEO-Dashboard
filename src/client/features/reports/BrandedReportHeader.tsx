import type { BrandingSnapshot } from "@/shared/reports";

function BrandLogo({ r2Key, name }: { r2Key: string; name: string }) {
  return (
    <img
      src={`/api/brand-logo?key=${encodeURIComponent(r2Key)}`}
      alt={`${name} logo`}
      className="h-10 max-w-40 object-contain"
    />
  );
}

/**
 * Frozen agency+client header (the branding preview). Null snapshots render
 * the default OpenSEO header — branding is never invented.
 */
export function BrandedReportHeader({
  branding,
  defaultTitle,
  periodLabel,
}: {
  branding: BrandingSnapshot | null;
  defaultTitle: string;
  periodLabel: string;
}) {
  const agency = branding?.agency;
  const client = branding?.client;
  return (
    <header
      className="rounded-xl border border-base-300 bg-base-100 p-4"
      style={
        agency?.accentColor
          ? { borderTop: `4px solid ${agency.accentColor}` }
          : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-4">
        {agency?.logoR2Key ? (
          <BrandLogo r2Key={agency.logoR2Key} name={agency.name} />
        ) : null}
        <div>
          <p className="text-sm text-base-content/60">
            {agency ? agency.name : "OpenSEO"}
            {client ? ` for ${client.name}` : ""}
          </p>
          <h1 className="text-xl font-semibold">
            {client?.titleOverride ?? defaultTitle}
          </h1>
          <p className="text-sm text-base-content/60">{periodLabel}</p>
        </div>
        {client?.logoR2Key ? (
          <div className="ml-auto">
            <BrandLogo r2Key={client.logoR2Key} name={client.name} />
          </div>
        ) : null}
      </div>
      {agency?.footerText ? (
        <p className="mt-3 text-sm text-base-content/60">{agency.footerText}</p>
      ) : null}
    </header>
  );
}
