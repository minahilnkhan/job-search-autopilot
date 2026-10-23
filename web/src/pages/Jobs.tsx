import { useEffect, useState } from "react";
import type { ExtractedFields, JobListItem } from "../../../shared/types";
import { api } from "../lib/api";
import { FieldsEditor } from "../components/FieldsEditor";
import { ReasonList, VerdictBadge } from "../components/Verdict";
import { ScoreBadge, ScoreBreakdownView } from "../components/Score";

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

function JobRow({ job, onChange }: { job: JobListItem; onChange: (j: JobListItem) => void }) {
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
    <li className="panel">
      <button className="flex w-full flex-wrap items-start justify-between gap-3 p-4 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
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
                <button className="btn-quiet" onClick={() => update({ status: "shortlisted" })} disabled={!job.hardFilterPass}
                  title={job.hardFilterPass ? undefined : "Fix or correct the failing fields first"}>
                  Accept
                </button>
              ) : (
                <button className="btn-quiet" onClick={() => update({ status: "new" })}>Undo accept</button>
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

  // Off-target board postings aren't in the main list (there can be hundreds); load them on demand.
  useEffect(() => {
    if (view === "offTarget" && offTarget === null) api.listJobs(true).then((all) => setOffTarget(all.filter(isOffTarget)));
  }, [view, offTarget]);

  const active = VIEWS.find((v) => v.id === view)!;
  const source = view === "offTarget" ? (offTarget ?? []) : jobs;
  const shown = source.filter(active.test).sort((a, b) => (b.fitScore ?? -1) - (a.fitScore ?? -1) || b.createdAt - a.createdAt);
  const replace = (updated: JobListItem) => setJobs((all) => all.map((j) => (j.id === updated.id ? { ...j, ...updated } : j)));

  return (
    <section className="max-w-4xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Jobs</h1>
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
              onClick={() => setView(v.id)}
              aria-pressed={view === v.id}
              className={`rounded-md px-3 py-1.5 text-[15px] font-medium ${view === v.id ? "bg-ink text-white" : "text-ink-soft hover:bg-surface"}`}
            >
              {v.label} {n !== undefined && <span className="opacity-70">{n}</span>}
            </button>
          );
        })}
      </nav>

      {view === "offTarget" && (
        <p className="text-[15px] text-ink-soft">Job-board postings outside your target roles (FDE, solutions, deployment, applied AI, new-grad or full-stack/backend SWE). They're kept so they aren't checked again, and they're never scored. To score one anyway, add it on Add a job.</p>
      )}

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
            <JobRow key={j.id} job={j} onChange={replace} />
          ))}
        </ul>
      )}
    </section>
  );
}
