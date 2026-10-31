import { useCallback, useEffect, useState } from "react";
import type { CheckInRecord, ProjectRecord, RunningTimer, Task, TrackerState, WeeklyReviewOutput } from "../../../shared/types";
import { api, usd } from "../lib/api";
import { HoursBar, ProjectCard, TaskList, Timer } from "../components/Tracking";

// The week, in numbers: what the targets say, what actually happened, and what
// the mentor made of it. Every figure here comes from the same tracker state
// the mentor is given, so the screen and the check-in can't disagree.

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "pass" | "warn" }) {
  return (
    <div>
      <p className={`text-[30px] leading-tight font-semibold ${tone === "pass" ? "text-pass" : tone === "warn" ? "text-warn" : "text-ink"}`}>{value}</p>
      <p className="text-[13px] text-muted">{label}</p>
      {sub && <p className="text-[13px] text-[#8A9A93]">{sub}</p>}
    </div>
  );
}

/** Submitted → screen → interview → offer, as bars you can compare at a glance. */
function Funnel({ t }: { t: TrackerState }) {
  const p = t.pipeline;
  const total = p.submitted + p.screen + p.interview + p.offer + p.rejected + p.ghosted;
  const rows = [
    { label: "Submitted", n: total },
    { label: "Screens", n: p.screen + p.interview + p.offer },
    { label: "Interviews", n: p.interview + p.offer },
    { label: "Offers", n: p.offer },
  ];
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <span className="w-24 shrink-0 text-[13px] text-muted">{r.label}</span>
          <div className="h-6 flex-1 overflow-hidden rounded bg-line">
            <div className="h-full rounded bg-accent" style={{ width: total ? `${Math.max(2, (r.n / total) * 100)}%` : "0%" }} />
          </div>
          <span className="w-8 shrink-0 text-right text-[15px] font-medium text-ink">{r.n}</span>
        </div>
      ))}
      {total === 0 && <p className="text-[13px] text-muted">Nothing submitted yet.</p>}
    </div>
  );
}

const rate = (r: { applications: number; responses: number; rate: number | null }) =>
  r.applications === 0 ? "—" : `${r.rate}% (${r.responses}/${r.applications})`;

/** Free-form mentor chat: strategy questions and mock interviews. It changes nothing. */
function MentorChat() {
  const [thread, setThread] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    setError(null);
    setThread((t) => [...t, { role: "user", text: message }]);
    setBusy(true);
    try {
      const r = await api.mentorChat(message, thread);
      setThread((t) => [...t, { role: "assistant", text: r.reply }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel space-y-3 p-6">
      <h2 className="text-lg font-semibold">Ask your mentor</h2>
      <p className="text-[13px] text-muted">Strategy, a mock interview, what to say about the visa. It has this week's numbers. To change a resume, use the chat on that application.</p>
      {thread.length > 0 && (
        <div className="max-h-96 space-y-3 overflow-y-auto border-t border-line pt-3">
          {thread.map((m, i) => (
            <div key={i} className={m.role === "user" ? "text-right" : ""}>
              <p className={`inline-block max-w-[85%] rounded-xl px-3.5 py-2 text-left text-[15px] whitespace-pre-wrap ${m.role === "user" ? "bg-accent-bg text-accent-ink" : "bg-paper text-ink"}`}>{m.text}</p>
            </div>
          ))}
          {busy && <p className="text-sm text-muted">Thinking…</p>}
        </div>
      )}
      {error && <p className="text-sm text-fail">{error}</p>}
      <div className="flex gap-2">
        <textarea
          className="field flex-1 text-sm"
          rows={2}
          placeholder="Ask anything about the search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          aria-label="Message your mentor"
        />
        <button className="btn-primary self-end py-2 text-sm" disabled={busy || !draft.trim()} onClick={() => void send()}>
          Send
        </button>
      </div>
    </section>
  );
}

export function Progress() {
  const [t, setT] = useState<TrackerState | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [running, setRunning] = useState<RunningTimer | null>(null);
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [weekly, setWeekly] = useState<CheckInRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [state, tk, time, pr, ci] = await Promise.all([api.trackerState(), api.tasks(), api.time(), api.projects(), api.checkIns()]);
    setT(state);
    setTasks(tk.tasks);
    setRunning(time.running);
    setProject(pr.current);
    setWeekly(ci.weekly);
  }, []);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
    const poll = setInterval(() => void load().catch(() => {}), 15_000);
    return () => clearInterval(poll);
  }, [load]);

  if (!t) return <p className="text-ink-soft">{error ?? "Loading…"}</p>;
  const review = weekly?.output as WeeklyReviewOutput | undefined;
  const behind = t.week.submitted.total < Math.round((t.targets.appsPerWeek / 7) * 3);

  return (
    <div className="space-y-6">
      <section>
        <p className="eyebrow">Week of {t.weekStart}</p>
        <h1 className="mt-1.5 text-[34px] leading-tight font-semibold tracking-tight">Progress</h1>
      </section>

      <section className="panel grid grid-cols-2 gap-6 p-6 md:grid-cols-4">
        <Stat label={`applications today (of ${t.targets.appsPerDay})`} value={`${t.today.submitted.total}`} sub={`A ${t.today.submitted.tierA} · B ${t.today.submitted.tierB}`} />
        <Stat label={`this week (of ${t.targets.appsPerWeek})`} value={`${t.week.submitted.total}`} sub={`last week ${t.lastWeek.submitted.total}`} tone={behind ? "warn" : undefined} />
        <Stat label="day streak at target" value={`${t.streak}`} sub={`cap review in ${t.daysToCapReview} days`} />
        <Stat label="AI spend this month" value={usd(t.spendThisMonth)} />
      </section>

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_420px] flex-col gap-6">
          <section className="panel space-y-4 p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">Hours this week</h2>
              <Timer running={running} onChanged={() => void load()} />
            </div>
            <HoursBar week={t.week.hours} />
          </section>

          <section className="panel space-y-4 p-6">
            <h2 className="text-lg font-semibold">Pipeline</h2>
            <Funnel t={t} />
            <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
              <Stat label="response rate, all" value={rate(t.responseRate.overall)} />
              <Stat label="Tier A" value={rate(t.responseRate.tierA)} />
              <Stat label="Tier B" value={rate(t.responseRate.tierB)} />
            </div>
            {t.responseRate.byRoleType.length > 1 && (
              <div className="border-t border-line pt-3">
                <p className="mb-1.5 text-[13px] font-semibold tracking-wider text-muted uppercase">By role type</p>
                <ul className="space-y-1 text-sm">
                  {t.responseRate.byRoleType.map((r) => (
                    <li key={r.type} className="flex items-baseline justify-between gap-3">
                      <span className="text-ink">{r.type}</span>
                      <span className="text-muted">
                        {rate(r)} <span className="text-[#8A9A93]">· {r.applications} sent</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {t.responseRate.overall.applications < 40 && <p className="mt-2 text-[13px] text-muted">Too early to narrow; the review looks at this around 40 applications.</p>}
              </div>
            )}
          </section>

          <MentorChat />

          <section className="panel space-y-4 p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">Sunday review</h2>
              <button
                className="link text-sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await api.runCheckIn("weekly");
                    await load();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Writing…" : review ? "Run it again" : "Run the review"}
              </button>
            </div>
            {error && <p className="text-sm text-fail">{error}</p>}
            {review ? (
              <div className="space-y-3 text-[15px]">
                <p className="text-ink">{review.diagnosis}</p>
                <p className="text-muted">
                  This week: {review.targets.applications} applications, {review.targets.projectHours}h project, {review.targets.prepHours}h prep. {review.targets.note}
                </p>
                <p className="text-muted">
                  <span className="font-medium text-ink">Prep focus:</span> {review.prepFocus}
                </p>
                <p className="text-muted">
                  <span className="font-medium text-ink">GitHub:</span> {review.githubTask}
                </p>
                <p className="text-[13px] text-[#8A9A93]">From {weekly!.date}</p>
              </div>
            ) : (
              <p className="text-sm text-muted">No review yet. It runs on Sundays with the daily check-in, or press the button.</p>
            )}
          </section>
        </div>

        <aside className="flex flex-[1_1_320px] flex-col gap-6">
          <section className="panel space-y-3 p-6">
            <h2 className="text-lg font-semibold">This week's project</h2>
            <ProjectCard project={project} ideas={review?.projectIdeas ?? []} onChanged={() => void load()} />
          </section>

          <section className="panel space-y-3 p-6">
            <h2 className="text-lg font-semibold">Everything on the list</h2>
            <TaskList tasks={tasks} onChanged={() => void load()} />
          </section>

          {t.skillsToBuild.length > 0 && (
            <section className="panel space-y-2 p-6">
              <p className="text-[13px] font-semibold tracking-wider text-muted uppercase">Skills to build</p>
              <ul className="space-y-1 text-sm">
                {t.skillsToBuild.map((k) => (
                  <li key={k.skill} className="flex items-baseline justify-between gap-2">
                    <span className="text-ink">{k.skill}</span>
                    <span className="text-muted">
                      {k.postings} posting{k.postings === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
