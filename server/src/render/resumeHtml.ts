import type { ResumeContent } from "../../../shared/types";

// Harvard-style one-page resume: single column, standard headings, no tables,
// icons or graphics (ATS-safe). The PDF is printed from this HTML; the DOCX
// mirrors the same layout and sizes in docx/resumeDocx.ts.

export const LAYOUT = {
  // Arial 10pt+ on 0.5in margins (your ATS notes); Arial ships with every Mac and Windows machine.
  font: "Arial",
  bodyPt: 10.5,
  namePt: 16,
  headingPt: 11,
  marginIn: 0.5,
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function resumeHtml(r: ResumeContent): string {
  const sections = r.sections
    .map((s) => {
      const lines = s.lines.map((l) => `<p class="line">${esc(l)}</p>`).join("");
      const entries = s.entries
        .map(
          (e) => `
      <div class="entry">
        <div class="row"><span class="org">${esc(e.org)}</span><span>${esc(e.location ?? "")}</span></div>
        ${e.role || e.dates ? `<div class="row"><span class="role">${esc(e.role ?? "")}</span><span>${esc(e.dates ?? "")}</span></div>` : ""}
        ${e.bullets.length ? `<ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
      </div>`
        )
        .join("");
      return `<section><h2>${esc(s.title)}</h2>${lines}${entries}</section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(r.name)} Resume</title>
<style>
  @page { size: Letter; margin: ${LAYOUT.marginIn}in; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "${LAYOUT.font}", Helvetica, sans-serif; font-size: ${LAYOUT.bodyPt}pt; line-height: 1.22; color: #000; }
  h1 { font-size: ${LAYOUT.namePt}pt; text-align: center; margin: 0 0 2pt; font-weight: bold; }
  .contact { text-align: center; margin: 0 0 6pt; }
  h2 { font-size: ${LAYOUT.headingPt}pt; text-transform: uppercase; letter-spacing: 0.04em; margin: 7pt 0 3pt; padding-bottom: 1pt; border-bottom: 0.75pt solid #000; }
  .entry { margin: 0 0 4pt; }
  .row { display: flex; justify-content: space-between; gap: 12pt; }
  .org { font-weight: bold; }
  .role { font-style: italic; }
  ul { margin: 1pt 0 0; padding-left: 14pt; }
  li { margin: 0 0 1pt; }
  .line { margin: 0 0 1.5pt; }
</style></head>
<body>
  <h1>${esc(r.name)}</h1>
  <p class="contact">${esc(r.contact)}</p>
  ${sections}
</body></html>`;
}
