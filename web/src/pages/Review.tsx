import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApplicationDetail, ApplicationSummary, TruthIssue } from "../../../shared/types";
import { api } from "../lib/api";
import { addDays, editableLines } from "../lib/resumeLines";
import { TruthPanel } from "../components/TruthPanel";
import { SubmitPanel } from "../components/SubmitPanel";
import { ScoreBadge, ScoreBreakdownView } from "../components/Score";
import { PreparingTray, type Preparing } from "../components/PreparingTray";

type View = "review" | "blocked" | "snoozed" | "approved";
const VIEWS: { id: View; label: string }[] = [
  { id: "review", label: "To review" },
  { id: "blocked", label: "Needs fixes" },
  { id: "snoozed", label: "Snoozed" },
  { id: "approved", label: "Approved" },
];

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

function Detail({ id, onChanged, onOpen }: { id: number; onChanged: () => void; onOpen: (id: number) => void }) {
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
  const submitChanged = useCallback((a: ApplicationDetail) => {
    load(a);
    onChanged();
  }, [load, onChanged]);
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

  // An edit box under each Truth Check problem, bound to the same drafts as
  // the sections below, so you fix it where it's flagged.
  function fixFor(issue: TruthIssue) {
    if (!editable) return null;
    const line = issue.lineId ? lines.find((l) => l.id === issue.lineId) : undefined;
    if (line) {
      return (
        <div className="space-y-1 pt-1">
          <textarea aria-label={`Fix ${issue.where}`} rows={line.id === "contact" ? 1 : 2} className="field font-serif"
            value={lineEdits[line.id] ?? line.text} onChange={(e) => setLineEdits((m) => ({ ...m, [line.id]: e.target.value }))} />
          {issue.kind === "placeholder" && (
            <p className="text-sm text-ink-soft">
              This came from your base resume. Fix it on the <a className="text-accent underline underline-offset-2" href="#/resumes">Resumes page</a> too, so the next application doesn't have it.
            </p>
          )}
        </div>
      );
    }
    if (issue.where === "Recruiter note") {
      return <textarea aria-label="Fix recruiter note" rows={4} className="field font-serif" value={note} onChange={(e) => setNote(e.target.value)} />;
    }
    if (issue.where.startsWith("Answer › ")) {
      const q = issue.where.slice("Answer › ".length);
      const i = app!.answers.findIndex((a) => a.question === q && a.source !== "fixed");
      if (i === -1) return null;
      return (
        <div className="space-y-1 pt-1">
          <textarea aria-label={`Fix answer: ${q}`} rows={2} className="field" value={answers[i] ?? ""}
            onChange={(e) => setAnswers((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))} />
          {app!.answers[i]!.source === "standard" && (
            <p className="text-sm text-ink-soft">
              This is one of your standard answers. Set it once in <a className="text-accent underline underline-offset-2" href="#/settings">Settings</a> and
              every new application gets it.
            </p>
          )}
        </div>
      );
    }
    if (issue.kind === "render") return null;
    // Company, title and date lines aren't editable per application.
    return (
      <p className="text-sm text-ink-soft">
        Change this line on the <a className="text-accent underline underline-offset-2" href="#/resumes">Resumes page</a>, then press Rebuild from base resume.
      </p>
    );
  }

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
        <TruthPanel report={app.truth} override={app.truthOverride} fix={fixFor} />
        {editable && dirty && !app.truth.pass && (
          <button className="btn-primary mt-4" disabled={!!busy} onClick={save}>{busy === "save" ? "Checking…" : "Save and re-check"}</button>
        )}
        {editable && !app.truth.pass && !app.truthOverride && !renderBlocked && (
          <details className="mt-4 border-t border-line pt-4">
            <summary className="cursor-pointer text-[15px] font-medium text-ink-soft">A flagged line is true, but the check doesn't know it</summary>
            <div className="mt-3 space-y-2">
              <p className="text-[15px]">
                The Truth Check is code: it only passes numbers and claims it can find in your candidate inventory. If a flagged line is true
                and just missing from the inventory, you can let this application through by saying why. The reason is kept on record.
                Usually the better fix is to edit the line above, or add the fact to your inventory.
              </p>
              <textarea id="override" aria-label="Why the flagged lines are true" className="field" rows={2} value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)} placeholder="e.g. The 12 teams number is from my manager's email." />
              <button className="btn-quiet" disabled={!!busy || overrideReason.trim().length < 10} onClick={() => act("override", () => api.override(app.id, overrideReason))}>
                Let it through
              </button>
            </div>
          </details>
        )}
      </section>

      <section className="panel space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold">Resume</h3>
          <div className="flex flex-wrap gap-2">
            {app.hasPdf && <a className="btn-quiet py-1.5" href={pdfUrl} target="_blank" rel="noreferrer">Open PDF</a>}
            {app.hasDocx && <a className="btn-quiet py-1.5" href={`/api/applications/${app.id}/resume.docx`}>Download DOCX</a>}
            {editable && <button className="btn-quiet py-1.5" disabled={!!busy} title="Re-make the PDF and DOCX from the text below" onClick={() => act("regen", () => api.regenerate(app.id))}>{busy === "regen" ? "Making files…" : "Remake PDF"}</button>}
            {editable && (
              <button className="btn-quiet py-1.5" disabled={!!busy} title="Start this application again from your current base resume (after you've fixed it on the Resumes page)"
                onClick={async () => {
                  setBusy("restart");
                  setError(null);
                  try {
                    const fresh = await api.restart(app.id);
                    onChanged();
                    location.hash = `#/review?id=${fresh.id}`;
                    onOpen(fresh.id);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(null);
                  }
                }}>
                {busy === "restart" ? (app.tier === "A" ? "Re-tailoring…" : "Rebuilding…") : "Rebuild from base resume"}
              </button>
            )}
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
            {(app.tailoring.mustHaves?.length ?? 0) > 0 && <p><span className="font-medium">Must-haves in the posting:</span> {app.tailoring.mustHaves!.join(", ")}</p>}
            {app.tailoring.keywordsCovered.length > 0 && <p><span className="font-medium">Covers:</span> {app.tailoring.keywordsCovered.join(", ")}</p>}
            {app.tailoring.keywordsMissing.length > 0 && <p><span className="font-medium">Missing:</span> {app.tailoring.keywordsMissing.join(", ")}</p>}
            {app.tailoring.honestGaps.length > 0 && <p className="text-warn"><span className="font-medium">Can't honestly claim:</span> {app.tailoring.honestGaps.join(", ")}</p>}
            {(app.tailoring.suggestions?.length ?? 0) > 0 && (
              <div>
                <p className="font-medium">Worth considering (edit on the Resumes page if you agree):</p>
                <ul className="list-disc pl-5">{app.tailoring.suggestions!.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )}
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
          <details className="border-t border-line pt-4">
            <summary className="cursor-pointer text-[15px] font-medium text-ink-soft">Preview the PDF here</summary>
            <iframe title="Resume PDF preview" src={pdfUrl} className="mt-3 h-[720px] w-full rounded-md border border-line bg-white" />
          </details>
        ) : (
          <p className="text-[15px] text-fail">No PDF yet. See the PDF issue above.</p>
        )}
      </section>

      <section className="panel space-y-2 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold">Recruiter note</h3>
          {editable && (
            <button className="btn-quiet py-1.5" disabled={!!busy} onClick={() => act("note", () => api.redraftNote(app.id))}>
              {busy === "note" ? "Writing…" : app.recruiterNote ? "Write it again" : "Write a note"}
            </button>
          )}
        </div>
        <p className="text-sm text-ink-soft">A draft from your inventory, for the application form or a LinkedIn message. Edit it freely.</p>
        {app.noteBasis && (
          <dl className="grid gap-x-3 gap-y-1 rounded-md bg-paper p-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="font-medium text-ink-soft">Built around</dt>
            <dd>
              {app.noteBasis.companyValue}
              {app.noteBasis.valueSource ? <span className="text-ink-soft"> (posting: "{app.noteBasis.valueSource}")</span> : <span className="text-ink-soft"> (the posting states no values)</span>}
            </dd>
            <dt className="font-medium text-ink-soft">Shown through</dt>
            <dd>{app.noteBasis.story}</dd>
            <dt className="font-medium text-ink-soft">Standout</dt>
            <dd>{app.noteBasis.standout}</dd>
          </dl>
        )}
        <textarea aria-label="Recruiter note" className="field font-serif" rows={5} value={note} disabled={!editable} onChange={(e) => setNote(e.target.value)}
          placeholder={editable ? "No note yet. Press Write a note." : ""} />
        <p className={`text-sm ${words(note) >= 100 ? "text-fail" : "text-ink-soft"}`}>{words(note)} of 99 words</p>
      </section>

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
        {(app.status === "approved" || app.status === "submitted") && (
          <SubmitPanel app={app} onChanged={submitChanged} />
        )}
        {app.status === "approved" && (
          <button className="btn-quiet" disabled={!!busy} onClick={() => act("unapprove", () => api.unapprove(app.id))}>Move back to review</button>
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

  const [preparing, setPreparing] = useState<Preparing[]>([]);

  const load = useCallback(async () => {
    const [entries, prep] = await Promise.all([
      Promise.all(VIEWS.map(async (v) => [v.id, await api.applications(v.id)] as const)),
      api.preparing(),
    ]);
    setLists(Object.fromEntries(entries) as Record<View, ApplicationSummary[]>);
    setPreparing(prep);
    onCountsChanged();
  }, [onCountsChanged]);
  useEffect(() => {
    load();
  }, [load]);

  // Open on whichever list has something in it, so a new application that
  // needs fixes isn't hidden behind an empty "To review" tab.
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current || Object.values(lists).every((l) => l.length === 0)) return;
    picked.current = true;
    if (lists.review.length === 0 && lists.blocked.length > 0) setView("blocked");
  }, [lists]);

  // Accepted jobs land here as they finish preparing.
  const inFlight = preparing.some((p) => !p.error);
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => load().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [inFlight, load]);

  const items = lists[view];
  return (
    <section className="space-y-5">
      <header className="max-w-2xl space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Review</h1>
        <p className="text-ink-soft">
          Every application waits here for your approval, one at a time. Nothing reaches the review list until it passes the Truth Check.
        </p>
      </header>

      <PreparingTray items={preparing} onChanged={() => load().catch(() => {})} />

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
        <div>{selected ? <Detail id={selected} onChanged={load} onOpen={setSelected} /> : <p className="text-ink-soft">Pick an application.</p>}</div>
      </div>
    </section>
  );
}
