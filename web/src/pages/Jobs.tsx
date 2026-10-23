import { useState } from "react";
import type { ExtractedFields, Job, JobStatus } from "../../../shared/types";
import { api } from "../lib/api";
import { FieldsEditor } from "../components/FieldsEditor";
import { ReasonList, VerdictBadge } from "../components/Verdict";

type View = "all" | "passing" | "failing" | "shortlisted" | "dismissed";
const VIEWS: { id: View; label: string; test: (j: Job) => boolean }[] = [
  { id: "all", label: "All", test: (j) => j.status !== "dismissed" },
  { id: "passing", label: "Passing", test: (j) => j.hardFilterPass && j.status === "new" },
  { id: "failing", label: "Failing", test: (j) => !j.hardFilterPass && j.status !== "dismissed" },
  { id: "shortlisted", label: "Shortlisted", test: (j) => j.status === "shortlisted" },
  { id: "dismissed", label: "Dismissed", test: (j) => j.status === "dismissed" },
];

const SPONSORSHIP_LABEL = { yes: "Sponsors", no: "No sponsorship", unstated: "Sponsorship not stated" } as const;

function JobRow({ job, onChange }: { job: Job; onChange: (j: Job) => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ExtractedFields | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function update(body: Parameters<typeof api.updateJob>[1]) {
    setError(null);
    try {
      onChange(await api.updateJob(job.id, body));
      setEditing(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const facts = [
    job.location ?? (job.remote ? "Remote" : "Location not stated"),
    job.yearsRequired === null ? "Years not stated" : `${job.yearsRequired}+ yrs`,
    SPONSORSHIP_LABEL[job.sponsorshipStated],
  ];

  return (
    <li className="panel">
      <button
        className="flex w-full flex-wrap items-start justify-between gap-3 p-4 text-left"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <div className="min-w-0">
          <p className="font-semibold">
            {job.title}
            {job.status === "shortlisted" && <span className="ml-2 text-sm font-medium text-accent">Shortlisted</span>}
          </p>
          <p className="text-[15px] text-ink-soft">
            {job.companyName}
            <span className="text-line"> / </span>
            {facts.join(", ")}
          </p>
        </div>
        <VerdictBadge pass={job.hardFilterPass} reasons={job.filterReasons} />
      </button>

      {open && (
        <div className="space-y-5 border-t border-line p-4">
          <ReasonList reasons={job.filterReasons} />

          {editing ? (
            <div className="space-y-4 rounded-md border border-line p-4">
              <FieldsEditor value={editing} onChange={setEditing} />
              <div className="flex gap-3">
                <button className="btn-primary" onClick={() => update({ fields: editing })}>
                  Save and re-check
                </button>
                <button className="btn-quiet" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3">
              {job.status !== "shortlisted" && (
                <button className="btn-quiet" onClick={() => update({ status: "shortlisted" })} disabled={!job.hardFilterPass}
                  title={job.hardFilterPass ? undefined : "Fix or correct the failing fields first"}>
                  Shortlist
                </button>
              )}
              {job.status !== "dismissed" ? (
                <button className="btn-quiet" onClick={() => update({ status: "dismissed" })}>
                  Dismiss
                </button>
              ) : (
                <button className="btn-quiet" onClick={() => update({ status: "new" })}>
                  Restore
                </button>
              )}
              {job.status === "shortlisted" && (
                <button className="btn-quiet" onClick={() => update({ status: "new" })}>
                  Remove from shortlist
                </button>
              )}
              <button className="btn-quiet" onClick={() => setEditing(job.extractedFields)}>
                Correct fields
              </button>
              {job.url && (
                <a className="btn-quiet" href={job.url} target="_blank" rel="noreferrer">
                  Open posting
                </a>
              )}
            </div>
          )}
          {error && <p className="text-[15px] text-fail">{error}</p>}

          <details>
            <summary className="cursor-pointer text-[15px] font-medium text-ink-soft">Job description</summary>
            <p className="mt-3 max-w-[70ch] whitespace-pre-wrap font-serif text-[15px] leading-relaxed">{job.description}</p>
          </details>
        </div>
      )}
    </li>
  );
}

export function Jobs({ jobs, setJobs }: { jobs: Job[]; setJobs: (fn: (j: Job[]) => Job[]) => void }) {
  const [view, setView] = useState<View>("all");
  const active = VIEWS.find((v) => v.id === view)!;
  const shown = jobs.filter(active.test);
  const replace = (updated: Job) => setJobs((all) => all.map((j) => (j.id === updated.id ? updated : j)));

  return (
    <section className="max-w-4xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Jobs</h1>
          <p className="text-ink-soft">Every saved posting and why it passed or failed.</p>
        </div>
        <a className="btn-primary" href="#/add">
          Add a job
        </a>
      </header>

      <nav className="flex flex-wrap gap-1" aria-label="Filter jobs">
        {VIEWS.map((v) => {
          const n = jobs.filter(v.test).length;
          return (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              aria-pressed={view === v.id}
              className={`rounded-md px-3 py-1.5 text-[15px] font-medium ${
                view === v.id ? "bg-ink text-white" : "text-ink-soft hover:bg-surface"
              }`}
            >
              {v.label} <span className="opacity-70">{n}</span>
            </button>
          );
        })}
      </nav>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-6">
          <p className="font-medium">{jobs.length === 0 ? "No jobs yet" : `No ${active.label.toLowerCase()} jobs`}</p>
          <p className="mt-1 text-[15px] text-ink-soft">
            {jobs.length === 0 ? "Paste your first posting to see it checked against your filters." : "Try another view."}
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
