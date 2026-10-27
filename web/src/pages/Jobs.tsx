import { useEffect, useState } from "react";
import type { ExtractedFields, JobListItem } from "../../../shared/types";
import { api } from "../lib/api";
import { FieldsEditor } from "../components/FieldsEditor";
import { ReasonList, VerdictBadge } from "../components/Verdict";
import { ScoreBadge, ScoreBreakdownView } from "../components/Score";
import { AcceptButton } from "../components/AcceptButton";

type View = "all" | "passing" | "failing" | "accepted" | "dismissed" | "offTarget";
const isOffTarget = (j: JobListItem) => j.filterReasons.some((r) => r.code === "off_target_role");
const VIEWS: { id: View; label: string; test: (j: JobListItem) => boolean }[] = [
  { id: "all", label: "All", test: (j) => j.status !== "dismissed" && !isOffTarget(j) },
  { id: "passing", label: "Passing", test: (j) => j.hardFilterPass && j.status === "new" },
  { id: "failing", label: "Failing", test: (j) => !j.hardFilterPass && j.status !== "dismissed" && !isOffTarget(j) },
  { id: "accepted", label: "Accepted", test: (j) => j.status === "shortlisted" },
  { id: "dismissed", label: "Dismissed", test: (j) => j.status === "dismissed" },
  { id: "offTarget", label: "Not a target role", test: isOffTarget },
];

const SPONSORSHIP_LABEL = { yes: "Sponsors", no: "No sponsorship", unstated: "Sponsorship not stated" } as const;
const SOURCE_LABEL: Record<string, string> = { manual: "Pasted", greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" };

function JobRow({ job, onChange, selected, onSelect }: { job: JobListItem; onChange: (j: JobListItem) => void; selected: boolean; onSelect: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ExtractedFields | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<JobListItem>) {
    setError(null);
    setBusy(true);
    try {
      onChange(await fn());
      setEditing(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const update = (body: Parameters<typeof api.updateJob>[1]) => act(() => api.updateJob(job.id, body));

  const facts = [
    job.location ?? (job.remote ? "Remote" : "Location not stated"),
    job.yearsRequired === null ? "Years not stated" : `${job.yearsRequired}+ yrs`,
    SPONSORSHIP_LABEL[job.sponsorshipStated],
    SOURCE_LABEL[job.source] ?? job.source,
  ];

  return (
    <li className={`panel ${selected ? "border-accent" : ""}`}>
      <div className="flex items-start">
      <label className="flex cursor-pointer items-center self-stretch pl-4" title="Select">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${job.title} at ${job.companyName}`} />
      </label>
      <button className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-3 p-4 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <div className="min-w-0">
          <p className="font-semibold">
            {job.title}
            {job.status === "shortlisted" && <span className="ml-2 text-sm font-medium text-accent">Accepted</span>}
          </p>
          <p className="text-[15px] text-ink-soft">
            {job.companyName}
            <span className="text-line"> / </span>
            {facts.join(", ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ScoreBadge score={job.fitScore} tier={job.tier} />
          <VerdictBadge pass={job.hardFilterPass} reasons={job.filterReasons} />
        </div>
      </button>
      </div>

      {open && (
        <div className="space-y-5 border-t border-line p-4">
          <ReasonList reasons={job.filterReasons} />

          {job.scoreBreakdown && (
            <div className="rounded-md border border-line p-4">
              <p className="mb-3 font-semibold">{job.scoreBreakdown.whyFits}</p>
              <ScoreBreakdownView b={job.scoreBreakdown} redFlags={job.redFlags} />
            </div>
          )}

          {editing ? (
            <div className="space-y-4 rounded-md border border-line p-4">
              <FieldsEditor value={editing} onChange={setEditing} />
              <div className="flex gap-3">
                <button className="btn-primary" disabled={busy} onClick={() => update({ fields: editing })}>Save and re-check</button>
                <button className="btn-quiet" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {job.hardFilterPass && (
                <button className="btn-quiet" disabled={busy} onClick={() => act(() => api.scoreJob(job.id))}>
                  {busy ? "Scoring…" : job.scoredAt ? "Score again" : "Score now"}
                </button>
              )}
              {job.status !== "shortlisted" ? (
                job.hardFilterPass && (
                  <AcceptButton jobId={job.id} tier={job.tier} className="btn-quiet" onDone={() => api.getJob(job.id).then(onChange)} />
                )
              ) : (
                <a className="btn-quiet" href="#/applications">Open in Review</a>
              )}
              {job.status !== "dismissed" ? (
                <button className="btn-quiet" onClick={() => update({ status: "dismissed" })}>Dismiss</button>
              ) : (
                <button className="btn-quiet" onClick={() => update({ status: "new" })}>Restore</button>
              )}
              <button className="btn-quiet" onClick={() => setEditing(job.extractedFields)}>Correct fields</button>
              {job.url && <a className="btn-quiet" href={job.url} target="_blank" rel="noreferrer">Open posting</a>}
            </div>
          )}
          {error && <p className="text-[15px] text-fail">{error}</p>}

          <details onToggle={(e) => (e.currentTarget.open && description === null ? api.getJob(job.id).then((j) => setDescription(j.description)) : undefined)}>
            <summary className="cursor-pointer text-[15px] font-medium text-ink-soft">Job description</summary>
            <p className="mt-3 max-w-[70ch] whitespace-pre-wrap font-serif text-[15px] leading-relaxed">{description ?? "Loading…"}</p>
          </details>
        </div>
      )}
    </li>
  );
}

export function Jobs({ jobs, setJobs }: { jobs: JobListItem[]; setJobs: (fn: (j: JobListItem[]) => JobListItem[]) => void }) {
  const [view, setView] = useState<View>("all");
  const [offTarget, setOffTarget] = useState<JobListItem[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Off-target board postings aren't in the main list (there can be hundreds); load them on demand.
  useEffect(() => {
    if (view === "offTarget" && offTarget === null) api.listJobs(true).then((all) => setOffTarget(all.filter(isOffTarget)));
  }, [view, offTarget]);

  const active = VIEWS.find((v) => v.id === view)!;
  const source = view === "offTarget" ? (offTarget ?? []) : jobs;
  const shown = source.filter(active.test).sort((a, b) => (b.fitScore ?? -1) - (a.fitScore ?? -1) || b.createdAt - a.createdAt);
  const replace = (updated: JobListItem) => setJobs((all) => all.map((j) => (j.id === updated.id ? { ...j, ...updated } : j)));
  const picked = shown.filter((j) => selected.has(j.id));
  const allPicked = shown.length > 0 && picked.length === shown.length;
  const select = (id: number, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  async function deletePicked() {
    setBusy(true);
    setMessage(null);
    try {
      const ids = picked.map((j) => j.id);
      const r = await api.deleteJobs(ids);
      const keptIds = new Set(r.kept.map((k) => k.id));
      const gone = new Set(ids.filter((id) => !keptIds.has(id)));
      setJobs((all) => all.filter((j) => !gone.has(j.id)));
      setOffTarget((o) => o && o.filter((j) => !gone.has(j.id)));
      setSelected(new Set());
      setConfirming(false);
      setMessage({
        ok: true,
        text: `Deleted ${r.deleted} job${r.deleted === 1 ? "" : "s"}.${r.kept.length ? ` Kept ${r.kept.length} you've already submitted an application for (they stay on the Tracker).` : ""}`,
      });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[34px] leading-tight font-semibold tracking-tight">Jobs</h1>
          <p className="text-ink-soft">Everything saved or fetched, best score first, with why it passed or failed.</p>
        </div>
        <a className="btn-primary" href="#/add">Add a job</a>
      </header>

      <nav className="flex flex-wrap gap-1" aria-label="Filter jobs">
        {VIEWS.map((v) => {
          const n = v.id === "offTarget" ? offTarget?.length : jobs.filter(v.test).length;
          return (
            <button
              key={v.id}
              onClick={() => {
                setView(v.id);
                setSelected(new Set());
                setConfirming(false);
              }}
              aria-pressed={view === v.id}
              className={`rounded-full px-4 py-2 text-sm ${view === v.id ? "bg-dark font-semibold text-white" : "border border-line bg-surface font-medium text-ink"}`}
            >
              {v.label} {n !== undefined && <span className="opacity-70">{n}</span>}
            </button>
          );
        })}
      </nav>

      {view === "offTarget" && (
        <p className="text-[15px] text-ink-soft">Job-board postings outside your target roles (FDE, solutions, deployment, applied AI, new-grad or full-stack/backend SWE). They're kept so they aren't checked again, and they're never scored. To score one anyway, add it on Add a job.</p>
      )}

      {shown.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[15px]">
            <input type="checkbox" className="h-4 w-4 accent-accent" checked={allPicked}
              ref={(el) => {
                if (el) el.indeterminate = picked.length > 0 && !allPicked;
              }}
              onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((j) => j.id)) : new Set())} />
            Select all {shown.length}
          </label>
          {picked.length > 0 && !confirming && (
            <button className="btn-quiet py-1.5 text-fail" onClick={() => setConfirming(true)}>Delete {picked.length}</button>
          )}
          {confirming && (
            <span className="flex flex-wrap items-center gap-2 rounded-md bg-fail-bg px-3 py-1.5 text-[15px]">
              Delete {picked.length} job{picked.length === 1 ? "" : "s"}? Applications you haven't submitted are withdrawn. The daily run won't add them back.
              <button className="btn-primary bg-fail py-1 hover:bg-fail" disabled={busy} onClick={deletePicked}>{busy ? "Deleting…" : "Delete"}</button>
              <button className="btn-quiet py-1" onClick={() => setConfirming(false)}>Cancel</button>
            </span>
          )}
        </div>
      )}
      {message && <p className={`text-[15px] ${message.ok ? "text-pass" : "text-fail"}`} role="status">{message.text}</p>}

      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-6">
          <p className="font-medium">{jobs.length === 0 ? "No jobs yet" : `No ${active.label.toLowerCase()} jobs`}</p>
          <p className="mt-1 text-[15px] text-ink-soft">
            {jobs.length === 0 ? "Paste a posting, or press Run now on Today to pull from your companies' job boards." : "Try another view."}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {shown.map((j) => (
            <JobRow key={j.id} job={j} onChange={replace} selected={selected.has(j.id)} onSelect={(on) => select(j.id, on)} />
          ))}
        </ul>
      )}
    </section>
  );
}
