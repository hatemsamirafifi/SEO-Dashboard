/* SERP feature blocks (spec 011, US1 — T012).
 *
 *  Renders SerpFeatureBlock[] derived by toSerpFeatureBlocks. Absent
 *  families never reach this component (the derivation emits only observed
 *  keys), so there are no placeholders here: absent item fields render
 *  nothing, never dashes or zeros. Item fields are read through runtime
 *  guards (no type assertions) — malformed shapes render as absent, never
 *  crash. PAA placement is observational wording only — feature blocks
 *  never carry numbered positions (S9). */
import {
  numberField,
  stringField,
  type SerpFeatureBlock,
} from "@/server/features/serp/featurePresentation";

function Section({
  block,
  children,
}: {
  block: SerpFeatureBlock;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={`serp-feature-block-${block.family}`}
      className="rounded-lg border border-base-200 bg-base-100 p-3"
    >
      <h4 className="text-xs font-semibold text-base-content/70 mb-2">
        {block.label}
      </h4>
      {children}
    </section>
  );
}

function ExternalLink({ url, label }: { url: string; label: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline truncate"
      title={label}
    >
      {label}
    </a>
  );
}

function MaybeAddress({ item }: { item: unknown }) {
  const address = stringField(item, "address");
  return address ? (
    <span className="text-xs text-base-content/50"> · {address}</span>
  ) : null;
}

function MaybeRating({ item }: { item: unknown }) {
  const rating = numberField(item, "rating");
  if (rating === null) return null;
  const reviewCount = numberField(item, "reviewCount");
  return (
    <span className="text-xs text-base-content/50">
      {" "}
      · {rating}
      {reviewCount === null ? "" : ` (${reviewCount})`}
    </span>
  );
}

export function SerpFeatureBlocks({ blocks }: { blocks: SerpFeatureBlock[] }) {
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 mt-3">
      {blocks.map((block) => (
        <FeatureSection key={block.family} block={block} />
      ))}
    </div>
  );
}

function FeatureSection({ block }: { block: SerpFeatureBlock }) {
  switch (block.family) {
    case "featuredResult": {
      const item = block.items[0];
      if (item === undefined) return null;
      const title = stringField(item, "title");
      const snippet = stringField(item, "snippet");
      const url = stringField(item, "url");
      const domain = stringField(item, "domain");
      return (
        <Section block={block}>
          <p className="text-sm">{snippet ?? title}</p>
          {url ? (
            <p className="text-xs text-base-content/50 mt-1">
              Source: <ExternalLink url={url} label={domain ?? url} />
            </p>
          ) : null}
        </Section>
      );
    }
    case "peopleAlsoAsk":
      return (
        <Section block={block}>
          {block.placement !== null ? (
            <p className="text-xs text-base-content/50 mb-1">
              Appears alongside results (observed near placement{" "}
              {block.placement}).
            </p>
          ) : null}
          <div className="flex flex-col gap-1">
            {block.items.map((raw, index) => {
              const question = stringField(raw, "question");
              if (!question) return null;
              const url = stringField(raw, "url");
              return (
                <details
                  key={`${question}-${index}`}
                  className="text-sm rounded bg-base-200/60 px-2 py-1"
                >
                  <summary className="cursor-pointer">{question}</summary>
                  {url ? (
                    <p className="text-xs mt-1">
                      <ExternalLink url={url} label={url} />
                    </p>
                  ) : null}
                </details>
              );
            })}
          </div>
        </Section>
      );
    case "relatedSearches":
      return (
        <Section block={block}>
          <ul className="flex flex-wrap gap-1">
            {block.items.map((raw, index) => {
              if (typeof raw !== "string" || raw === "") return null;
              return (
                <li
                  key={`${raw}-${index}`}
                  className="badge badge-ghost badge-sm"
                >
                  {raw}
                </li>
              );
            })}
          </ul>
        </Section>
      );
    case "localPack":
      return (
        <Section block={block}>
          <ul className="flex flex-col gap-1">
            {block.items.map((raw, index) => {
              const title = stringField(raw, "title");
              if (!title) return null;
              return (
                <li key={`${title}-${index}`} className="text-sm">
                  <span className="font-medium">{title}</span>
                  <MaybeAddress item={raw} />
                  <MaybeRating item={raw} />
                </li>
              );
            })}
          </ul>
        </Section>
      );
    case "images":
    case "videos":
    case "sitelinks":
      return (
        <Section block={block}>
          <ul className="flex flex-col gap-1 text-sm">
            {block.items.map((raw, index) => {
              const url = stringField(raw, "url");
              const title = stringField(raw, "title") ?? url;
              if (!title) return null;
              return (
                <li key={`${title}-${index}`} className="truncate">
                  {url ? <ExternalLink url={url} label={title} /> : title}
                </li>
              );
            })}
          </ul>
        </Section>
      );
    case "shopping":
      return (
        <Section block={block}>
          <ul className="flex flex-col gap-1 text-sm">
            {block.items.map((raw, index) => {
              const title = stringField(raw, "title");
              if (!title) return null;
              const price = stringField(raw, "price");
              return (
                <li key={`${title}-${index}`}>
                  <span className="font-medium">{title}</span>
                  {price ? (
                    <span className="text-xs text-base-content/60">
                      {" "}
                      · {price}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      );
    case "news":
      return (
        <Section block={block}>
          <ul className="flex flex-col gap-1 text-sm">
            {block.items.map((raw, index) => {
              const title = stringField(raw, "title");
              if (!title) return null;
              const url = stringField(raw, "url");
              const sourceName = stringField(raw, "sourceName");
              return (
                <li key={`${title}-${index}`}>
                  {url ? <ExternalLink url={url} label={title} /> : title}
                  {sourceName ? (
                    <span className="text-xs text-base-content/50">
                      {" "}
                      · {sourceName}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      );
    case "knowledgeGraph": {
      const item = block.items[0];
      if (item === undefined) return null;
      const title = stringField(item, "title");
      if (!title) return null;
      const description = stringField(item, "description");
      return (
        <Section block={block}>
          <p className="text-sm font-medium">{title}</p>
          {description ? (
            <p className="text-xs text-base-content/60 mt-0.5">{description}</p>
          ) : null}
        </Section>
      );
    }
    default:
      return null;
  }
}
