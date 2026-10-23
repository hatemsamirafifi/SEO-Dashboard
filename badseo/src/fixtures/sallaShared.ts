import { escapeHtml } from "../lib";

export const CAT = "Salla storefront";

/**
 * Platform evidence shared across Salla fixture heads: meta generator, Salla
 * CDN asset, and SDK initialization (plus storefront hreflang alternates).
 */
export function sallaHeadExtra(): string {
  return [
    '<meta name="generator" content="Salla E-Commerce">',
    '<script src="https://cdn.salla.network/salla.v1.1.js" defer></script>',
    '<script>salla.event.on("cart:add", function () {});</script>',
    '<link rel="alternate" hreflang="en" href="/en/store">',
    '<link rel="alternate" hreflang="ar" href="/ar/store">',
  ].join("\n");
}

export function productCard(href: string, name: string, price: string): string {
  return `<a class="card" href="${escapeHtml(href)}">
  <span class="card-title">${escapeHtml(name)}</span>
  <span class="card-price">SAR ${escapeHtml(price)}</span>
</a>`;
}
