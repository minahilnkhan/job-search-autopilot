import type { ResumeContent, ResumeEntry, ResumeSection } from "../../../shared/types";

// A small plain-text format for resumes, so they're easy to edit in a
// textarea and easy to diff:
//
//   # Full Name
//   City, ST | email | phone | github.com/you
//
//   ## Experience
//   ### Company | City, ST
//   Job Title | June 2025 – Present
//   - A bullet
//
//   ## Skills
//   Languages: TypeScript, Python
//
// One structure feeds the PDF, the DOCX, the Truth Check and the tailoring
// diff, so they can never disagree with each other.

export class ResumeFormatError extends Error {}

const split2 = (line: string): [string, string | null] => {
  const i = line.indexOf(" | ");
  return i === -1 ? [line.trim(), null] : [line.slice(0, i).trim(), line.slice(i + 3).trim() || null];
};

export function parseResume(text: string): ResumeContent {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let name = "";
  let contact = "";
  const sections: ResumeSection[] = [];
  let section: ResumeSection | null = null;
  let entry: ResumeEntry | null = null;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith("## ")) {
      section = { title: line.slice(3).trim(), entries: [], lines: [] };
      sections.push(section);
      entry = null;
    } else if (line.startsWith("# ")) {
      name = line.slice(2).trim();
    } else if (!section) {
      if (!name) throw new ResumeFormatError(`Line ${i + 1}: start with "# Your Name".`);
      contact = contact ? `${contact} | ${line}` : line;
    } else if (line.startsWith("### ")) {
      const [org, location] = split2(line.slice(4));
      entry = { org, location, role: null, dates: null, bullets: [] };
      (section as ResumeSection).entries.push(entry);
    } else if (/^[-•*]\s+/.test(line)) {
      const bullet = line.replace(/^[-•*]\s+/, "");
      if (entry) (entry as ResumeEntry).bullets.push(bullet);
      else (section as ResumeSection).lines.push(bullet);
    } else if (entry && (entry as ResumeEntry).role === null && (entry as ResumeEntry).bullets.length === 0) {
      const [role, dates] = split2(line);
      (entry as ResumeEntry).role = role;
      (entry as ResumeEntry).dates = dates;
    } else {
      (section as ResumeSection).lines.push(line);
    }
  });

  if (!name) throw new ResumeFormatError('Start with "# Your Name".');
  return { name, contact, sections };
}

export function serializeResume(r: ResumeContent): string {
  const out: string[] = [`# ${r.name}`, r.contact, ""];
  for (const s of r.sections) {
    out.push(`## ${s.title}`);
    for (const l of s.lines) out.push(l);
    for (const e of s.entries) {
      out.push(`### ${e.org}${e.location ? ` | ${e.location}` : ""}`);
      if (e.role || e.dates) out.push(`${e.role ?? ""}${e.dates ? ` | ${e.dates}` : ""}`);
      for (const b of e.bullets) out.push(`- ${b}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

/**
 * Every checkable line with a stable id and a human label:
 * bullets are "s.e.b", section lines "s.Ln", entry headers "s.e.h".
 */
export type ResumeLine = { id: string; where: string; text: string; kind: "bullet" | "line" | "header" };

export function resumeLines(r: ResumeContent): ResumeLine[] {
  const out: ResumeLine[] = [];
  r.sections.forEach((s, si) => {
    s.lines.forEach((l, li) => out.push({ id: `${si}.L${li}`, where: `${s.title} › line ${li + 1}`, text: l, kind: "line" }));
    s.entries.forEach((e, ei) => {
      const header = [e.org, e.location, e.role, e.dates].filter(Boolean).join(" | ");
      out.push({ id: `${si}.${ei}.h`, where: `${s.title} › ${e.org}`, text: header, kind: "header" });
      e.bullets.forEach((b, bi) =>
        out.push({ id: `${si}.${ei}.${bi}`, where: `${s.title} › ${e.org} › bullet ${bi + 1}`, text: b, kind: "bullet" })
      );
    });
  });
  return out;
}

/** Replace one bullet, section line, or the contact line ("contact") by id. Entry headers aren't editable this way. */
export function setLine(r: ResumeContent, id: string, text: string): ResumeContent {
  const copy: ResumeContent = structuredClone(r);
  if (id === "contact") {
    copy.contact = text;
    return copy;
  }
  const m = /^(\d+)\.(?:L(\d+)|(\d+)\.(\d+))$/.exec(id);
  if (!m) throw new ResumeFormatError(`Unknown line id "${id}"`);
  const section = copy.sections[Number(m[1])];
  if (!section) throw new ResumeFormatError(`Unknown line id "${id}"`);
  if (m[2] !== undefined) {
    if (section.lines[Number(m[2])] === undefined) throw new ResumeFormatError(`Unknown line id "${id}"`);
    section.lines[Number(m[2])] = text;
  } else {
    const entry = section.entries[Number(m[3])];
    if (!entry || entry.bullets[Number(m[4])] === undefined) throw new ResumeFormatError(`Unknown line id "${id}"`);
    entry.bullets[Number(m[4])] = text;
  }
  return copy;
}
