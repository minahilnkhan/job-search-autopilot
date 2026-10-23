import {
  AlignmentType,
  BorderStyle,
  Document,
  LevelFormat,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
  convertInchesToTwip,
} from "docx";
import type { ResumeContent } from "../../../shared/types";
import { LAYOUT } from "./resumeHtml";

// Same layout as the HTML/PDF: Letter, same margins, font and sizes.
// Right-aligned dates and locations use a right tab stop at the text edge.

const halfPt = (pt: number) => Math.round(pt * 2); // docx sizes are in half-points
const PAGE_WIDTH_IN = 8.5;
const RIGHT_TAB = convertInchesToTwip(PAGE_WIDTH_IN - 2 * LAYOUT.marginIn);

const run = (text: string, opts: { bold?: boolean; italics?: boolean; size?: number } = {}) =>
  new TextRun({ text, font: LAYOUT.font, size: halfPt(opts.size ?? LAYOUT.bodyPt), bold: opts.bold, italics: opts.italics });

const twoSided = (left: TextRun, right: string) =>
  new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
    spacing: { after: 0 },
    children: [left, ...(right ? [run(`\t${right}`)] : [])],
  });

export async function resumeDocx(r: ResumeContent): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: [run(r.name, { bold: true, size: LAYOUT.namePt })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [run(r.contact)] }),
  ];

  for (const s of r.sections) {
    children.push(
      new Paragraph({
        spacing: { before: 140, after: 60 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "000000", space: 1 } },
        children: [run(s.title.toUpperCase(), { bold: true, size: LAYOUT.headingPt })],
      })
    );
    for (const l of s.lines) children.push(new Paragraph({ spacing: { after: 30 }, children: [run(l)] }));
    for (const e of s.entries) {
      children.push(twoSided(run(e.org, { bold: true }), e.location ?? ""));
      if (e.role || e.dates) children.push(twoSided(run(e.role ?? "", { italics: true }), e.dates ?? ""));
      for (const b of e.bullets) {
        children.push(new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 20 }, children: [run(b)] }));
      }
      children.push(new Paragraph({ spacing: { after: 60 }, children: [] }));
    }
  }

  const doc = new Document({
    creator: r.name,
    title: `${r.name} Resume`,
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: convertInchesToTwip(0.2), hanging: convertInchesToTwip(0.15) } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: convertInchesToTwip(PAGE_WIDTH_IN), height: convertInchesToTwip(11) },
            margin: {
              top: convertInchesToTwip(LAYOUT.marginIn),
              bottom: convertInchesToTwip(LAYOUT.marginIn),
              left: convertInchesToTwip(LAYOUT.marginIn),
              right: convertInchesToTwip(LAYOUT.marginIn),
            },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
