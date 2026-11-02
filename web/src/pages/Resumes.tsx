import { useCallback, useEffect, useMemo, useState } from "react";
import { ROLE_TAGS, type ResumeContent, type ResumeDoc, type RoleTag } from "../../../shared/types";
import { parseResume } from "../../../shared/resumeFormat";
import { api } from "../lib/api";
import { TruthPanel } from "../components/TruthPanel";
import { ResumeEditor, resumeToText } from "../components/ResumeEditor";

// Every resume you keep, in one place: the two bases the app builds
// applications from, plus named versions tagged by role type. Edit any of them
// in place like a document; each save runs the Truth Check and rebuilds the
// one-page PDF, exactly as before.

export const ROLE_LABEL: Record<RoleTag, string> = {
  fde: "FDE / Solutions",
  swe: "Software engineering",
  applied_ai: "Applied AI",
  consulting: "Technical consulting",
  education: "Technical education",
  other: "Other",
};

/** What a blank base starts as, so there's a page to type into. */
const STARTER: ResumeContent = {
  name: "",
  contact: "",
  sections: [
    { title: "Education", lines: [], entries: [{ org: "", location: null, role: null, dates: null, bullets: [""] }] },
    { title: "Experience", lines: [], entries: [{ org: "", location: null, role: null, dates: null, bullets: [""] }] },
    { title: "Projects", lines: [], entries: [{ org: "", location: null, role: null, dates: null, bullets: [""] }] },
    { title: "Skills", lines: [""], entries: [] },
  ],
};

type Draft = { mode: "doc"; doc: ResumeContent } | { mode: "source"; text: string };

const draftText = (d: Draft) => (d.mode === "doc" ? resumeToText(d.doc) : d.text);

function draftFrom(text: string, mode: Draft["mode"] = "doc"): Draft {
  if (mode === "source") return { mode, text };
  if (!text.trim()) return { mode: "doc", doc: structuredClone(STARTER) };
  try {
    return { mode: "doc", doc: parseResume(text) };
  } catch {
    return { mode: "source", text };
  }
}

function NewVersion({ docs, from, onCreated, onCancel }: { docs: ResumeDoc[]; from: string; onCreated: (d: ResumeDoc) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [roleTag, setRoleTag] = useState<RoleTag>("applied_ai");
  const [source, setSource] = useState(from);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copyable = docs.filter((d) => d.versionId);

  return (
    <form
      className="panel space-y-3 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          onCreated(await api.createResumeVersion({ name: name.trim(), roleTag, from: source }));
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="font-semibold">New version</p>
      <label className="block space-y-1">
        <span className="label">Name</span>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Applied AI, Chicago" maxLength={80} autoFocus />
      </label>
      <label className="block space-y-1">
        <span className="label">Role type</span>
        <select className="field" value={roleTag} onChange={(e) => setRoleTag(e.target.value as RoleTag)}>
          {ROLE_TAGS.map((t) => (
            <option key={t} value={t}>{ROLE_LABEL[t]}</option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="label">Start from a copy of</span>
        <select className="field" value={source} onChange={(e) => setSource(e.target.value)}>
          {copyable.map((d) => (
            <option key={d.key} value={d.key}>{d.name}</option>
          ))}
        </select>
      </label>
      {copyable.length === 0 && <p className="text-sm text-muted">Save a base first; a version starts as a copy of one.</p>}
      {error && <p className="text-sm text-fail">{error}</p>}
      <div className="flex gap-2">
        <button className="btn-primary py-2 text-sm" disabled={busy || !name.trim() || copyable.length === 0}>{busy ? "Creating…" : "Create"}</button>
        <button type="button" className="btn-quiet py-2 text-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function Resumes() {
  const [docs, setDocs] = useState<ResumeDoc[] | null>(null);
  const [selected, setSelected] = useState<string>("base:fde");
  const [filter, setFilter] = useState<RoleTag | "all">("all");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showPdf, setShowPdf] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  useEffect(() => {
    api.resumeDocs().then(setDocs).catch((e) => setError((e as Error).message));
  }, []);

  const doc = docs?.find((d) => d.key === selected) ?? docs?.[0];
  const draft: Draft | null = doc ? (drafts[doc.key] ?? draftFrom(doc.text)) : null;
  const dirtyKeys = useMemo(
    () => new Set((docs ?? []).filter((d) => drafts[d.key] && draftText(drafts[d.key]!) !== d.text).map((d) => d.key)),
    [docs, drafts]
  );
  const dirty = !!doc && dirtyKeys.has(doc.key);

  useEffect(() => {
    setNameDraft(doc?.name ?? "");
    setConfirmDelete(false);
    setShowPdf(false);
    setError(null);
  }, [doc?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the page with unsaved edits asks first.
  useEffect(() => {
    if (dirtyKeys.size === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirtyKeys]);

  const setDraft = (d: Draft) => doc && setDrafts((all) => ({ ...all, [doc.key]: d }));
  const replaceDoc = (d: ResumeDoc) => setDocs((all) => (all ?? []).map((x) => (x.key === d.key ? d : x)));

  const save = useCallback(async () => {
    if (!doc || !draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveResumeDoc(doc.key, draftText(draft));
      replaceDoc(saved);
      setDrafts((all) => ({ ...all, [doc.key]: draftFrom(saved.text, draft.mode) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [doc, draft, busy]);

  // Cmd/Ctrl+S saves, as in any editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save]);

  async function patchMeta(body: { name?: string; roleTag?: RoleTag }) {
    if (!doc) return;
    try {
      replaceDoc(await api.updateResumeVersion(doc.key, body));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!docs) return <p className="text-ink-soft">{error ?? "Loading…"}</p>;
  const shown = docs.filter((d) => filter === "all" || d.roleTag === filter);
  const issues = doc?.truth?.issues ?? [];
  const nonLine = issues.filter((i) => !i.lineId);

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl space-y-1">
          <h1 className="text-[34px] leading-tight font-semibold tracking-tight">Resumes</h1>
          <p className="text-ink-soft">
            Click any line on the page and type. Each save runs the Truth Check and rebuilds the one-page PDF. Applications are built from the two bases; versions are yours to keep for other role types.
          </p>
        </div>
        {!creating && <button className="btn-quiet" onClick={() => setCreating(true)}>+ New version</button>}
      </header>

      <nav className="flex flex-wrap gap-1" aria-label="Filter by role type">
        {(["all", ...ROLE_TAGS] as const).map((t) => {
          const n = t === "all" ? docs.length : docs.filter((d) => d.roleTag === t).length;
          if (t !== "all" && n === 0) return null;
          return (
            <button key={t} onClick={() => setFilter(t)} aria-pressed={filter === t}
              className={`rounded-full px-4 py-2 text-sm ${filter === t ? "bg-dark font-semibold text-white" : "border border-line bg-surface font-medium text-ink"}`}>
              {t === "all" ? "All" : ROLE_LABEL[t]} <span className="opacity-70">{n}</span>
            </button>
          );
        })}
      </nav>

      <div className="flex flex-wrap items-start gap-6">
        <aside className="flex w-full flex-col gap-2 lg:w-[240px] lg:shrink-0">
          {creating && (
            <NewVersion
              docs={docs}
              from={doc?.key ?? "base:fde"}
              onCancel={() => setCreating(false)}
              onCreated={(d) => {
                setDocs((all) => [...(all ?? []), d]);
                setSelected(d.key);
                setFilter("all");
                setCreating(false);
              }}
            />
          )}
          {shown.map((d) => (
            <button
              key={d.key}
              onClick={() => setSelected(d.key)}
              aria-current={d.key === doc?.key ? "true" : undefined}
              className={`rounded-xl border p-3.5 text-left transition-colors ${d.key === doc?.key ? "border-accent bg-accent-bg" : "border-line bg-surface hover:border-line-strong"}`}
            >
              <p className="font-semibold text-ink">
                {d.name}
                {dirtyKeys.has(d.key) && <span className="ml-1.5 text-accent" title="Unsaved changes">●</span>}
              </p>
              <p className="mt-0.5 text-[13px] text-muted">
                {d.kind === "base" ? "Base · used for applications" : ROLE_LABEL[d.roleTag]}
              </p>
              <p className={`mt-1 text-[12px] ${!d.truth ? "text-muted" : d.truth.pass ? "text-pass" : "text-fail"}`}>
                {!d.truth ? "Not saved yet" : d.truth.pass ? `Truth Check passed${d.pdfPages === 1 ? " · 1 page" : ""}` : `${d.truth.issues.filter((i) => i.severity === "fail").length} to fix`}
              </p>
            </button>
          ))}
          {shown.length === 0 && <p className="text-sm text-muted">No resumes tagged {filter !== "all" && ROLE_LABEL[filter]} yet.</p>}
        </aside>

        {doc && draft && (
          <div className="min-w-0 flex-1 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              {doc.kind === "version" ? (
                <input
                  className="min-w-[180px] flex-1 rounded-md border border-transparent bg-transparent px-1 text-xl font-semibold outline-none hover:border-line focus:border-accent"
                  aria-label="Version name"
                  value={nameDraft}
                  maxLength={80}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => nameDraft.trim() && nameDraft.trim() !== doc.name && void patchMeta({ name: nameDraft.trim() })}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
              ) : (
                <h2 className="flex-1 text-xl font-semibold">{doc.name}</h2>
              )}
              <label className="flex items-center gap-2 text-sm text-muted">
                Role type
                <select
                  className="field w-auto py-1.5 text-sm"
                  value={doc.roleTag}
                  disabled={doc.kind === "base"}
                  title={doc.kind === "base" ? "The bases keep their role types; applications are built from them." : undefined}
                  onChange={(e) => void patchMeta({ roleTag: e.target.value as RoleTag })}
                >
                  {ROLE_TAGS.map((t) => (
                    <option key={t} value={t}>{ROLE_LABEL[t]}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button className="btn-primary py-2 text-sm" disabled={busy || !dirty} onClick={() => void save()}>
                {busy ? "Checking…" : dirty ? "Save and check" : "Saved"}
              </button>
              {dirty && (
                <button className="link text-sm" onClick={() => setDrafts((all) => ({ ...all, [doc.key]: draftFrom(doc.text, draft.mode) }))}>
                  Discard changes
                </button>
              )}
              <span className="flex-1" />
              <button
                className="link text-sm"
                onClick={() => {
                  if (draft.mode === "doc") return setDraft({ mode: "source", text: resumeToText(draft.doc) });
                  try {
                    setDraft({ mode: "doc", doc: parseResume(draft.text) });
                    setError(null);
                  } catch (e) {
                    setError(`Can't show this as a page yet: ${(e as Error).message}`);
                  }
                }}
              >
                {draft.mode === "doc" ? "Edit as plain text" : "Back to page view"}
              </button>
              {doc.hasPdf && (
                <>
                  <button className="link text-sm" onClick={() => setShowPdf((s) => !s)}>{showPdf ? "Hide PDF" : "Preview PDF"}</button>
                  <a className="link text-sm" href={`/api/resumes/${encodeURIComponent(doc.key)}/file.docx`}>DOCX</a>
                </>
              )}
              {doc.kind === "version" && !confirmDelete && (
                <button className="link text-sm text-fail" onClick={() => setConfirmDelete(true)}>Delete</button>
              )}
            </div>

            {confirmDelete && (
              <p className="flex flex-wrap items-center gap-2 rounded-md bg-fail-bg px-3 py-2 text-[15px]">
                Delete "{doc.name}"? It leaves this tab; its saved history stays in the database.
                <button
                  className="btn-primary bg-fail py-1 text-sm hover:bg-fail"
                  onClick={async () => {
                    try {
                      await api.deleteResumeVersion(doc.key);
                      setDocs((all) => (all ?? []).filter((d) => d.key !== doc.key));
                      setSelected("base:fde");
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Delete
                </button>
                <button className="btn-quiet py-1 text-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
              </p>
            )}

            {error && <p className="rounded-xl bg-fail-bg px-4 py-3 text-fail" role="alert">{error}</p>}

            {doc.truth && !doc.truth.pass && (
              <details className="panel p-4" open={nonLine.some((i) => i.severity === "fail")}>
                <summary className="cursor-pointer text-[15px] font-medium text-fail">
                  Last check: {doc.truth.issues.filter((i) => i.severity === "fail").length} to fix. Problem lines are underlined on the page.
                </summary>
                <div className="mt-3">
                  <TruthPanel report={doc.truth} />
                </div>
              </details>
            )}

            {showPdf && doc.hasPdf && (
              <iframe title={`${doc.name} PDF`} src={`/api/resumes/${encodeURIComponent(doc.key)}/file.pdf?v=${doc.versionId}`} className="h-[760px] w-full rounded-md border border-line bg-white" />
            )}

            <div className="mx-auto max-w-[816px] pr-2">
              {draft.mode === "doc" ? (
                <ResumeEditor doc={draft.doc} onChange={(d) => setDraft({ mode: "doc", doc: d })} issues={issues} />
              ) : (
                <div className="space-y-2">
                  <textarea
                    aria-label={`${doc.name} as plain text`}
                    className="field min-h-[640px] font-mono text-[13px] leading-relaxed"
                    value={draft.text}
                    onChange={(e) => setDraft({ mode: "source", text: e.target.value })}
                    spellCheck
                  />
                  <p className="text-sm text-ink-soft">
                    Format: <code># Name</code>, a contact line, <code>## Section</code>, <code>### Organization | Location</code>, then a <code>Role | Dates</code> line and <code>- bullets</code>.
                  </p>
                </div>
              )}
            </div>
            <p className="text-center text-[13px] text-muted">
              Enter adds a bullet · Backspace on an empty bullet removes it · hover a line to move or delete it · {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+S saves
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
