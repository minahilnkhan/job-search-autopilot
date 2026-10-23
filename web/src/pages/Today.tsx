import { useCallback, useEffect, useState } from "react";
import type { PipelineRun, Shortlist, ShortlistEntry } from "../../../shared/types";
import { api, usd } from "../lib/api";
import { ScoreBadge, ScoreBreakdownView } from "../components/Score";

const EVERIFY_TEXT = { confirmed: "E-Verify confirmed", likely: "E-Verify likely", unknown: "E-Verify not checked" } as const;
const SPONSOR_TEXT = { yes: "Sponsors visas", no: "No sponsorship", unstated: "Sponsorship not stated" } as const;

function runSummary(run: PipelineRun): string {
  const s = run.stats;
  const when = new Date(run.finishedAt ?? run.startedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  if (!s) return `Last run ${when}`;
  const stale = s.skippedStale ? `, ${s.skippedStale} older than 30 days skipped` : "";
  return `Last run ${when}: ${s.postingsSeen} postings from ${s.companies} companies, ${s.newJobs} new, ${s.scored} scored (${usd(s.costUsd)})${stale}.`;
}

function Entry({ e, onStatus }: { e: ShortlistEntry; onStatus: (id: number, status: "shortlisted" | "dismissed" | "new") => void }) {
  const [open, setOpen] = useState(false);
  const { job } = e;
  const b = job.scoreBreakdown;
  // Hard-filter warnings worth seeing before you accept. E-Verify and
  // sponsorship already have their own line.
  const checks = job.filterReasons.filter((r) => r.severity === "warn" && !["everify_unknown", "no_sponsorship"].includes(r.code));
  const posted = job.postedAt ? new Date(`${job.postedAt}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : null;

  return (
    <li className={`panel ${job.status === "dismissed" ? "opacity-60" : ""}`}>
      <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 p-4 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto]">
        <span className="pt-0.5 text-xl font-bold tabular-nums text-ink-soft">{e.rank}</span>
        <div className="min-w-0 space-y-1">
          <p className="font-semibold">
            {job.title}
            {job.status === "shortlisted" && <span className="ml-2 text-sm font-medium text-accent">Accepted</span>}
          </p>
          <p className="text-[15px] text-ink-soft">
            {job.companyName}
            {e.warmContact && <span className="text-accent"> (warm contact)</span>}
            <span className="text-line"> / </span>
            {[job.location ?? "Location not stated", posted && `posted ${posted}`].filter(Boolean).join(", ")}
          </p>
          {b && <p className="text-[15px]">{b.whyFits}</p>}
          {b && b.gaps.length > 0 && <p className="text-[15px] text-ink-soft">Gaps: {b.gaps.join("; ")}</p>}
          {checks.map((r) => (
            <p key={r.code} className="text-sm text-warn">Check: {r.message}</p>
          ))}
          <p className="text-sm text-ink-soft">
            <span className={e.eVerify === "unknown" ? "text-warn" : ""}>{EVERIFY_TEXT[e.eVerify]}</span>
            {", "}
            <span className={job.sponsorshipStated === "no" ? "text-warn" : ""}>{SPONSOR_TEXT[job.sponsorshipStated]}</span>
          </p>
        </div>
        <div className="col-start-2 mt-3 flex flex-wrap items-start gap-2 sm:col-start-3 sm:mt-0 sm:flex-col sm:items-end">
          <ScoreBadge score={job.fitScore} tier={job.tier} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
        {job.status !== "shortlisted" ? (
          <button className="btn-primary py-1.5" onClick={() => onStatus(job.id, "shortlisted")}>Accept</button>
        ) : (
          <button className="btn-quiet py-1.5" onClick={() => onStatus(job.id, "new")}>Undo accept</button>
        )}
        {job.status !== "dismissed" ? (
          <button className="btn-quiet py-1.5" onClick={() => onStatus(job.id, "dismissed")}>Dismiss</button>
        ) : (
          <button className="btn-quiet py-1.5" onClick={() => onStatus(job.id, "new")}>Restore</button>
        )}
        {job.url && <a className="btn-quiet py-1.5" href={job.url} target="_blank" rel="noreferrer">Open posting</a>}
        {b && (
          <button className="btn-quiet py-1.5" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide score" : "Why this score"}
          </button>
        )}
      </div>
      {open && b && (
        <div className="border-t border-line p-4">
          <ScoreBreakdownView b={b} redFlags={job.redFlags} />
        </div>
      )}
    </li>
  );
}

export function Today({ onJobsChanged }: { onJobsChanged: () => void }) {
  const [list, setList] = useState<Shortlist | null | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<PipelineRun | null>(null);
  const [spend, setSpend] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [sl, runs, month] = await Promise.all([api.getShortlist(), api.listRuns(), api.monthSpend()]);
    setList(sl);
    setRunning(runs.running);
    setLastRun(runs.runs[0] ?? null);
    setSpend(month.costUsd);
    return runs.running;
  }, []);

  useEffect(() => {
    load().catch((err) => setError((err as Error).message));
  }, [load]);

  // While a run is going, check every few seconds and refresh when it ends.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const stillRunning = await load();
      if (!stillRunning) onJobsChanged();
    }, 3000);
    return () => clearInterval(t);
  }, [running, load, onJobsChanged]);

  async function runNow() {
    setError(null);
    try {
      await api.runPipeline();
      setRunning(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function setStatus(id: number, status: "shortlisted" | "dismissed" | "new") {
    const updated = await api.updateJob(id, { status });
    setList((l) => l && { ...l, entries: l.entries.map((e) => (e.job.id === id ? { ...e, job: { ...e.job, ...updated } } : e)) });
    onJobsChanged();
  }

  const accepted = list?.entries.filter((e) => e.job.status === "shortlisted").length ?? 0;
  const dateLabel = list ? new Date(`${list.date}T12:00:00`).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }) : null;

  return (
    <section className="max-w-4xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">{dateLabel ? `Picks for ${dateLabel}` : "Today's picks"}</h1>
          <p className="text-ink-soft">
            {list ? `${list.entries.length} ranked jobs, ${accepted} accepted. Accept the ones you'll apply to.` : "Ranked jobs from your companies' job boards, scored against your mentor rubric."}
          </p>
        </div>
        <button className="btn-primary" onClick={runNow} disabled={running}>
          {running ? "Running…" : "Run now"}
        </button>
      </header>

      <div className="space-y-1 text-[15px] text-ink-soft" role="status">
        {running && <p className="text-ink">Fetching job boards and scoring. This takes a few minutes; the list updates when it's done.</p>}
        {!running && lastRun && <p>{runSummary(lastRun)}</p>}
        {!running && lastRun?.message && (
          <p className={lastRun.status === "failed" ? "text-fail" : "text-warn"}>{lastRun.message}</p>
        )}
        {spend !== null && <p>AI spend this month: {usd(spend)}</p>}
        {error && <p className="text-fail">{error}</p>}
      </div>

      {list === undefined ? null : !list || list.entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-6">
          <p className="font-medium">{list ? "No jobs made the list" : "No picks yet"}</p>
          <p className="mt-1 text-[15px] text-ink-soft">
            {list
              ? "Nothing scored Tier A or B. Check the run message above, or add companies with job boards."
              : "The first run happens at your scheduled time, or press Run now."}
          </p>
        </div>
      ) : (
        <ol className="space-y-3">
          {list.entries.map((e) => (
            <Entry key={e.job.id} e={e} onStatus={setStatus} />
          ))}
        </ol>
      )}
    </section>
  );
}
