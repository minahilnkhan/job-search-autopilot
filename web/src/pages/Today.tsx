import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineProgress, PipelineRun, Shortlist, ShortlistEntry } from "../../../shared/types";
import { api, usd } from "../lib/api";
import { ScoreBadge, ScoreBreakdownView } from "../components/Score";
import type { DaySummary } from "../lib/api";
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
function Card({ e, onDecide, busy }: { e: ShortlistEntry; onDecide: (kind: "skip" | "accept") => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const { job } = e;
  const b = job.scoreBreakdown;
  const checks = job.filterReasons.filter((r) => r.severity === "warn" && !["everify_unknown", "no_sponsorship"].includes(r.code));
  const posted = job.postedAt ? new Date(`${job.postedAt}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : null;

  function down(ev: React.PointerEvent) {
    if ((ev.target as HTMLElement).closest("a,button")) return;
    start.current = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }
  function move(ev: React.PointerEvent) {
    if (start.current) setDx(ev.clientX - start.current.x);
  }
  function up() {
    if (!start.current) return;
    start.current = null;
    if (dx > SWIPE_DISTANCE) onDecide("accept");
    else if (dx < -SWIPE_DISTANCE) onDecide("skip");
    setDx(0);
  }
  const hint = dx > 40 ? "accept" : dx < -40 ? "skip" : null;
  const good = (t: string) => <span key={t} className="chip bg-pass-bg text-pass">{t}</span>;
  const check = (t: string) => <span key={t} className="chip bg-warn-bg text-warn">{t}</span>;

  return (
    <article
      aria-label={`${job.title} at ${job.companyName}`}
      className="relative touch-pan-y space-y-4 rounded-xl border border-line p-6 select-none"
      style={{ transform: dx ? `translateX(${dx}px) rotate(${dx / 40}deg)` : undefined, transition: start.current ? "none" : "transform 160ms ease-out", background: "white" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        start.current = null;
        setDx(0);
      }}
    >
      {hint && (
        <span className={`absolute top-4 rounded-full border-2 px-3 py-0.5 text-sm font-bold tracking-wide uppercase ${hint === "accept" ? "left-4 border-accent text-accent" : "right-4 border-fail text-fail"}`}>
          {hint === "accept" ? "Accept" : "Skip"}
        </span>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[22px] leading-tight font-semibold">{job.title}</h3>
          <p className="mt-1">
            {job.companyName}
            {e.warmContact && <span className="text-accent"> · warm contact</span>}
            {" · "}
            {[job.location ?? "Location not stated", posted && `posted ${posted}`].filter(Boolean).join(" · ")}
          </p>
        </div>
        <ScoreBadge score={job.fitScore} tier={job.tier} />
      </div>
      {b && <p className="text-ink">{b.whyFits}</p>}
      <div className="flex flex-wrap gap-2">
        {job.sponsorshipStated === "yes" && good("Sponsors visas")}
        {job.sponsorshipStated === "no" && check("No sponsorship")}
        {e.eVerify === "confirmed" && good("E-Verify confirmed")}
        {e.eVerify === "likely" && good("E-Verify likely")}
        {e.eVerify === "unknown" && check("E-Verify not checked")}
        {b?.gaps.slice(0, 2).map((g) => check(`Gap: ${g}`))}
        {checks.map((r) => check(r.message))}
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button className="btn-quiet" disabled={busy} onClick={() => onDecide("skip")}>← Skip</button>
        <button className="btn-primary" disabled={busy} onClick={() => onDecide("accept")}>Accept and prepare →</button>
        {b && (
          <button className="link text-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide score" : "Why this score"}
          </button>
        )}
        {job.url && <a className="link text-sm" href={job.url} target="_blank" rel="noreferrer">Posting</a>}
      </div>
      {open && b && (
        <div className="border-t border-line pt-4">
          <ScoreBreakdownView b={b} redFlags={job.redFlags} />
        </div>
      )}
    </article>
  );
}

function StepNumber({ n, state }: { n: number; state: "current" | "next" | "later" | "done" }) {
  const style =
    state === "current" ? "bg-accent text-white" : state === "done" ? "bg-pass-bg text-pass" : state === "next" ? "border-2 border-accent text-accent" : "border-2 border-line-strong text-muted";
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${style}`} aria-hidden>
      {state === "done" ? "✓" : n}
    </span>
  );
}

/** A collapsed step: one line, a count, one button. */
function Step({ n, state, title, detail, action }: { n: number; state: "next" | "later" | "done"; title: string; detail: string; action?: React.ReactNode }) {
  return (
    <li className="panel flex flex-wrap items-center gap-4 px-7 py-5">
      <StepNumber n={n} state={state} />
      <div className="min-w-[220px] flex-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted">{detail}</p>
      </div>
      {action}
    </li>
  );
}

export function Today({ onJobsChanged }: { onJobsChanged: () => void }) {
  const [list, setList] = useState<Shortlist | null | undefined>(undefined);
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [lastRun, setLastRun] = useState<PipelineRun | null>(null);
  const [preparing, setPreparing] = useState<Preparing[]>([]);
  const [last, setLast] = useState<LastAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [sl, runs, prep, sum] = await Promise.all([api.getShortlist(), api.listRuns(), api.preparing(), api.summary()]);
    setList(sl);
    setRunning(runs.running);
    setProgress(runs.progress);
    setLastRun(runs.runs[0] ?? null);
    setPreparing(prep);
    setSummary(sum);
    return runs.running;
  }, []);
  const refreshSide = useCallback(async () => {
    const [prep, sum] = await Promise.all([api.preparing(), api.summary()]);
    setPreparing(prep);
    setSummary(sum);
  }, []);

  useEffect(() => {
    load().catch((err) => setError((err as Error).message));
  }, [load]);

  // While a run is going, check every few seconds and refresh when it ends.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      if (!(await load())) onJobsChanged();
    }, 3000);
    return () => clearInterval(t);
  }, [running, load, onJobsChanged]);

  // While applications are being prepared, keep step 2's count current.
  const inFlight = preparing.some((p) => !p.error);
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => refreshSide().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [inFlight, refreshSide]);

  const deck = list?.entries.filter((e) => e.job.status === "new") ?? [];
  const current = deck[0];

  const decide = useCallback(
    async (kind: "skip" | "accept") => {
      if (!current || busy) return;
      setBusy(true);
      setError(null);
      setList((l) => l && { ...l, entries: l.entries.filter((x) => x.job.id !== current.job.id) });
      try {
        if (kind === "accept") await api.prepareInBackground(current.job.id);
        else await api.updateJob(current.job.id, { status: "dismissed" });
        setLast({ kind, entry: current });
        setList(await api.refillShortlist());
        await refreshSide();
        onJobsChanged();
      } catch (err) {
        setError((err as Error).message);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [current, busy, load, refreshSide, onJobsChanged]
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

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if ((ev.target as HTMLElement).closest("input,textarea,select,[contenteditable]")) return;
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

  const s = summary;
  const tierA = deck.filter((e) => e.job.tier === "A").length;
  const pickDone = list !== undefined && deck.length === 0;
  const preparingNow = preparing.filter((p) => !p.error).length;
  const dateLabel = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  const todayPct = s ? Math.min(100, Math.round((s.today.submitted / Math.max(1, s.today.target)) * 100)) : 0;
  // Which collapsed step is "next": the first one with something waiting.
  const nextStep = !s ? 0 : s.review + s.blocked > 0 ? 2 : s.approved > 0 ? 3 : s.followUps.due > 0 ? 4 : 0;
  const stepState = (n: number, waiting: number): "next" | "later" | "done" => (waiting === 0 ? "done" : n === nextStep && pickDone ? "next" : "later");

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="eyebrow">{dateLabel}</p>
          <h1 className="mt-1.5 text-[40px] leading-tight font-semibold tracking-tight">
            {s ? `${s.today.submitted} of ${s.today.target} applications today` : "Today"}
          </h1>
          <p className="mt-2 text-[17px]">Four steps. Work top to bottom; each one tells you when it's done.</p>
        </div>
        {s && (
          <div className="min-w-[260px] space-y-2">
            <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={todayPct} aria-valuemin={0} aria-valuemax={100} aria-label="Today's applications">
              <div className="h-2 rounded-full bg-accent" style={{ width: `${todayPct}%` }} />
            </div>
            <p className="text-sm text-muted">Week: {s.week.submitted} of {s.week.target} applications</p>
          </div>
        )}
      </section>

      {error && <p className="rounded-xl bg-fail-bg px-4 py-3 text-fail" role="alert">{error}</p>}

      <section className="flex flex-wrap items-start gap-6">
        <ol className="flex min-w-0 flex-[999_1_640px] flex-col gap-3">
          {/* Step 1: the deck, open until it's empty. */}
          {!pickDone ? (
            <li className="panel-raised space-y-5 p-7">
              <div className="flex items-center gap-3.5">
                <StepNumber n={1} state="current" />
                <div className="flex-1">
                  <h2 className="text-xl font-semibold">Pick today's jobs</h2>
                  <p className="text-sm text-muted">
                    {deck.length} left{tierA ? ` · ${tierA} Tier A first` : ""} · swipe or use ← →
                  </p>
                </div>
              </div>
              {last && (
                <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                  {last.kind === "skip" ? (
                    <>
                      Skipped {last.entry.job.title} at {last.entry.job.companyName}.
                      <button className="link" disabled={busy} onClick={undo}>Undo</button>
                    </>
                  ) : (
                    <>Accepted {last.entry.job.title} at {last.entry.job.companyName}. It's being prepared for review.</>
                  )}
                </p>
              )}
              {current ? <Card key={current.job.id} e={current} onDecide={decide} busy={busy} /> : <p className="text-muted">Loading…</p>}
            </li>
          ) : (
            <Step
              n={1}
              state="done"
              title="Pick today's jobs"
              detail={list ? "Done. New postings arrive with the daily check." : "No picks yet. The first check runs at your scheduled time."}
              action={!running && <button className="btn-quiet" onClick={runNow}>Check for new postings</button>}
            />
          )}

          <Step
            n={2}
            state={stepState(2, (s?.review ?? 0) + (s?.blocked ?? 0) + preparingNow)}
            title="Review and approve"
            detail={
              s
                ? [`${s.review} ready`, s.blocked && `${s.blocked} need${s.blocked === 1 ? "s" : ""} a fix`, preparingNow && `${preparingNow} still preparing`].filter(Boolean).join(" · ")
                : "…"
            }
            action={
              s && s.review + s.blocked > 0 ? (
                <a className={nextStep === 2 && pickDone ? "btn-dark" : "btn-quiet"} href={`#/applications?stage=${s.review ? "review" : "blocked"}`}>Start reviewing →</a>
              ) : undefined
            }
          />
          <Step
            n={3}
            state={stepState(3, s?.approved ?? 0)}
            title="Submit"
            detail={s ? (s.approved ? `${s.approved} approved · open each in Chrome and press Fill` : "Nothing approved yet") : "…"}
            action={s && s.approved > 0 ? <a className={nextStep === 3 && pickDone ? "btn-dark" : "btn-quiet"} href="#/applications?stage=approved">Open the next one →</a> : undefined}
          />
          <Step
            n={4}
            state={stepState(4, s?.followUps.due ?? 0)}
            title="Follow up"
            detail={s ? (s.followUps.next ? `${s.followUps.due} due · ${s.followUps.next.companyName}, ${s.followUps.next.jobTitle}` : "Nothing due") : "…"}
            action={s && s.followUps.due > 0 ? <a className={nextStep === 4 && pickDone ? "btn-dark" : "btn-quiet"} href="#/applications?stage=submitted">See follow-ups →</a> : undefined}
          />
          <PreparingTray items={preparing.filter((p) => p.error)} onChanged={() => load().catch(() => {})} />
        </ol>

        <aside className="flex flex-[1_1_280px] flex-col gap-3">
          <div className="space-y-2.5 rounded-2xl bg-dark p-6 text-[#C9D8D2]">
            <p className="text-[13px] font-semibold tracking-wider text-[#8FD9C8] uppercase">New postings</p>
            {running ? (
              <>
                <p className="text-lg font-semibold text-white">Checking now</p>
                <p className="text-sm">{progressText(progress)}</p>
                <button
                  className="rounded-full border border-white/25 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={progress?.stopRequested}
                  onClick={async () => {
                    await api.stopPipeline();
                    setProgress((p) => p && { ...p, stopRequested: true });
                  }}
                >
                  {progress?.stopRequested ? "Stopping…" : "Stop"}
                </button>
              </>
            ) : (
              <>
                <p className="text-lg font-semibold text-white">
                  {lastRun ? `Checked ${new Date(lastRun.finishedAt ?? lastRun.startedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Not checked yet"}
                </p>
                {lastRun && <p className="text-sm">{runSummary(lastRun).replace(/^Last run [^:]+: /, "")}</p>}
                {lastRun?.message && <p className="text-sm text-[#FBD38D]">{lastRun.message}</p>}
                <button className="rounded-full border border-white/25 px-4 py-2 text-sm font-semibold text-white" onClick={runNow}>Check now</button>
              </>
            )}
          </div>
          {s && (
            <div className="panel space-y-3 p-6">
              <p className="text-[13px] font-semibold tracking-wider text-muted uppercase">Pipeline</p>
              <div className="grid grid-cols-2 gap-4">
                {(
                  [
                    ["submitted", s.pipeline.submitted + s.pipeline.screen + s.pipeline.interview + s.pipeline.offer],
                    ["recruiter screens", s.pipeline.screen],
                    ["interviewing", s.pipeline.interview],
                    ["offers", s.pipeline.offer],
                  ] as const
                ).map(([label, n]) => (
                  <div key={label}>
                    <p className="text-[28px] leading-tight font-semibold text-ink">{n}</p>
                    <p className="text-[13px]">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </section>
    </div>
  );
}
