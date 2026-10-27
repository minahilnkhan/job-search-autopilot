import { useEffect, useState } from "react";
import type { BaseResume, BaseType } from "../../../shared/types";
import { api } from "../lib/api";
import { TruthPanel } from "../components/TruthPanel";

const LABEL: Record<BaseType, string> = { fde: "FDE / Solutions", swe: "Software engineering" };
const EXAMPLE = `# Your Name
City, ST | email | phone | github.com/you

## Experience
### Company | City, ST
Job Title | Month Year – Present
- What you built and the concrete result

## Education
### University | City, ST
Degree | Month Year

## Skills
Languages: ...`;

export function Resumes() {
  const [bases, setBases] = useState<BaseResume[]>([]);
  const [type, setType] = useState<BaseType>("fde");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.bases().then((b) => {
      setBases(b);
      setText(b.find((x) => x.baseType === "fde")?.text ?? "");
    });
  }, []);

  const base = bases.find((b) => b.baseType === type);
  const switchTo = (t: BaseType) => {
    setType(t);
    setText(bases.find((b) => b.baseType === t)?.text ?? "");
    setError(null);
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveBase(type, text);
      setBases((bs) => bs.map((b) => (b.baseType === type ? saved : b)));
      setText(saved.text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5">
      <header className="max-w-2xl space-y-1">
        <h1 className="text-[34px] leading-tight font-semibold tracking-tight">Base resumes</h1>
        <p className="text-ink-soft">
          Every application starts from one of these. Tier A applications get tailored line by line; Tier B use them as-is. Each save
          runs the Truth Check and rebuilds the one-page PDF.
        </p>
      </header>

      <nav className="flex gap-1" aria-label="Base resume">
        {(["fde", "swe"] as const).map((t) => (
          <button key={t} onClick={() => switchTo(t)} aria-pressed={type === t}
            className={`rounded-full px-4 py-2 text-sm ${type === t ? "bg-dark font-semibold text-white" : "border border-line bg-surface font-medium text-ink"}`}>
            {LABEL[t]}
          </button>
        ))}
      </nav>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <div className="space-y-3">
          <textarea aria-label={`${LABEL[type]} base resume`} className="field min-h-[640px] font-mono text-[13px] leading-relaxed"
            value={text} placeholder={EXAMPLE} onChange={(e) => setText(e.target.value)} spellCheck />
          <p className="text-sm text-ink-soft">
            Format: <code># Name</code>, a contact line, <code>## Section</code>, <code>### Organization | Location</code>, then a
            <code> Role | Dates</code> line and <code>- bullets</code>.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-primary" disabled={busy || !text.trim() || text === base?.text} onClick={save}>
              {busy ? "Checking…" : "Save and check"}
            </button>
            {error && <p className="text-[15px] text-fail">{error}</p>}
          </div>
        </div>

        <div className="space-y-4">
          {base?.truth && (
            <div className="panel p-5">
              <TruthPanel report={base.truth} />
            </div>
          )}
          {base?.hasPdf ? (
            <>
              <p className="text-[15px] text-ink-soft">
                {base.pdfPages === 1 ? "Fits on one page." : `${base.pdfPages} pages. Trim it to one.`}{" "}
                <a className="font-medium text-accent underline underline-offset-2" href={`/api/resumes/bases/${type}/file.pdf?v=${base.id}`} target="_blank" rel="noreferrer">Open PDF</a>
                {" · "}
                <a className="font-medium text-accent underline underline-offset-2" href={`/api/resumes/bases/${type}/file.docx`}>Download DOCX</a>
              </p>
              <details>
                <summary className="cursor-pointer text-[15px] font-medium text-ink-soft">Preview the PDF here</summary>
                <iframe title={`${LABEL[type]} PDF`} src={`/api/resumes/bases/${type}/file.pdf?v=${base.id}`} className="mt-3 h-[760px] w-full rounded-md border border-line bg-white" />
              </details>
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-line p-6 text-[15px] text-ink-soft">
              {base?.id ? "No PDF yet. See the PDF issue above." : "Paste or write your resume, then Save and check to see the PDF."}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
