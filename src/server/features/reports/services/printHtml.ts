import type { PrintModel } from "./printModel";

// Static print-CSS HTML fallback (final-plan §12/§23.4): the same print
// model as the PDF emitter, zero scripts, print stylesheet with @page.

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderPrintHtml(model: PrintModel): string {
  const sections = model.sections
    .map((section) => {
      const rows = section.metricRows
        .map(
          (row) =>
            `<tr><th>${escapeHtml(row.label)}</th><td>${escapeHtml(row.value)}</td></tr>`,
        )
        .join("");
      const items = section.items
        .map(
          (item) =>
            `<li><strong>[${escapeHtml(item.lead)}] ${escapeHtml(item.title)}</strong><br>${escapeHtml(item.body)}</li>`,
        )
        .join("");
      const body = section.unavailableNote
        ? `<p class="muted">${escapeHtml(section.unavailableNote)}</p>`
        : `${rows ? `<table>${rows}</table>` : ""}${items ? `<ul>${items}</ul>` : ""}${section.emptyNote ? `<p class="muted">${escapeHtml(section.emptyNote)}</p>` : ""}`;
      return `<section><h2>${escapeHtml(section.title)}</h2>${body}</section>`;
    })
    .join("\n");
  const provenance = model.provenanceLines
    .map((line) => `<p class="muted">${escapeHtml(line)}</p>`)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(model.title)}</title>
<style>
body{font-family:Helvetica,Arial,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#111}
h1{font-size:1.5rem;margin-bottom:.25rem}h2{font-size:1.15rem;margin-top:1.5rem}
.muted{color:#555;font-size:.9rem}table{border-collapse:collapse;width:100%;margin-top:.5rem}
th,td{text-align:left;padding:.3rem .6rem;border-bottom:1px solid #ddd;vertical-align:top}
th{width:40%}ul{padding-left:1.2rem}li{margin-bottom:.5rem}
.banner{background:#f0f4ff;border-left:4px solid #2563eb;padding:.6rem .9rem;margin:1rem 0}
footer{margin-top:2rem;font-size:.85rem;color:#555}
@media print{@page{size:A4;margin:18mm}body{margin:0;max-width:none}.no-print{display:none}}
</style>
</head>
<body>
<header><h1>${escapeHtml(model.title)}</h1><p class="muted">${escapeHtml(model.subtitle)}</p></header>
<div class="banner">${escapeHtml(model.banner)}</div>
${provenance}
${sections}
${model.footer ? `<footer>${escapeHtml(model.footer)}</footer>` : ""}
</body>
</html>`;
}
