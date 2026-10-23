import { describe, expect, it } from "vitest";
import { diffSchema } from "./diff";

const PROPOSED = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Widget",
  image: ["https://cdn.example.com/p1.jpg"],
  offers: { "@type": "Offer", price: 49.5, priceCurrency: "SAR" },
};

describe("diffSchema", () => {
  it("marks every proposed property as added without an existing document", () => {
    const diff = diffSchema([], PROPOSED);
    expect(diff.entries.map((entry) => entry.status)).toEqual([
      "added",
      "added",
      "added",
    ]);
    expect(diff.notes).toEqual([
      "No existing Product document to compare against",
    ]);
  });

  it("keeps identical properties", () => {
    const diff = diffSchema([{ ...PROPOSED }], PROPOSED);
    expect(diff.entries.every((entry) => entry.status === "kept")).toBe(true);
    expect(diff.notes).toEqual([]);
  });

  it("reports a changed price with both values", () => {
    const existing = {
      "@type": "Product",
      name: "Widget",
      image: ["https://cdn.example.com/p1.jpg"],
      offers: { "@type": "Offer", price: 39, priceCurrency: "SAR" },
    };
    const diff = diffSchema([existing], PROPOSED);
    const offers = diff.entries.find((entry) => entry.path === "offers");
    expect(offers?.status).toBe("changed");
    expect(offers?.existing).toEqual(existing.offers);
    expect(offers?.proposed).toEqual(PROPOSED.offers);
  });

  it("flags URL disagreement as a conflict instead of a plain change", () => {
    const existing = {
      "@type": "Product",
      url: "https://shop.example.com/old",
    };
    const proposed = {
      "@type": "Product",
      name: "Widget",
      url: "https://shop.example.com/new",
    };
    const diff = diffSchema([existing], proposed);
    expect(diff.entries.find((entry) => entry.path === "url")?.status).toBe(
      "conflicting",
    );
    expect(diff.entries.find((entry) => entry.path === "name")?.status).toBe(
      "added",
    );
  });

  it("surfaces existing-only properties so replacement never drops them silently", () => {
    const existing = {
      "@type": "Product",
      name: "Widget",
      aggregateRating: { "@type": "AggregateRating", ratingValue: 4.5 },
    };
    const diff = diffSchema([existing], PROPOSED);
    const rating = diff.entries.find(
      (entry) => entry.path === "aggregateRating",
    );
    expect(rating?.status).toBe("existing_only");
    expect(rating?.source).toBeNull();
  });

  it("attaches proposal sources and compares against the first matching node", () => {
    const existing = [
      { "@type": "Product", name: "Widget" },
      { "@type": "Product", name: "Other" },
      { "@type": "Organization", name: "Widget Co" },
    ];
    const diff = diffSchema(existing, PROPOSED, [
      { path: "name", value: "Widget", source: "extraction.product.name" },
    ]);
    expect(diff.entries.find((entry) => entry.path === "name")?.source).toBe(
      "extraction.product.name",
    );
    expect(diff.notes).toEqual([
      "Compared against the first of 2 existing Product nodes",
    ]);
  });
});
