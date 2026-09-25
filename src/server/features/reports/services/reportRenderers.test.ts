import { describe, expect, it } from "vitest";
import { buildPrintModel } from "./printModel";
import { asciiPrintable, renderPdfDocument } from "./pdfDocument";
import { renderPrintHtml } from "./printHtml";
import { consistencyBanner } from "@/shared/reports";
import { payloadFixture } from "./printModel.test";

const BRANDING = {
  agency: {
    name: "Acme SEO",
    logoR2Key: null,
    accentColor: "#1a2b3c",
    footerText: "Prepared by Acme",
  },
  client: { name: "Client Co", logoR2Key: null, titleOverride: null },
};

function validateXref(bytes: string): { objects: number; pages: number } {
  const lines = bytes.split("\n");
  const xrefIndex = lines.findIndex((line) => line === "xref");
  expect(xrefIndex).toBeGreaterThan(-1);
  const [zero, total] = lines[xrefIndex + 1]!.split(" ").map(Number);
  expect(zero).toBe(0);
  const entries = lines.slice(xrefIndex + 2, xrefIndex + 2 + total);
  expect(entries).toHaveLength(total);
  expect(entries[0]).toBe("0000000000 65535 f ");
  for (const entry of entries.slice(1)) {
    const offset = Number(entry.slice(0, 10));
    const target = bytes.slice(offset, offset + 20);
    expect(target).toMatch(/^\d+ 0 obj/);
  }
  const trailerIndex = lines.findIndex((line) => line === "trailer");
  const sizeLine = lines
    .slice(trailerIndex)
    .find((line) => line.startsWith("<< /Size"));
  const size = Number(/\/Size (\d+)/.exec(sizeLine ?? "")?.[1]);
  expect(size).toBe(total);
  const countMatch = /\/Count (\d+)/.exec(bytes);
  return { objects: total, pages: Number(countMatch?.[1] ?? 0) };
}

describe("renderPdfDocument", () => {
  it("emits structurally valid PDF bytes", () => {
    const payload = payloadFixture();
    const { bytes, pageCount } = renderPdfDocument(
      buildPrintModel(payload, BRANDING),
    );
    expect(bytes.startsWith("%PDF-1.4\n")).toBe(true);
    expect(bytes.endsWith("%%EOF")).toBe(true);
    const checked = validateXref(bytes);
    expect(checked.pages).toBe(pageCount);
    expect(checked.pages).toBeGreaterThanOrEqual(1);
    expect(bytes).toContain("/BaseFont /Helvetica");
  });

  it("freezes payload content byte-identically", () => {
    const payload = payloadFixture();
    const first = renderPdfDocument(buildPrintModel(payload, BRANDING));
    const second = renderPdfDocument(buildPrintModel(payload, BRANDING));
    expect(first.bytes).toBe(second.bytes);
    expect(first.bytes).toContain("(Overview report)");
    expect(first.bytes).toContain("(Acme SEO for Client Co");
    expect(first.bytes).toContain("(Clicks: 1120)");
    expect(first.bytes).toContain(
      "(- [Critical / open] Important keywords lost rankings)",
    );
    expect(first.bytes).toContain(
      "(Note: All data sources were stable while this report was collected.)",
    );
  });

  it("paginates long opportunity lists with matching counts", () => {
    const opportunities = [];
    for (let i = 0; i < 80; i += 1) {
      opportunities.push({
        id: `opp-${i}`,
        logicalKey: `ranking_drop:k${i}`,
        type: "ranking",
        status: "open",
        priority: "High",
        impactScore: 60,
        confidenceScore: 60,
        title: `Opportunity number ${i} with a reasonably long title`,
        explanationFact:
          "Observed during the same period with enough detail to wrap across lines.",
        recommendation: "Act soon.",
        completedAt: null,
      });
    }
    const payload = payloadFixture({ opportunities });
    const { bytes, pageCount } = renderPdfDocument(
      buildPrintModel(payload, null),
    );
    expect(pageCount).toBeGreaterThan(1);
    expect(validateXref(bytes).pages).toBe(pageCount);
    expect(bytes).toContain(
      "(- [High / open] Opportunity number 79 with a reasonably long title)",
    );
  });
});

describe("asciiPrintable", () => {
  it("transliterates punctuation and falls back on the rest", () => {
    expect(asciiPrintable("a—b–c“d”e‘f’g•h…i×j→k")).toBe(
      'a-b-c"d"e\'f\'g-h...ixj->k',
    );
    expect(asciiPrintable("Café Münchner")).toBe("Cafe Munchner");
    expect(asciiPrintable("标题")).toBe("??");
  });

  it("emits pure ASCII for any input", () => {
    const sample = "Ünïcodé — test “x” → ✓ §";
    const flat = asciiPrintable(sample);
    expect(/^[\x20-\x7e]*$/.test(flat)).toBe(true);
    expect(flat.length).toBeGreaterThan(0);
  });
});

describe("renderPrintHtml", () => {
  it("renders the identical banner with zero scripts", () => {
    const payload = payloadFixture();
    const html = renderPrintHtml(buildPrintModel(payload, BRANDING));
    expect(html).toContain(consistencyBanner(payload.provenance));
    expect(html).not.toContain("<script");
    expect(html).toContain("@media print");
    expect(html).toContain("Clicks");
    expect(html).toContain("1120");
    expect(html).toContain("Important keywords lost rankings");
    expect(html).toContain("Prepared by Acme");
  });

  it("escapes markup in frozen text", () => {
    const payload = payloadFixture({
      opportunities: [
        {
          id: "opp-x",
          logicalKey: "ranking_drop:kx",
          type: "ranking",
          status: "open",
          priority: "High",
          impactScore: 60,
          confidenceScore: 60,
          title: "<img src=x onerror=alert(1)>",
          explanationFact: "A & B",
          recommendation: "Act.",
          completedAt: null,
        },
      ],
    });
    const html = renderPrintHtml(buildPrintModel(payload, null));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("A &amp; B");
  });
});

describe("renderer parity", () => {
  it("carries the same values in PDF and HTML", () => {
    const payload = payloadFixture();
    const model = buildPrintModel(payload, BRANDING);
    const pdf = renderPdfDocument(model).bytes;
    const html = renderPrintHtml(model);
    for (const needle of [
      "Overview report",
      "Acme SEO for Client Co",
      "Clicks",
      "1120",
      "Important keywords lost rankings",
      consistencyBanner(payload.provenance),
    ]) {
      expect(pdf.includes(asciiPrintable(needle))).toBe(true);
      expect(html.includes(needle)).toBe(true);
    }
  });
});
