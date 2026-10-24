import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineProgress, PipelineRun, Shortlist, ShortlistEntry } from "../../../shared/types";
import { api, usd } from "../lib/api";
import { ScoreBadge, ScoreBreakdownView } from "../components/Score";
import { PreparingTray, type Preparing } from "../components/PreparingTray";

const EVERIFY_TEXT = { confirmed: "E-Verify confirmed", likely: "E-Verify likely", unknown: "E-Verify not checked" } as const;
const SPONSOR_TEXT = { yes: "Sponsors visas", no: "No sponsorship", unstated: "Sponsorship not stated" } as const;
const SWIPE_DISTANCE = 110; // px of drag that counts as a decision

type LastAction = { kind: "skip" | "accept"; entry: ShortlistEntry };

function runSummary(run: PipelineRun): string {
  const s = run.stats;
  const when = new Date(run.finishedAt ?? run.startedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  if (!s) return `Last run ${when}`;
  const stale = s.skippedStale ? `, ${s.skippedStale} older than 30 days skipped` : "";
  return `Last run ${when}: ${s.postingsSeen} postings from ${s.companies} companies, ${s.newJobs} new, ${s.scored} scored (${usd(s.costUsd)})${stale}.`;
}

function progressText(p: PipelineProgress | null): string {
  if (!p) return "Starting…";
  if (p.stopRequested) return `Stopping after the jobs already being scored. ${p.scored} scored so far (${usd(p.costUsd)}); the rest wait for the next run.`;
  if (p.phase === "fetching") return `Fetching job boards: ${p.companiesDone} of ${p.companiesTotal} companies. This part is free.`;
  return `Scoring ${p.scored} of ${p.toScore} jobs, ${usd(p.costUsd)} so far. The deck updates when it's done.`;
}

/** One job, full detail. Drag it right to accept, left to skip. */
function Card({ e, position, total, onDecide }: {
  e: ShortlistEntry;
  position: number;
  total: number;
  onDecide: (kind: "skip" | "accept") => void;
}) {
  const [open, setOpen] = useState(false);
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const { job } = e;
  const b = job.scoreBreakdown;
  const checks = job.filterReasons.filter((r) => r.severity === "warn" && !["everify_unknown", "no_sponsorship"].includes(r.code));
  const posted = job.postedAt ? new Date(`${job.postedAt}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : null;

  // Pointer drag, only from the card body (not its buttons and links).
  function down(ev: React.PointerEvent) {
    if ((ev.target as HTMLElement).closest("a,button")) return;
    start.current = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }
  function move(ev: React.PointerEvent) {
    if (!start.current) return;
    setDx(ev.clientX - start.current.x);
  }
  function up() {
    if (!start.current) return;
    start.current = null;
    if (dx > SWIPE_DISTANCE) onDecide("accept");
    else if (dx < -SWIPE_DISTANCE) onDecide("skip");
    setDx(0);
  }

  const hint = dx > 40 ? "accept" : dx < -40 ? "skip" : null;

  return (
    <article
      aria-label={`${job.title} at ${job.companyName}`}
      className="panel relative touch-pan-y select-none shadow-sm"
      style={{
        transform: dx ? `translateX(${dx}px) rotate(${dx / 40}deg)` : undefined,
        transition: start.current ? "none" : "transform 160ms ease-out",
      }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        start.current = null;
        setDx(0);
      }}
    >
      {hint && (
        <span
          className={`absolute top-4 rounded-md border-2 px-2 py-0.5 text-sm font-bold uppercase tracking-wide ${
            hint === "accept" ? "left-4 border-pass text-pass" : "right-4 border-fail text-fail"
          }`}
        >
          {hint === "accept" ? "Accept" : "Skip"}
        </span>
      )}
      <div className="space-y-3 p-5">
        <p className="text-sm text-ink-soft">
          {position} of {total} · Tier {job.tier}
        </p>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="text-xl font-bold tracking-tight">{job.title}</h2>
            <p className="text-[15px] text-ink-soft">
              {job.companyName}
              {e.warmContact && <span className="text-accent"> (warm contact)</span>}
              <span className="text-line"> / </span>
              {[job.location ?? "Location not stated", posted && `posted ${posted}`].filter(Boolean).join(", ")}
            </p>
          </div>
          <ScoreBadge score={job.fitScore} tier={job.tier} />
        </div>
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
        <div className="flex flex-wrap gap-2 pt-1">
          {job.url && <a className="btn-quiet py-1.5" href={job.url} target="_blank" rel="noreferrer">Open posting</a>}
          {b && (
            <button className="btn-quiet py-1.5" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? "Hide score" : "Why this score"}
            </button>
          )}
        </div>
      </div>
      {open && b && (
        <div className="border-t border-line p-5">
          <ScoreBreakdownView b={b} redFlags={job.redFlags} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 border-t border-line p-3">
        <button className="btn-quiet" onClick={() => onDecide("skip")}>
          <span aria-hidden>←</span> Skip
        </button>
        <button className="btn-primary" onClick={() => onDecide("accept")}>
          Accept and prepare <span aria-hidden>→</span>
        </button>
      </div>
    </article>
  );
}

export function Today({ onJobsChanged }: { onJobsChanged: () => void }) {
  const [list, setList] = useState<Shortlist | null | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [lastRun, setLastRun] = useState<PipelineRun | null>(null);
  const [spend, setSpend] = useState<number | null>(null);
  const [preparing, setPreparing] = useState<Preparing[]>([]);
  const [last, setLast] = useState<LastAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [sl, runs, month, prep] = await Promise.all([api.getShortlist(), api.listRuns(), api.monthSpend(), api.preparing()]);
    setList(sl);
    setRunning(runs.running);
    setProgress(runs.progress);
    setLastRun(runs.runs[0] ?? null);
    setSpend(month.costUsd);
    setPreparing(prep);
    return runs.running;
  }, []);

  const loadPreparing = useCallback(async () => setPreparing(await api.preparing()), []);

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

  // While applications are being prepared, check until they finish.
  const inFlight = preparing.some((p) => !p.error);
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => {
      loadPreparing().then(onJobsChanged, () => {});
    }, 4000);
    return () => clearInterval(t);
  }, [inFlight, loadPreparing, onJobsChanged]);

  // The deck: undecided jobs only, Tier A first (the server already orders them).
  const deck = list?.entries.filter((e) => e.job.status === "new") ?? [];
  const current = deck[0];

  const decide = useCallback(
    async (kind: "skip" | "accept") => {
      if (!current || busy) return;
      setBusy(true);
      setError(null);
      // Take it off the deck now; the server work happens behind it.
      setList((l) => l && { ...l, entries: l.entries.filter((x) => x.job.id !== current.job.id) });
      try {
        if (kind === "accept") await api.prepareInBackground(current.job.id);
        else await api.updateJob(current.job.id, { status: "dismissed" });
        setLast({ kind, entry: current });
        setList(await api.refillShortlist()); // tops the deck back up
        await loadPreparing();
        onJobsChanged();
      } catch (err) {
        setError((err as Error).message);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [current, busy, load, loadPreparing, onJobsChanged]
  );

  async function undo() {
    if (!last || last.kind !== "skip") return;
    setBusy(true);
    try {
      await api.updateJob(last.entry.job.id, { status: "new" });
      setList(await api.refillShortlist());
      setLast(null);
      onJobsChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Arrow keys: → accept, ← skip (not while typing somewhere).
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const t = ev.target as HTMLElement;
      if (t.closest("input,textarea,select,[contenteditable]")) return;
      if (ev.key === "ArrowRight") decide("accept");
      else if (ev.key === "ArrowLeft") decide("skip");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide]);

  async function runNow() {
    setError(null);
    try {
      await api.runPipeline();
      setRunning(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const tierA = deck.filter((e) => e.job.tier === "A").length;
  const tierB = deck.length - tierA;

  return (
    <section className="max-w-2xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Today's picks</h1>
          <p className="text-ink-soft">
            {deck.length > 0
              ? `${tierA} Tier A and ${tierB} Tier B left. Swipe right or press → to accept, left or ← to skip.`
              : "Your best-fit jobs, one at a time."}
          </p>
        </div>
        {running ? (
          <button
            className="btn-quiet"
            disabled={progress?.stopRequested}
            onClick={async () => {
              await api.stopPipeline();
              setProgress((p) => p && { ...p, stopRequested: true });
            }}
          >
            {progress?.stopRequested ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button className="btn-quiet" onClick={runNow} title="Fetch new postings from your companies and score them">
            Check for new postings
          </button>
        )}
      </header>

      <div className="space-y-1 text-[15px] text-ink-soft" role="status">
        {running && <p className="text-ink">{progressText(progress)}</p>}
        {!running && lastRun && <p>{runSummary(lastRun)}</p>}
        {!running && lastRun?.message && (
          <p className={lastRun.status === "failed" ? "text-fail" : "text-warn"}>{lastRun.message}</p>
        )}
        {spend !== null && <p>AI spend this month: {usd(spend)}</p>}
        {error && <p className="text-fail">{error}</p>}
      </div>

      <PreparingTray items={preparing} onChanged={() => load().catch(() => {})} />

      {last && (
        <p className="flex flex-wrap items-center gap-2 text-[15px] text-ink-soft">
          {last.kind === "skip" ? (
            <>
              Skipped {last.entry.job.title} at {last.entry.job.companyName}.
              <button className="btn-quiet py-1" disabled={busy} onClick={undo}>Undo</button>
            </>
          ) : (
            <>Accepted {last.entry.job.title} at {last.entry.job.companyName}. It's being prepared for Review.</>
          )}
        </p>
      )}

      {list === undefined ? null : current ? (
        <Card key={current.job.id} e={current} position={1} total={deck.length} onDecide={decide} />
      ) : (
        <div className="rounded-lg border border-dashed border-line p-6">
          <p className="font-medium">{list ? "You've gone through every pick" : "No picks yet"}</p>
          <p className="mt-1 text-[15px] text-ink-soft">
            {list
              ? "Nothing scored Tier A or B is left to decide on. New postings come in with the daily run, or press Check for new postings. You can add companies on the Companies page or change how many picks you get in Settings."
              : "The first run happens at your scheduled time, or press Check for new postings."}
          </p>
        </div>
      )}
    </section>
  );
}
