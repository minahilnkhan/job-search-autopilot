import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ResumeContent, ResumeEntry, TruthIssue } from "../../../shared/types";
import { serializeResume } from "../../../shared/resumeFormat";

// A resume you edit in place, laid out like the PDF: click a line and type.
// Enter starts a new bullet, Backspace on an empty one removes it, and the
// small controls on each line move or delete it. Under the hood it edits the
// same structure the server checks and renders, so what you see here is what
// the Truth Check reads and what the PDF prints.

/** Drops empty bullets and lines left over from editing, then writes the plain-text format. */
export function resumeToText(doc: ResumeContent): string {
  const clean: ResumeContent = {
    name: doc.name.trim(),
    contact: doc.contact.trim(),
    sections: doc.sections
      .map((s) => ({
        title: s.title.trim() || "Section",
        lines: s.lines.map((l) => l.trim()).filter(Boolean),
        entries: s.entries
          // An entry you added and never filled in is dropped, not saved as "Organization".
          .filter((e) => [e.org, e.location, e.role, e.dates, ...e.bullets].some((v) => v?.trim()))
          .map((e) => ({
            org: e.org.trim() || "Organization",
            location: e.location?.trim() || null,
            role: e.role?.trim() || null,
            dates: e.dates?.trim() || null,
            bullets: e.bullets.map((b) => b.trim()).filter(Boolean),
          })),
      }))
      .filter((s) => s.lines.length > 0 || s.entries.length > 0),
  };
  return serializeResume(clean);
}

type Props = {
  doc: ResumeContent;
  onChange: (doc: ResumeContent) => void;
  /** Problems from the last check. A line is marked only while its text is unchanged since that check. */
  issues: TruthIssue[];
};

const move = <T,>(arr: T[], i: number, by: -1 | 1): T[] => {
  const j = i + by;
  if (j < 0 || j >= arr.length) return arr;
  const copy = [...arr];
  [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  return copy;
};

/** A single line of text that grows as you type and looks like part of the page. */
function Line({
  value,
  onChange,
  placeholder,
  className = "",
  inputRef,
  onKeyDown,
  label,
  flagged,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  inputRef?: (el: HTMLTextAreaElement | null) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  label: string;
  flagged?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Grow to fit the text, and again whenever the line's width changes (wrapping changes with it).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "0px";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);
  return (
    <textarea
      ref={(el) => {
        ref.current = el;
        inputRef?.(el);
      }}
      rows={1}
      spellCheck
      aria-label={label}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value.replace(/\n/g, " "))}
      onKeyDown={onKeyDown}
      className={`block resize-none overflow-hidden rounded-sm border-0 bg-transparent p-0 leading-[1.35] outline-none placeholder:text-[#9aa7a1] hover:bg-[#f3f6f4] focus:bg-[#eef7f4] ${
        flagged ? "underline decoration-fail decoration-wavy decoration-1 underline-offset-[3px]" : ""
      } ${className || "w-full"}`}
    />
  );
}

/** Small icon buttons that appear when you hover or focus a block. */
function Controls({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="pointer-events-none absolute -top-1 right-0 z-10 flex gap-0.5 rounded-md border border-line bg-white p-0.5 opacity-0 shadow-sm transition-opacity group-focus-within/blk:pointer-events-auto group-focus-within/blk:opacity-100 group-hover/blk:pointer-events-auto group-hover/blk:opacity-100"
    >
      {children}
    </div>
  );
}

function Icon({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-md text-[13px] text-muted hover:bg-line hover:text-ink"
    >
      {children}
    </button>
  );
}

const AddLink = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
  <button type="button" onClick={onClick} className="text-[12px] font-medium text-accent opacity-0 transition-opacity group-focus-within/sec:opacity-100 group-hover/sec:opacity-100 hover:underline">
    {children}
  </button>
);

export function ResumeEditor({ doc, onChange, issues }: Props) {
  const refs = useRef(new Map<string, HTMLTextAreaElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // After adding or removing a line, put the cursor where you'd expect it.
  useEffect(() => {
    if (!focusKey) return;
    const el = refs.current.get(focusKey);
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    setFocusKey(null);
  }, [focusKey, doc]);

  const reg = (key: string) => (el: HTMLTextAreaElement | null) => {
    if (el) refs.current.set(key, el);
    else refs.current.delete(key);
  };

  /** The check's message for a line, if that line still reads exactly as it did when checked. */
  const flag = (lineId: string, text: string) => issues.find((i) => i.lineId === lineId && i.text === text);

  const edit = (fn: (d: ResumeContent) => void) => {
    const copy: ResumeContent = structuredClone(doc);
    fn(copy);
    onChange(copy);
  };
  const setEntry = (si: number, ei: number, patch: Partial<ResumeEntry>) =>
    edit((d) => {
      Object.assign(d.sections[si]!.entries[ei]!, patch);
    });

  function bulletKeys(si: number, ei: number, bi: number) {
    return (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const bullets = doc.sections[si]!.entries[ei]!.bullets;
      if (e.key === "Enter") {
        e.preventDefault();
        edit((d) => d.sections[si]!.entries[ei]!.bullets.splice(bi + 1, 0, ""));
        setFocusKey(`b:${si}.${ei}.${bi + 1}`);
      } else if (e.key === "Backspace" && bullets[bi] === "" && bullets.length > 0) {
        e.preventDefault();
        edit((d) => d.sections[si]!.entries[ei]!.bullets.splice(bi, 1));
        setFocusKey(bi > 0 ? `b:${si}.${ei}.${bi - 1}` : `r:${si}.${ei}`);
      }
    };
  }
  function lineKeys(si: number, li: number) {
    return (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const lines = doc.sections[si]!.lines;
      if (e.key === "Enter") {
        e.preventDefault();
        edit((d) => d.sections[si]!.lines.splice(li + 1, 0, ""));
        setFocusKey(`l:${si}.${li + 1}`);
      } else if (e.key === "Backspace" && lines[li] === "") {
        e.preventDefault();
        edit((d) => d.sections[si]!.lines.splice(li, 1));
        if (li > 0) setFocusKey(`l:${si}.${li - 1}`);
      }
    };
  }

  const contactFlag = flag("contact", doc.contact);

  return (
    <div className="rounded-sm bg-white px-[0.6in] py-[0.5in] text-[13.5px] text-black shadow-[0_1px_3px_rgba(16,35,31,0.12),0_8px_24px_rgba(16,35,31,0.08)]" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
      <Line label="Name" value={doc.name} onChange={(v) => edit((d) => void (d.name = v))} placeholder="Your Name" className="w-full text-center text-[22px] font-bold" />
      <Line label="Contact line" value={doc.contact} onChange={(v) => edit((d) => void (d.contact = v))} placeholder="City, ST | email | phone | github.com/you" className="mt-0.5 w-full text-center text-[12.5px]" flagged={!!contactFlag} />
      {contactFlag && <p className="mt-1 text-center text-[12px] text-fail">{contactFlag.message}</p>}

      {doc.sections.map((s, si) => (
        <section key={si} className="group/sec mt-4">
          <div className="group/blk relative border-b border-black pb-px">
            <Line label={`Section ${si + 1} title`} value={s.title} onChange={(v) => edit((d) => void (d.sections[si]!.title = v))} placeholder="SECTION" className="w-full text-[13px] font-bold tracking-[0.04em] uppercase" />
            <Controls label={`${s.title} section controls`}>
              <Icon title="Move section up" onClick={() => edit((d) => void (d.sections = move(d.sections, si, -1)))}>↑</Icon>
              <Icon title="Move section down" onClick={() => edit((d) => void (d.sections = move(d.sections, si, 1)))}>↓</Icon>
              <Icon title="Delete section" onClick={() => edit((d) => void d.sections.splice(si, 1))}>✕</Icon>
            </Controls>
          </div>

          {s.lines.map((l, li) => {
            const f = flag(`${si}.L${li}`, l);
            return (
              <div key={`l${li}`} className="group/blk relative mt-1">
                <Line label={`${s.title} line ${li + 1}`} inputRef={reg(`l:${si}.${li}`)} value={l} onChange={(v) => edit((d) => void (d.sections[si]!.lines[li] = v))} onKeyDown={lineKeys(si, li)} placeholder="Languages: …" flagged={!!f} />
                {f && <p className="text-[12px] text-fail">{f.message}</p>}
                <Controls label="Line controls">
                  <Icon title="Move line up" onClick={() => edit((d) => void (d.sections[si]!.lines = move(d.sections[si]!.lines, li, -1)))}>↑</Icon>
                  <Icon title="Move line down" onClick={() => edit((d) => void (d.sections[si]!.lines = move(d.sections[si]!.lines, li, 1)))}>↓</Icon>
                  <Icon title="Delete line" onClick={() => edit((d) => void d.sections[si]!.lines.splice(li, 1))}>✕</Icon>
                </Controls>
              </div>
            );
          })}

          {s.entries.map((e, ei) => (
            <div key={`e${ei}`} className="mt-2">
              <div className="group/blk relative">
                <div className="flex gap-3">
                  <Line label={`${s.title} entry ${ei + 1} organization`} value={e.org} onChange={(v) => setEntry(si, ei, { org: v })} placeholder="Organization" className="min-w-0 flex-1 font-bold" />
                  <Line label={`${e.org} location`} value={e.location ?? ""} onChange={(v) => setEntry(si, ei, { location: v })} placeholder="City, ST" className="w-[38%] flex-none text-right" />
                </div>
                <div className="flex gap-3">
                  <Line label={`${e.org} role`} inputRef={reg(`r:${si}.${ei}`)} value={e.role ?? ""} onChange={(v) => setEntry(si, ei, { role: v })} placeholder="Role" className="min-w-0 flex-1 italic" />
                  <Line label={`${e.org} dates`} value={e.dates ?? ""} onChange={(v) => setEntry(si, ei, { dates: v })} placeholder="Month Year – Present" className="w-[38%] flex-none text-right" />
                </div>
                <Controls label={`${e.org} controls`}>
                  <Icon title="Move entry up" onClick={() => edit((d) => void (d.sections[si]!.entries = move(d.sections[si]!.entries, ei, -1)))}>↑</Icon>
                  <Icon title="Move entry down" onClick={() => edit((d) => void (d.sections[si]!.entries = move(d.sections[si]!.entries, ei, 1)))}>↓</Icon>
                  <Icon title="Delete entry" onClick={() => edit((d) => void d.sections[si]!.entries.splice(ei, 1))}>✕</Icon>
                </Controls>
              </div>

              <ul className="mt-0.5">
                {e.bullets.map((b, bi) => {
                  const f = flag(`${si}.${ei}.${bi}`, b);
                  return (
                    <li key={bi} className="group/blk relative flex gap-2 pl-3">
                      <span aria-hidden className="select-none leading-[1.35]">•</span>
                      <div className="min-w-0 flex-1">
                        <Line label={`${e.org} bullet ${bi + 1}`} inputRef={reg(`b:${si}.${ei}.${bi}`)} value={b} onChange={(v) => edit((d) => void (d.sections[si]!.entries[ei]!.bullets[bi] = v))} onKeyDown={bulletKeys(si, ei, bi)} placeholder="Action verb + what you did + the result" flagged={!!f} />
                        {f && <p className="text-[12px] text-fail">{f.message}</p>}
                      </div>
                      <Controls label="Bullet controls">
                        <Icon title="Move bullet up" onClick={() => edit((d) => void (d.sections[si]!.entries[ei]!.bullets = move(d.sections[si]!.entries[ei]!.bullets, bi, -1)))}>↑</Icon>
                        <Icon title="Move bullet down" onClick={() => edit((d) => void (d.sections[si]!.entries[ei]!.bullets = move(d.sections[si]!.entries[ei]!.bullets, bi, 1)))}>↓</Icon>
                        <Icon title="Delete bullet" onClick={() => edit((d) => void d.sections[si]!.entries[ei]!.bullets.splice(bi, 1))}>✕</Icon>
                      </Controls>
                    </li>
                  );
                })}
              </ul>
              <div className="pl-3">
                <AddLink
                  onClick={() => {
                    edit((d) => void d.sections[si]!.entries[ei]!.bullets.push(""));
                    setFocusKey(`b:${si}.${ei}.${e.bullets.length}`);
                  }}
                >
                  + Bullet
                </AddLink>
              </div>
            </div>
          ))}

          <div className="mt-1 flex gap-4">
            <AddLink onClick={() => edit((d) => void d.sections[si]!.entries.push({ org: "", location: null, role: null, dates: null, bullets: [""] }))}>+ Entry (job, school, project)</AddLink>
            <AddLink
              onClick={() => {
                edit((d) => void d.sections[si]!.lines.push(""));
                setFocusKey(`l:${si}.${s.lines.length}`);
              }}
            >
              + Plain line
            </AddLink>
          </div>
        </section>
      ))}

      <button type="button" onClick={() => edit((d) => void d.sections.push({ title: "", entries: [], lines: [""] }))} className="mt-5 text-[12px] font-medium text-accent hover:underline">
        + Add a section
      </button>
    </div>
  );
}
