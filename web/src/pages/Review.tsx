import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApplicationDetail, ApplicationSummary } from "../../../shared/types";
import { api } from "../lib/api";
import { addDays, editableLines } from "../lib/resumeLines";
import { TruthPanel } from "../components/TruthPanel";
import { ScoreBadge, ScoreBreakdownView } from "../components/Score";

type View = "review" | "blocked" | "snoozed" | "approved";
const VIEWS: { id: View; label: string }[] = [
  { id: "review", label: "To review" },
  { id: "blocked", label: "Needs fixes" },
  { id: "snoozed", label: "Snoozed" },
  { id: "approved", label: "Approved" },
];

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

function Detail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const [app, setApp] = useState<ApplicationDetail | null>(null);
  const [note, setNote] = useState("");
  const [answers, setAnswers] = useState<string[]>([]);
  const [lineEdits, setLineEdits] = useState<Record<string, string>>({});
  const [showAllLines, setShowAllLines] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((a: ApplicationDetail) => {
    setApp(a);
    setNote(a.recruiterNote ?? "");
    setAnswers(a.answers.map((x) => x.answer));
    setLineEdits({});
  }, []);

  useEffect(() => {
    setApp(null);
    api.application(id).then(load).catch((e) => setError((e as Error).message));
  }, [id, load]);

  async function act(label: string, fn: () => Promise<ApplicationDetail>) {
    setBusy(label);
    setError(null);
    try {
      load(await fn());
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const lines = useMemo(() => (app ? editableLines(app.resume) : []), [app]);
  if (!app) return <p className="text-ink-soft">{error ?? "Loading…"}</p>;

  const editable = app.status === "draft" || app.status === "ready_for_review";
  const changedIds = new Set(app.changes.map((c) => c.id));
  const flaggedIds = new Set(app.truth.issues.map((i) => i.lineId).filter(Boolean));
  const shownLines = showAllLines ? lines : lines.filter((l) => changedIds.has(l.id) || flaggedIds.has(l.id));
  const dirty =
    (app.recruiterNote ?? "") !== note ||
    app.answers.some((a, i) => a.answer !== answers[i]) ||
    Object.entries(lineEdits).some(([lid, t]) => lines.find((l) => l.id === lid)?.text !== t);
  const renderBlocked = app.truth.issues.some((i) => i.kind === "render");
  const canApprove = app.status === "ready_for_review" && app.hasPdf && app.pdfPages === 1 && !dirty;
  const pdfUrl = `/api/applications/${app.id}/resume.pdf?v=${app.truth.checkedAt}`;

  async function save() {
    await act("save", () =>
      api.editApplication(app!.id, {
        recruiterNote: note,
        answers: app!.answers.flatMap((a, i) => (a.source !== "fixed" && a.answer !== answers[i] ? [{ index: i, answer: answers[i]! }] : [])),
        lines: Object.entries(lineEdits)
          .filter(([lid, t]) => lines.find((l) => l.id === lid)?.text !== t)
          .map(([lid, text]) => ({ id: lid, text })),
      })
    );
  }

  return (
    <article className="space-y-5">
      <header className="panel space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">{app.job.title}</h2>
            <p className="text-ink-soft">
              {app.companyName}
              {app.job.location ? `, ${app.job.location}` : ""} · {app.baseType.toUpperCase()} resume
            </p>
          </div>
          <ScoreBadge score={app.fitScore} tier={app.job.tier} />
        </div>
        {app.job.scoreBreakdown && <p className="text-[15px]">{app.job.scoreBreakdown.whyFits}</p>}
        {app.job.scoreBreakdown && app.job.scoreBreakdown.gaps.length > 0 && (
          <p className="text-[15px] text-ink-soft">Gaps: {app.job.scoreBreakdown.gaps.join("; ")}</p>
        )}
        {app.prepNotes.map((n, i) => (
          <p key={i} className="text-sm text-warn">{n}</p>
        ))}
        <div className="flex flex-wrap gap-2">
          {app.job.url && <a className="btn-quiet py-1.5" href={app.job.url} target="_blank" rel="noreferrer">Open posting</a>}
          {app.job.scoreBreakdown && (
            <details className="w-full">
              <summary className="cursor-pointer text-[15px] font-medium text-ink-soft">Why this score</summary>
              <div className="mt-3"><ScoreBreakdownView b={app.job.scoreBreakdown} redFlags={app.job.redFlags} /></div>
            </details>
          )}
        </div>
      </header>

      <section className="panel p-5">
        <TruthPanel report={app.truth} override={app.truthOverride} />
        {editable && !app.truth.pass && !app.truthOverride && !renderBlocked && (
          <div className="mt-4 space-y-2 border-t border-line pt-4">
            <label className="label" htmlFor="override">Every flagged line is actually true? Override with the reason (kept on record):</label>
            <textarea id="override" className="field" rows={2} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="e.g. The 12 teams number is from my manager's email; adding it to my inventory." />
            <button className="btn-quiet" disabled={!!busy} onClick={() => act("override", () => api.override(app.id, overrideReason))}>
              Override and send to review
            </button>
          </div>
        )}
      </section>

      <section className="panel space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold">Resume</h3>
          <div className="flex flex-wrap gap-2">
            {app.hasPdf && <a className="btn-quiet py-1.5" href={pdfUrl} target="_blank" rel="noreferrer">Open PDF</a>}
            {app.hasDocx && <a className="btn-quiet py-1.5" href={`/api/applications/${app.id}/resume.docx`}>Download DOCX</a>}
            {editable && <button className="btn-quiet py-1.5" disabled={!!busy} onClick={() => act("regen", () => api.regenerate(app.id))}>{busy === "regen" ? "Regenerating…" : "Regenerate"}</button>}
          </div>
        </div>

        {app.changes.length > 0 ? (
          <ul className="space-y-3">
            {app.changes.map((c) => (
              <li key={c.id} className="space-y-1 rounded-md border border-line p-3">
                <p className="text-sm text-ink-soft">{c.where} · {c.reason}</p>
                <p className="font-serif text-[15px] text-ink-soft line-through decoration-ink-soft/50">{c.before}</p>
                <p className="font-serif text-[15px]">{c.after}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[15px] text-ink-soft">No changes from your {app.baseType.toUpperCase()} base resume.</p>
        )}

        {app.tailoring && (
          <div className="space-y-1 text-[15px]">
            {app.tailoring.keywordsCovered.length > 0 && <p><span className="font-medium">Covers:</span> {app.tailoring.keywordsCovered.join(", ")}</p>}
            {app.tailoring.keywordsMissing.length > 0 && <p><span className="font-medium">Missing:</span> {app.tailoring.keywordsMissing.join(", ")}</p>}
            {app.tailoring.honestGaps.length > 0 && <p className="text-warn"><span className="font-medium">Can't honestly claim:</span> {app.tailoring.honestGaps.join(", ")}</p>}
          </div>
        )}

        {editable && (
          <div className="space-y-3 border-t border-line pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{showAllLines ? "Every line" : "Changed and flagged lines"}</p>
              <button className="text-[15px] font-medium text-accent underline underline-offset-2" onClick={() => setShowAllLines((v) => !v)}>
                {showAllLines ? "Show only changed and flagged" : "Edit any line"}
              </button>
            </div>
            {shownLines.length === 0 && <p className="text-[15px] text-ink-soft">Nothing changed or flagged.</p>}
            {shownLines.map((l) => (
              <div key={l.id}>
                <label className="label" htmlFor={`l-${l.id}`}>
                  {l.where}
                  {flaggedIds.has(l.id) && <span className="ml-2 text-fail">flagged</span>}
                </label>
                <textarea id={`l-${l.id}`} rows={2} className={`field font-serif ${flaggedIds.has(l.id) ? "border-fail" : ""}`}
                  value={lineEdits[l.id] ?? l.text} onChange={(e) => setLineEdits((m) => ({ ...m, [l.id]: e.target.value }))} />
              </div>
            ))}
          </div>
        )}

        {app.hasPdf ? (
          <iframe title="Resume PDF preview" src={pdfUrl} className="h-[720px] w-full rounded-md border border-line bg-white" />
        ) : (
          <p className="text-[15px] text-fail">No PDF yet. See the PDF issue above.</p>
        )}
      </section>

      {(app.tier === "A" || app.recruiterNote) && (
        <section className="panel space-y-2 p-5">
          <h3 className="text-lg font-semibold">Recruiter note</h3>
          <textarea className="field font-serif" rows={5} value={note} disabled={!editable} onChange={(e) => setNote(e.target.value)} />
          <p className={`text-sm ${words(note) >= 100 ? "text-fail" : "text-ink-soft"}`}>{words(note)} of 99 words</p>
        </section>
      )}

      <section className="panel space-y-4 p-5">
        <h3 className="text-lg font-semibold">Application answers</h3>
        {app.answers.map((a, i) => (
          <div key={i}>
            <label className="label" htmlFor={`a-${i}`}>
              {a.question}
              {a.source === "fixed" && <span className="ml-2 font-normal">· fixed in Settings</span>}
              {a.source === "standard" && <span className="ml-2 font-normal">· your standard answer</span>}
            </label>
            {a.source === "fixed" ? (
              <p className="rounded-md border border-line bg-paper px-3 py-2 text-[15px] font-semibold">{a.answer}</p>
            ) : (
              <textarea id={`a-${i}`} className="field" rows={a.answer.length > 120 ? 4 : 2} value={answers[i] ?? ""} disabled={!editable}
                onChange={(e) => setAnswers((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))} />
            )}
          </div>
        ))}
      </section>

      {error && <p className="rounded-md bg-fail-bg px-3 py-2 text-[15px] text-fail" role="alert">{error}</p>}

      <section className="panel flex flex-wrap items-start gap-3 p-5">
        {editable && dirty && (
          <button className="btn-primary" disabled={!!busy} onClick={save}>{busy === "save" ? "Checking…" : "Save and re-check"}</button>
        )}
        {app.status === "ready_for_review" && (
          <button className={dirty ? "btn-quiet" : "btn-primary"} disabled={!canApprove || !!busy} onClick={() => act("approve", () => api.approve(app.id))}
            title={dirty ? "Save your edits first" : undefined}>
            Approve this application
          </button>
        )}
        {app.status === "approved" && (
          <>
            <p className="text-[15px] text-pass">Approved. In Phase 4 the app opens the form, fills it in, and you submit it yourself.</p>
            <button className="btn-quiet" disabled={!!busy} onClick={() => act("unapprove", () => api.unapprove(app.id))}>Move back to review</button>
          </>
        )}
        {app.status === "ready_for_review" && (
          <select className="field w-auto" value="" disabled={!!busy}
            onChange={(e) => e.target.value && act("snooze", () => api.snooze(app.id, addDays(Number(e.target.value))))}>
            <option value="">Snooze…</option>
            <option value="1">Until tomorrow</option>
            <option value="3">For 3 days</option>
            <option value="7">For a week</option>
          </select>
        )}
        {app.snoozedUntil && app.status === "ready_for_review" && (
          <button className="btn-quiet" onClick={() => act("unsnooze", () => api.snooze(app.id, null))}>Unsnooze</button>
        )}
        {editable && (
          <div className="flex w-full flex-wrap items-end gap-2 border-t border-line pt-3 sm:w-auto sm:border-0 sm:pt-0">
            <input className="field w-full sm:w-64" placeholder="Why not? (helps tune scoring)" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
            <button className="btn-quiet" disabled={!!busy || !rejectReason.trim()} onClick={() => act("reject", () => api.reject(app.id, rejectReason))}>
              Not applying
            </button>
          </div>
        )}
      </section>
    </article>
  );
}

export function Review({ onCountsChanged }: { onCountsChanged: () => void }) {
  const [view, setView] = useState<View>("review");
  const [lists, setLists] = useState<Record<View, ApplicationSummary[]>>({ review: [], blocked: [], snoozed: [], approved: [] });
  const [selected, setSelected] = useState<number | null>(() => {
    const m = /[?&]id=(\d+)/.exec(location.hash);
    return m ? Number(m[1]) : null;
  });

  const load = useCallback(async () => {
    const entries = await Promise.all(VIEWS.map(async (v) => [v.id, await api.applications(v.id)] as const));
    setLists(Object.fromEntries(entries) as Record<View, ApplicationSummary[]>);
    onCountsChanged();
  }, [onCountsChanged]);
  useEffect(() => {
    load();
  }, [load]);

  const items = lists[view];
  return (
    <section className="space-y-5">
      <header className="max-w-2xl space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Review</h1>
        <p className="text-ink-soft">
          Every application waits here for your approval, one at a time. Nothing reaches the review list until it passes the Truth Check.
        </p>
      </header>

      <nav className="flex flex-wrap gap-1" aria-label="Review lists">
        {VIEWS.map((v) => (
          <button key={v.id} onClick={() => setView(v.id)} aria-pressed={view === v.id}
            className={`rounded-md px-3 py-1.5 text-[15px] font-medium ${view === v.id ? "bg-ink text-white" : "text-ink-soft hover:bg-surface"}`}>
            {v.label} <span className="opacity-70">{lists[v.id].length}</span>
          </button>
        ))}
      </nav>

      <div className="grid items-start gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <ul className="space-y-2">
          {items.length === 0 && (
            <li className="rounded-lg border border-dashed border-line p-5 text-[15px] text-ink-soft">
              {view === "review" ? "Nothing to review. Accept jobs on Today to prepare applications." : "Nothing here."}
            </li>
          )}
          {items.map((a) => (
            <li key={a.id}>
              <button onClick={() => setSelected(a.id)} aria-current={selected === a.id}
                className={`panel w-full p-3 text-left ${selected === a.id ? "border-accent" : ""}`}>
                <p className="font-semibold">{a.jobTitle}</p>
                <p className="text-sm text-ink-soft">
                  {a.companyName}
                  {a.tier ? ` · Tier ${a.tier}` : ""}
                  {a.fitScore !== null ? ` · ${a.fitScore}/10` : ""}
                </p>
                {view === "blocked" && <p className="text-sm text-fail">{a.failCount} to fix</p>}
                {view === "snoozed" && a.snoozedUntil && <p className="text-sm text-ink-soft">Until {a.snoozedUntil}</p>}
              </button>
            </li>
          ))}
        </ul>
        <div>{selected ? <Detail id={selected} onChanged={load} /> : <p className="text-ink-soft">Pick an application.</p>}</div>
      </div>
    </section>
  );
}
