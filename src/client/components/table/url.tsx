
/**
 * Safely decodes percent-encoded URLs and embedded URL slugs in arbitrary
 * text (e.g. Arabic or non-ASCII slugs), while gracefully handling non-hex
 * '%' characters (like "15% drop") without throwing URIError.
 */
export function safeDecodeUrlText(text: string | null | undefined): string {
  if (!text) return "";
  if (!text.includes("%")) return text;
  try {
    return decodeURI(text);
  } catch {
    return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (match) => {
      try {
        return decodeURIComponent(match);
      } catch {
        return match;
      }
    });
  }
}

import { ExternalLink } from "lucide-react";

export function formatUrlForDisplay(value: string): string {
  try {
    const url = new URL(value);
    const hash = url.hash.startsWith("#:~:") ? "" : url.hash;
    const cleaned = `${url.protocol}//${url.host}${url.pathname}${url.search}${hash}`;
    return safeDecodeUrlText(cleaned);
  } catch {
    return safeDecodeUrlText(value);
  }
}

export function resolveUrlHref(
  value: string | null | undefined,
  baseDomain?: string,
): string | null {
  if (!value) return null;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) {
    return getSafeExternalUrl(value);
  }
  if (!baseDomain) return null;
  return getSafeExternalUrl(
    `https://${baseDomain}${value.startsWith("/") ? value : `/${value}`}`,
  );
}

export function ExternalUrlCell({
  value,
  label,
  baseDomain,
  className = "link link-primary inline-flex items-center gap-1",
  display = "formatted",
  empty = "-",
}: {
  value: string | null | undefined;
  label?: string | null;
  baseDomain?: string;
  className?: string;
  display?: "formatted" | "path" | "raw";
  empty?: string;
}) {
  const href = resolveUrlHref(value, baseDomain);
  if (!value || !href) {
    return <span className="text-base-content/40">{empty}</span>;
  }

  const visibleLabel = label ?? getUrlDisplayLabel(value, display);
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer" title={safeDecodeUrlText(value)}>
      <span className="truncate">{visibleLabel}</span>
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}

function getUrlDisplayLabel(
  value: string,
  display: "formatted" | "path" | "raw",
) {
  if (display === "raw") return value;
  if (display === "path") {
    try {
      return safeDecodeUrlText(new URL(value).pathname);
    } catch {
      return safeDecodeUrlText(value);
    }
  }
  return formatUrlForDisplay(value);
}

export function getSafeExternalUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}
