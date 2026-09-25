import type { PrintModel } from "./printModel";

// Portable PDF 1.4 emitter (final-plan §23.4: no browser binding, no PDF
// dependency). Helvetica standard fonts, single-byte ASCII content (see
// asciiPrintable), byte-exact xref offsets. A future browser adapter can
// replace renderPdfDocument without touching export flow or tests.

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN_X = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const TOP_Y = PAGE_HEIGHT - 56;
const BOTTOM_Y = 64;

const PUNCTUATION_MAP: Record<string, string> = {
  "—": "-",
  "–": "-",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "•": "-",
  "…": "...",
  "×": "x",
  "→": "->",
  "←": "<-",
};

/** ASCII-only printable text: transliterate, map punctuation, else "?". */
export function asciiPrintable(input: string): string {
  const decomposed = input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  let out = "";
  for (const char of decomposed) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 32 && code <= 126) out += char;
    else if (char in PUNCTUATION_MAP) out += PUNCTUATION_MAP[char];
    else out += "?";
  }
  return out;
}

function escapeLiteral(input: string): string {
  return asciiPrintable(input).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

type PlacedLine = {
  size: number;
  bold: boolean;
  text: string;
  gapAfter: number;
};

function wrappedLines(
  text: string,
  size: number,
  maxChars: number,
): string[] {
  const words = asciiPrintable(text)
    .split(/\s+/)
    .filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      // A single over-long token (URL, hash) is hard-split.
      let rest = word;
      while (rest.length > maxChars) {
        lines.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      current = rest;
    }
  }
  if (current) lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

export type PdfRenderResult = { bytes: string; pageCount: number };

export function renderPdfDocument(model: PrintModel): PdfRenderResult {
  const placed: PlacedLine[][] = [[]];
  const push = (line: PlacedLine) => {
    let page = placed[placed.length - 1]!;
    const needed = line.text === "" ? 1 : wrapped(line.text, line.size).length;
    if (!fitsOn(page, line.size, needed)) {
      placed.push([]);
      page = placed[placed.length - 1]!;
    }
    page.push(line);
  };

  push({ size: 18, bold: true, text: model.title, gapAfter: 4 });
  push({ size: 11, bold: false, text: model.subtitle, gapAfter: 10 });
  push({ size: 11, bold: true, text: `Note: ${model.banner}`, gapAfter: 6 });
  for (const line of model.provenanceLines) {
    push({ size: 9, bold: false, text: line, gapAfter: 2 });
  }
  push({ size: 9, bold: false, text: "", gapAfter: 6 });

  for (const section of model.sections) {
    push({ size: 14, bold: true, text: section.title, gapAfter: 4 });
    if (section.unavailableNote) {
      push({ size: 11, bold: false, text: section.unavailableNote, gapAfter: 8 });
      continue;
    }
    for (const row of section.metricRows) {
      push({
        size: 11,
        bold: false,
        text: `${row.label}: ${row.value}`,
        gapAfter: 1,
      });
    }
    if (section.emptyNote) {
      push({ size: 11, bold: false, text: section.emptyNote, gapAfter: 8 });
      continue;
    }
    for (const item of section.items) {
      push({
        size: 11,
        bold: true,
        text: `- [${item.lead}] ${item.title}`,
        gapAfter: 0,
      });
      push({ size: 11, bold: false, text: `  ${item.body}`, gapAfter: 4 });
    }
    push({ size: 11, bold: false, text: "", gapAfter: 6 });
  }

  if (model.footer) {
    push({ size: 9, bold: false, text: model.footer, gapAfter: 0 });
  }

  return assemble(placed);
}

function maxCharsFor(size: number): number {
  return Math.floor(CONTENT_WIDTH / (size * 0.55));
}

function wrapped(text: string, size: number): string[] {
  return wrappedLines(text, size, maxCharsFor(size));
}

function fitsOn(page: PlacedLine[], size: number, count: number): boolean {
  const used = page.reduce(
    (sum, line) =>
      sum +
      wrapped(line.text === "" ? " " : line.text, line.size).length *
        line.size *
        1.35 +
      line.gapAfter,
    0,
  );
  return TOP_Y - used - size * 1.35 * count >= BOTTOM_Y;
}

function contentFor(lines: PlacedLine[], pageNumber: number): string {
  const ops: string[] = [];
  let y = TOP_Y;
  const emit = (size: number, bold: boolean, text: string) => {
    for (const visual of wrapped(text === "" ? " " : text, size)) {
      y -= size * 1.35;
      ops.push(
        `BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${MARGIN_X} ${y.toFixed(2)} Tm (${escapeLiteral(visual)}) Tj ET`,
      );
    }
  };
  for (const line of lines) {
    emit(line.size, line.bold, line.text);
    y -= line.gapAfter;
  }
  const footer = `Page ${pageNumber}`;
  ops.push(
    `BT /F1 9 Tf 1 0 0 1 ${(PAGE_WIDTH / 2 - footer.length * 2.5).toFixed(2)} ${(BOTTOM_Y - 24).toFixed(2)} Tm (${footer}) Tj ET`,
  );
  return ops.join("\n");
}

function assemble(pages: PlacedLine[][]): PdfRenderResult {
  // Object numbering: 1 catalog, 2 pages, 3 F1, 4 F2, then per page
  // (page dict, content stream) pairs.
  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];
  let next = 5;
  const contents: string[] = [];
  pages.forEach((lines, index) => {
    const pageObj = next;
    next += 1;
    const contentObj = next;
    next += 1;
    pageObjectNumbers.push(pageObj);
    objects.push(
      `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj`,
    );
    const stream = contentFor(lines, index + 1);
    objects.push(
      `${contentObj} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`,
    );
  });
  const head = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj`,
    "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj",
    ...objects,
  ];
  let bytes = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const body of head) {
    offsets.push(bytes.length);
    bytes += body + "\n";
  }
  const xrefAt = bytes.length;
  const total = head.length + 1;
  bytes += `xref\n0 ${total}\n`;
  bytes += "0000000000 65535 f \n";
  for (const offset of offsets) {
    bytes += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  bytes += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return { bytes, pageCount: pages.length };
}
