import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApplicationDetail, ApplicationSummary, NoteBasis, TruthIssue } from "../../../shared/types";
import { api } from "../lib/api";
import { addDays, editableLines } from "../lib/resumeLines";
import { TruthPanel } from "../components/TruthPanel";
import { SubmitPanel } from "../components/SubmitPanel";
import { ScoreBreakdownView } from "../components/Score";

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const NOTE_IDEAS = ["Shorter", "Warmer, less formal", "More specific to this role", "Lead with the Roblox HQ camp", "Drop the certificates"];

/**
 * "Suggest an edit": say how the note should change; you get a rewrite to
 * compare, with its Truth Check, and nothing is saved until you press Use this.
 */
function NoteEditor({ appId, current, onUse }: { appId: number; current: string; onUse: (text: string, basis: NoteBasis) => void }) {
  const [open, setOpen] = useState(false);
  const [how, setHow] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{ note: string; basis: NoteBasis; issues: string[] } | null>(null);

  if (!open) {
    return (
      <button className="link text-sm" onClick={() => setOpen(true)}>Suggest an edit</button>
    );
  }
  return (
    <div className="space-y-2.5 border-t border-line pt-3">
      <label className="label" htmlFor="note-how">How should it change?</label>
      <textarea id="note-how" className="field text-sm" rows={3} value={how} onChange={(e) => setHow(e.target.value)}
        placeholder="e.g. Cut it to three sentences, open with the Roblox HQ camp, and make the last line about their creator tools." />
      <div className="flex flex-wrap gap-1.5">
        {NOTE_IDEAS.map((idea) => (
          <button key={idea} type="button" className="chip border border-line bg-surface text-ink hover:border-line-strong"
            onClick={() => setHow((h) => (h.trim() ? `${h.trim().replace(/[.]$/, "")}. ${idea}.` : `${idea}.`))}>
            {idea}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary py-2 text-sm" disabled={busy || !how.trim()} onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setProposal(await api.suggestNote(appId, how, current));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}>{busy ? "Rewriting…" : proposal ? "Rewrite again" : "Rewrite it"}</button>
        <button className="link text-sm" onClick={() => { setOpen(false); setProposal(null); setHow(""); }}>Cancel</button>
      </div>
      {error && <p className="text-sm text-fail">{error}</p>}
      {proposal && (
        <div className="space-y-2 rounded-xl border border-line p-3">
          <p className="text-[13px] text-muted">Suggested note · {proposal.note.trim().split(/\s+/).length} words</p>
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{proposal.note}</p>
          {proposal.issues.length > 0 ? (
            <p className="text-[13px] text-fail">The Truth Check flags this: {proposal.issues.join(" ")} Change your instructions and rewrite again.</p>
          ) : (
            <p className="text-[13px] text-pass">Passes the Truth Check.</p>
          )}
          <div className="flex gap-2">
            <button className="btn-primary py-1.5 text-sm" disabled={proposal.issues.length > 0} onClick={() => {
              onUse(proposal.note, proposal.basis);
              setOpen(false);
              setProposal(null);
              setHow("");
            }}>Use this</button>
            <button className="btn-quiet py-1.5 text-sm" onClick={() => setProposal(null)}>Keep mine</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Mentor prompt v2, assumption protocol. Each question comes with a ready
 * line marked [CONFIRM]; nothing reaches the resume until you say yes, and
 * your answer becomes part of your inventory (data/private/confirmed_additions.md).
 */
function QuestionsForYou({ app, busy, dirty, act }: { app: ApplicationDetail; busy: string | null; dirty: boolean; act: (label: string, fn: () => Promise<ApplicationDetail>) => void }) {
  const qs = app.tailoring?.assumptions ?? [];
  const skills = app.tailoring?.skillsAdded ?? [];
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const open = qs.filter((q) => q.status === "open").length + skills.filter((k) => k.status === "open").length;
  if (qs.length === 0 && skills.length === 0) return null;
  const off = !!busy || dirty;
  const reply = (body: Parameters<typeof api.answerTailoring>[1]) => act(`q-${body.kind}-${body.index}`, () => api.answerTailoring(app.id, body));
  return (
    <div className="space-y-3 rounded-lg border border-line bg-accent-bg/40 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium text-ink">Questions for you{open > 0 ? ` · ${open} open` : ""}</p>
        {dirty && <p className="text-xs text-warn">Save your edits first</p>}
      </div>
      <p className="text-[13px] text-muted">Nothing here is on the resume until you confirm it. Your answers are saved to your inventory, so you won't be asked again.</p>
      {qs.map((q, i) => (
        <div key={`q${i}`} className="space-y-2 border-t border-line pt-3">
          <p className="text-[13px] text-muted">{q.where}</p>
          <p className="text-ink">{q.question}</p>
          {q.status === "open" ? (
            <>
              <textarea className="field text-sm" rows={2} value={drafts[i] ?? q.draft} onChange={(e) => setDrafts({ ...drafts, [i]: e.target.value })} aria-label="Draft line" />
              <p className="text-xs text-muted"><span className="chip mr-1">CONFIRM</span>Needs from you: {q.needs}</p>
              <input className="field text-sm" placeholder="Your answer (a number you give is saved as your estimate)" value={answers[i] ?? ""} onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })} />
              <div className="flex gap-2">
                <button className="btn-primary text-sm" disabled={off} onClick={() => reply({ kind: "assumption", index: i, confirmed: true, answer: answers[i], text: drafts[i] })}>Yes, use this line</button>
                <button className="btn-quiet text-sm" disabled={off} onClick={() => reply({ kind: "assumption", index: i, confirmed: false })}>No, I didn't</button>
              </div>
            </>
          ) : (
            <p className={`text-sm ${q.status === "confirmed" ? "text-pass" : "text-muted"}`}>{q.status === "confirmed" ? `Confirmed${q.answer && q.answer !== "Yes" ? `: ${q.answer}` : ""}` : "Declined; the line stays as it was."}</p>
          )}
        </div>
      ))}
      {skills.length > 0 && (
        <div className="space-y-2 border-t border-line pt-3">
          <p className="text-ink">Skills the posting wants that aren't on your resume</p>
          <p className="text-[13px] text-muted">List one only if you've used it and can describe what you built. Every one goes on Today's "Skills to build" list either way.</p>
          <ul className="space-y-1.5">
            {skills.map((k, i) => (
              <li key={`k${i}`} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-ink">{k.skill}</span>
                <span className="text-muted">{k.reason}</span>
                {k.status === "open" ? (
                  <span className="ml-auto flex gap-2">
                    <button className="link" disabled={off} onClick={() => reply({ kind: "skill", index: i, confirmed: true })}>I've used it, list it</button>
                    <button className="link text-muted" disabled={off} onClick={() => reply({ kind: "skill", index: i, confirmed: false })}>Not yet</button>
                  </span>
                ) : (
                  <span className={`ml-auto ${k.status === "confirmed" ? "text-pass" : "text-muted"}`}>{k.status === "confirmed" ? "Listed" : "To build"}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Detail({ id, onChanged, onOpen }: { id: number; onChanged: () => void; onOpen: (id: number) => void }) {
  const [app, setApp] = useState<ApplicationDetail | null>(null);
  const [note, setNote] = useState("");
  const [answers, setAnswers] = useState<string[]>([]);
  const [lineEdits, setLineEdits] = useState<Record<string, string>>({});
  const [showAllLines, setShowAllLines] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
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
              This came from your base resume. Fix it on the <a className="text-accent underline underline-offset-2" href="#/settings/resumes">Resumes page</a> too, so the next application doesn't have it.
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
        Change this line on the <a className="text-accent underline underline-offset-2" href="#/settings/resumes">Resumes page</a>, then press Rebuild from base resume.
      </p>
    );
  }

  // Your unsaved edits, as one PATCH. Saving re-runs the Truth Check and
  // re-renders the PDF, so it's also what makes the PDF match your edits.
  const editPayload = () => ({
    recruiterNote: note,
    answers: app!.answers.flatMap((a, i) => (a.source !== "fixed" && a.answer !== answers[i] ? [{ index: i, answer: answers[i]! }] : [])),
    lines: Object.entries(lineEdits)
      .filter(([lid, t]) => lines.find((l) => l.id === lid)?.text !== t)
      .map(([lid, text]) => ({ id: lid, text })),
  });

  async function save() {
    await act("save", () => api.editApplication(app!.id, editPayload()));
  }

  // With unsaved edits, Preview saves first, so it never shows the old PDF.
  // The tab opens right away (inside the click) so the browser doesn't block it.
  async function previewWithEdits(e: React.MouseEvent) {
    if (!dirty) return;
    e.preventDefault();
    const tab = window.open("", "_blank");
    setBusy("save");
    setError(null);
    try {
      const saved = await api.editApplication(app!.id, editPayload());
      load(saved);
      onChanged();
      if (tab) tab.location.href = `/api/applications/${saved.id}/resume.pdf?v=${saved.truth.checkedAt}`;
    } catch (err) {
      tab?.close();
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const tierLabel = app.tier ? `Tier ${app.tier}${app.fitScore !== null ? ` · ${app.fitScore}/10` : ""}` : "";
  const resumeLabel = app.changes.length ? `tailored ${app.baseType.toUpperCase()} resume` : `${app.baseType.toUpperCase()} base resume`;
  const fixedCount = app.answers.filter((a) => a.source === "fixed").length;

  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="flex min-w-0 flex-[999_1_620px] flex-col gap-4">
        <section>
          <p className="eyebrow">{[tierLabel, resumeLabel].filter(Boolean).join(" · ")}</p>
          <h1 className="mt-1.5 text-[34px] leading-tight font-semibold tracking-tight">{app.job.title}</h1>
          <p className="mt-1 text-[17px]">
            {app.companyName}
            {app.job.location ? ` · ${app.job.location}` : ""}
          </p>
          {app.prepNotes.map((n, i) => (
            <p key={i} className="mt-2 text-sm text-warn">{n}</p>
          ))}
        </section>

        {(app.status === "approved" || app.status === "submitted") && (
          <section className="panel-raised p-6">
            <SubmitPanel app={app} onChanged={submitChanged} />
          </section>
        )}

        {app.truth.pass && app.pdfPages === 1 ? (
          <section className="flex items-center gap-3 rounded-xl bg-pass-bg px-4 py-3 text-pass">
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
            <p className="font-medium">Truth Check passed. Every number and claim traces to your inventory. One page.</p>
          </section>
        ) : (
          <section className="panel p-6">
            <TruthPanel report={app.truth} override={app.truthOverride} fix={fixFor} />
            {editable && dirty && !app.truth.pass && (
              <button className="btn-primary mt-4" disabled={!!busy} onClick={save}>{busy === "save" ? "Checking…" : "Save and re-check"}</button>
            )}
            {editable && !app.truth.pass && !app.truthOverride && !renderBlocked && (
              <details className="mt-4 border-t border-line pt-4">
                <summary className="cursor-pointer text-sm font-medium text-muted">A flagged line is true, but the check doesn't know it</summary>
                <div className="mt-3 space-y-2">
                  <p className="text-sm">
                    The Truth Check is code: it only passes numbers and claims it can find in your candidate inventory. If a flagged line is true and just
                    missing from the inventory, you can let this application through by saying why. The reason is kept on record. Usually the better fix is to
                    edit the line, or add the fact to your inventory.
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
        )}

        <section className="panel-raised space-y-5 p-7">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-xl font-semibold">What changed in your resume</h2>
            {app.hasPdf && <a className="link text-sm" href={pdfUrl} target="_blank" rel="noreferrer" onClick={previewWithEdits}>{dirty ? "Save and preview PDF" : "Preview PDF"}</a>}
          </div>
          {app.changes.length > 0 ? (
            <ul className="divide-y divide-line">
              {app.changes.map((c) => (
                <li key={c.id} className="space-y-1 py-3.5 first:pt-0 last:pb-0">
                  <p className="text-[13px] text-muted">{c.where} · {c.reason}</p>
                  {c.before && <p className="text-[#8A9A93] line-through">{c.before}</p>}
                  <p className="text-ink">{c.after}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p>No changes from your {app.baseType.toUpperCase()} base resume.</p>
          )}

          {editable && <QuestionsForYou key={app.id} app={app} busy={busy} dirty={dirty} act={act} />}

          {app.tailoring && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium text-muted">Keywords, gaps and suggestions</summary>
              <div className="mt-2 space-y-1">
                {(app.tailoring.mustHaves?.length ?? 0) > 0 && <p><span className="font-medium text-ink">Must-haves:</span> {app.tailoring.mustHaves!.join(", ")}</p>}
                {app.tailoring.keywordsCovered.length > 0 && <p><span className="font-medium text-ink">Covered:</span> {app.tailoring.keywordsCovered.join(", ")}</p>}
                {app.tailoring.keywordsMissing.length > 0 && <p><span className="font-medium text-ink">Missing:</span> {app.tailoring.keywordsMissing.join(", ")}</p>}
                {app.tailoring.honestGaps.length > 0 && <p className="text-warn"><span className="font-medium">Can't honestly claim:</span> {app.tailoring.honestGaps.join(", ")}</p>}
                {(app.tailoring.suggestions?.length ?? 0) > 0 && (
                  <div>
                    <p className="font-medium text-ink">Worth considering (on the Resumes page, if you agree):</p>
                    <ul className="list-disc pl-5">{app.tailoring.suggestions!.map((x, i) => <li key={i}>{x}</li>)}</ul>
                  </div>
                )}
              </div>
            </details>
          )}

          {editable && (
            <div className="space-y-3">
              <button className="link text-sm" onClick={() => setShowAllLines((v) => !v)}>
                {showAllLines ? "Show only changed and flagged lines" : "Edit any line"}
              </button>
              {(showAllLines || shownLines.length > 0) && (
                <div className="space-y-3 border-t border-line pt-4">
                  {shownLines.length === 0 && <p className="text-sm text-muted">Nothing changed or flagged.</p>}
                  {shownLines.map((l) => {
                    const deleting = lineEdits[l.id] !== undefined && !lineEdits[l.id]!.trim();
                    return (
                      <div key={l.id}>
                        <div className="flex items-baseline justify-between gap-3">
                          <label className="label" htmlFor={`l-${l.id}`}>
                            {l.where}
                            {flaggedIds.has(l.id) && <span className="ml-2 text-fail">flagged</span>}
                          </label>
                          {l.id !== "contact" && (
                            <button type="button" className="text-sm font-medium text-muted hover:text-fail"
                              onClick={() =>
                                setLineEdits((m) => {
                                  if (deleting) {
                                    const { [l.id]: _drop, ...rest } = m;
                                    return rest;
                                  }
                                  return { ...m, [l.id]: "" };
                                })
                              }>
                              {deleting ? "Keep this line" : "Delete line"}
                            </button>
                          )}
                        </div>
                        {deleting ? (
                          <p className="rounded-lg border border-dashed border-fail px-3 py-2 text-muted line-through">{l.text}</p>
                        ) : (
                          <textarea id={`l-${l.id}`} rows={2} className={`field ${flaggedIds.has(l.id) ? "border-fail" : ""}`}
                            value={lineEdits[l.id] ?? l.text} onChange={(e) => setLineEdits((m) => ({ ...m, [l.id]: e.target.value }))} />
                        )}
                      </div>
                    );
                  })}
                  {Object.entries(lineEdits).some(([lid, t]) => !t.trim() && lid !== "contact") && (
                    <p className="text-sm text-muted">Deleted lines are removed when you press Save and re-check.</p>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-4 text-sm">
            {app.hasDocx && <a className="link" href={`/api/applications/${app.id}/resume.docx`}>Download DOCX</a>}
            {editable && <button className="link" disabled={!!busy} onClick={() => (dirty ? save() : act("regen", () => api.regenerate(app.id)))}>{busy === "regen" || busy === "save" ? "Making files…" : dirty ? "Save and remake PDF" : "Remake PDF"}</button>}
            {editable && (
              <button className="link" disabled={!!busy} title="Start again from your current base resume (after fixing it on the Resumes page)"
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
            {!app.hasPdf && <span className="text-fail">No PDF yet. See the PDF issue above.</span>}
          </div>
        </section>

        <details className="panel group px-7 py-5">
          <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
            <span>
              <span className="block text-lg font-semibold text-ink">Answers</span>
              <span className="text-sm text-muted">{app.answers.length} answers · {fixedCount} fixed from Settings{app.truth.pass ? " · all checked" : ""}</span>
            </span>
            <span className="link text-sm group-open:hidden">Show answers</span>
            <span className="link hidden text-sm group-open:inline">Hide</span>
          </summary>
          <div className="mt-4 space-y-4">
            {app.answers.map((a, i) => (
              <div key={i}>
                <label className="label" htmlFor={`a-${i}`}>
                  {a.question}
                  {a.source === "fixed" && <span className="ml-2 font-normal">· fixed in Settings</span>}
                  {a.source === "standard" && <span className="ml-2 font-normal">· your standard answer</span>}
                </label>
                {a.source === "fixed" ? (
                  <p className="rounded-lg border border-line bg-paper px-3 py-2 font-semibold text-ink">{a.answer}</p>
                ) : (
                  <textarea id={`a-${i}`} className="field" rows={a.answer.length > 120 ? 4 : 2} value={answers[i] ?? ""} disabled={!editable}
                    onChange={(e) => setAnswers((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))} />
                )}
              </div>
            ))}
          </div>
        </details>

        {app.job.scoreBreakdown && (
          <details className="panel group px-7 py-5">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
              <span>
                <span className="block text-lg font-semibold text-ink">Why this job</span>
                <span className="text-sm text-muted">{app.job.scoreBreakdown.whyFits}</span>
              </span>
              <span className="link text-sm group-open:hidden">Show score</span>
              <span className="link hidden text-sm group-open:inline">Hide</span>
            </summary>
            <div className="mt-4 space-y-3">
              {app.job.scoreBreakdown.gaps.length > 0 && <p className="text-sm">Gaps: {app.job.scoreBreakdown.gaps.join("; ")}</p>}
              <ScoreBreakdownView b={app.job.scoreBreakdown} redFlags={app.job.redFlags} />
              {app.job.url && <a className="link text-sm" href={app.job.url} target="_blank" rel="noreferrer">Open the posting</a>}
            </div>
          </details>
        )}
      </div>

      <aside className="flex flex-[1_1_340px] flex-col gap-4">
        <section className="panel-raised space-y-3 p-6">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Recruiter note</h2>
            <span className={`text-[13px] ${words(note) >= 100 ? "text-fail" : "text-muted"}`}>{words(note)} / 99 words</span>
          </div>
          <textarea aria-label="Recruiter note" className="field bg-paper text-sm leading-relaxed" rows={8} value={note} disabled={!editable}
            onChange={(e) => setNote(e.target.value)} placeholder={editable ? "No note yet. Press Write a note." : ""} />
          {app.noteBasis && (
            <p className="text-[13px] text-muted">
              Built around: {app.noteBasis.companyValue}, shown through {app.noteBasis.story}
              {app.noteBasis.valueSource ? ` (posting: "${app.noteBasis.valueSource}")` : ""}
            </p>
          )}
          {editable && !app.recruiterNote && !note.trim() && (
            <button className="link text-sm" disabled={!!busy} onClick={() => act("note", () => api.redraftNote(app.id))}>
              {busy === "note" ? "Writing…" : "Write a note"}
            </button>
          )}
          {editable && (app.recruiterNote || note.trim()) && (
            <NoteEditor
              appId={app.id}
              current={note}
              onUse={(text, basis) => act("note", () => api.editApplication(app.id, { recruiterNote: text, noteBasis: basis }))}
            />
          )}
        </section>

        <section className="panel space-y-3 p-6">
          {editable && dirty && (
            <button className="btn-primary w-full text-base" disabled={!!busy} onClick={save}>{busy === "save" ? "Checking…" : "Save and re-check"}</button>
          )}
          {app.status === "ready_for_review" && (
            <button className={`${dirty ? "btn-quiet" : "btn-primary"} w-full text-base`} disabled={!canApprove || !!busy}
              onClick={() => act("approve", () => api.approve(app.id))} title={dirty ? "Save your edits first" : undefined}>
              Approve →
            </button>
          )}
          {app.status === "draft" && !dirty && <p className="text-sm text-muted">Fix what the Truth Check flagged, then save. Approve unlocks when it passes.</p>}
          {app.status === "ready_for_review" && (
            <div className="flex gap-2.5">
              <select aria-label="Snooze" className="field flex-1 rounded-full text-sm font-semibold" value="" disabled={!!busy}
                onChange={(e) => e.target.value && act("snooze", () => api.snooze(app.id, addDays(Number(e.target.value))))}>
                <option value="">Snooze…</option>
                <option value="1">Until tomorrow</option>
                <option value="3">For 3 days</option>
                <option value="7">For a week</option>
              </select>
              <button className="btn-quiet flex-1 py-2 text-sm" onClick={() => setRejecting((r) => !r)}>Not applying</button>
            </div>
          )}
          {app.snoozedUntil && app.status === "ready_for_review" && (
            <button className="btn-quiet w-full" onClick={() => act("unsnooze", () => api.snooze(app.id, null))}>Unsnooze (until {app.snoozedUntil})</button>
          )}
          {editable && (rejecting || app.status === "draft") && (
            <div className="space-y-2">
              <input className="field" aria-label="Why not applying" placeholder="Why not? (helps tune scoring)" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
              <button className="btn-quiet w-full" disabled={!!busy || !rejectReason.trim()} onClick={() => act("reject", () => api.reject(app.id, rejectReason))}>
                Not applying
              </button>
            </div>
          )}
          {app.status === "approved" && (
            <button className="btn-quiet w-full" disabled={!!busy} onClick={() => act("unapprove", () => api.unapprove(app.id))}>Move back to review</button>
          )}
          {app.status === "ready_for_review" && (
            <p className="text-center text-[13px] text-muted">Approving moves it to Submit. Nothing is sent until you press Submit on the job's page.</p>
          )}
          {error && <p className="rounded-lg bg-fail-bg px-3 py-2 text-sm text-fail" role="alert">{error}</p>}
        </section>
      </aside>
    </div>
  );
}

export type Stage = "review" | "blocked" | "snoozed" | "approved";

const hashParam = (k: string) => new RegExp(`[?&]${k}=([^&]+)`).exec(location.hash)?.[1] ?? null;

/** One application at a time, with ‹ › through the rest of its stage. */
export function Review({ onCountsChanged }: { onCountsChanged: () => void }) {
  const [id, setId] = useState<number | null>(() => Number(hashParam("id")) || null);
  const stage = (hashParam("stage") as Stage | null) ?? "review";
  const [list, setList] = useState<ApplicationSummary[]>([]);

  const load = useCallback(async () => {
    setList(await api.applications(stage));
    onCountsChanged();
  }, [stage, onCountsChanged]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const idx = list.findIndex((a) => a.id === id);
  const go = (to: ApplicationSummary | undefined) => {
    if (!to) return;
    history.replaceState(null, "", `#/review?id=${to.id}&stage=${stage}`);
    setId(to.id);
    window.scrollTo(0, 0);
  };
  const STAGE_LABEL: Record<Stage, string> = { review: "Review", blocked: "Needs a fix", snoozed: "Snoozed", approved: "Ready to submit" };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a className="link text-sm" href={`#/applications?stage=${stage}`}>← Applications</a>
        {idx >= 0 && (
          <p className="text-sm text-muted">
            {STAGE_LABEL[stage]} {idx + 1} of {list.length}
          </p>
        )}
        <div className="flex gap-2">
          <button className="btn-quiet h-9 w-9 p-0" aria-label="Previous application" disabled={idx <= 0} onClick={() => go(list[idx - 1])}>‹</button>
          <button className="btn-quiet h-9 w-9 p-0" aria-label="Next application" disabled={idx < 0 || idx >= list.length - 1} onClick={() => go(list[idx + 1])}>›</button>
        </div>
      </div>
      {id ? <Detail key={id} id={id} onChanged={() => load().catch(() => {})} onOpen={setId} /> : <p className="text-muted">Pick an application from Applications.</p>}
    </div>
  );
}
