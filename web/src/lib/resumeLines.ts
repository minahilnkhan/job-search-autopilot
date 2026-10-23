import type { ResumeContent } from "../../../shared/types";

// Same line ids as the server (domain/resumeFormat.ts): bullets "s.e.b",
// section lines "s.Ln". Used to edit individual lines in review.
export type EditableLine = { id: string; where: string; text: string };

export function editableLines(r: ResumeContent): EditableLine[] {
  const out: EditableLine[] = [];
  r.sections.forEach((s, si) => {
    s.lines.forEach((l, li) => out.push({ id: `${si}.L${li}`, where: s.title, text: l }));
    s.entries.forEach((e, ei) => e.bullets.forEach((b, bi) => out.push({ id: `${si}.${ei}.${bi}`, where: `${s.title} › ${e.org}`, text: b })));
  });
  return out;
}

export function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD
}
