import { useEffect, useRef, useState } from "react";
import type { CapWarning, ProjectRecord, RunningTimer, Task, WeekHours } from "../../../shared/types";
import { api, BUCKET_LABEL, type Bucket } from "../lib/api";

// The week's hours, the to-do list and the timer. Shared by Today (the day's
// three priorities) and Progress (the whole week).

const BUCKETS: Bucket[] = ["applications", "projects", "prep"];
const BAR = { applications: "bg-accent", projects: "bg-dark", prep: "bg-[#8FD9C8]" } as const;

export const hhmm = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;

/** Hours by bucket against their targets, as one bar per bucket. */
export function HoursBar({ week }: { week: WeekHours }) {
  const widest = Math.max(week.cap, week.total, 1);
  return (
    <div className="space-y-3">
      {week.buckets.map((b) => (
        <div key={b.bucket}>
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-ink">{BUCKET_LABEL[b.bucket]}</span>
            <span className="text-muted">
              {b.hours}
              <span className="text-[#8A9A93]"> / {b.target}h</span>
            </span>
          </div>
          <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-line">
            <div className={`h-full rounded-full ${BAR[b.bucket]}`} style={{ width: `${Math.min(100, (b.hours / widest) * 100)}%` }} />
            <div className="relative -mt-2.5 h-2.5" style={{ marginLeft: `${Math.min(100, (b.target / widest) * 100)}%` }}>
              <div className="h-2.5 w-px bg-line-strong" title={`Target ${b.target}h`} />
            </div>
          </div>
        </div>
      ))}
      <p className="text-[13px] text-muted">
        {week.coreHours} of your {week.cap}-hour cap
        {week.projectOverflow > 0 && <> · {week.projectOverflow}h extra on the project, which you approved</>}
      </p>
    </div>
  );
}

/** One click to start the clock on a bucket; stop it, or say what you really worked if it ran all night. */
export function Timer({ running, onChanged }: { running: RunningTimer | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirmMinutes, setConfirmMinutes] = useState("60");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [running]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  // Counted from the start time so it keeps up between polls; `tick` re-renders it every half minute.
  void tick;
  const elapsed = running ? Math.max(0, Math.floor((Date.now() - running.startedAt) / 60_000)) : 0;

  if (running?.needsConfirm) {
    return (
      <div className="space-y-2 rounded-xl border border-line bg-warn-bg/40 p-4">
        <p className="text-sm text-ink">
          The {BUCKET_LABEL[running.bucket].toLowerCase()} timer has been running {hhmm(elapsed)}. How long did you actually work?
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input className="field w-24 text-sm" value={confirmMinutes} onChange={(e) => setConfirmMinutes(e.target.value.replace(/\D/g, ""))} aria-label="Minutes worked" />
          <span className="text-sm text-muted">minutes</span>
          <button className="btn-primary py-1.5 text-sm" disabled={busy || !confirmMinutes} onClick={() => act(() => api.stopTimer(running.id, Number(confirmMinutes)))}>
            Log it
          </button>
          <button className="link text-sm" disabled={busy} onClick={() => act(() => api.discardTimer(running.id))}>
            I wasn't working
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {running ? (
        <>
          <span className="chip bg-accent-bg text-accent-ink">
            {BUCKET_LABEL[running.bucket]} · {hhmm(elapsed)}
          </span>
          <button className="btn-quiet py-1.5 text-sm" disabled={busy} onClick={() => act(() => api.stopTimer(running.id))}>
            Stop
          </button>
        </>
      ) : (
        <>
          <span className="text-[13px] text-muted">Start the clock:</span>
          {BUCKETS.map((b) => (
            <button key={b} className="btn-quiet py-1.5 text-sm" disabled={busy} onClick={() => act(() => api.startTimer(b))}>
              {BUCKET_LABEL[b]}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

/** The to-do list. Mentor tasks come from the check-in; you can add your own. */
export function TaskList({ tasks, onChanged, limit, showAdd = true }: { tasks: Task[]; onChanged: () => void; limit?: number; showAdd?: boolean }) {
  const [title, setTitle] = useState("");
  const [bucket, setBucket] = useState<Bucket>("applications");
  const [minutes, setMinutes] = useState("60");
  const [warning, setWarning] = useState<CapWarning | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = limit ? tasks.slice(0, limit) : tasks;

  async function add(acceptOverCap: boolean) {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const r = await api.createTask({ title, bucket, estimateMinutes: Number(minutes) || null, dueDate: new Date().toLocaleDateString("en-CA"), acceptOverCap });
      if (r.warning) setWarning(r.warning);
      else {
        setTitle("");
        setWarning(null);
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {shown.length === 0 && <p className="text-sm text-muted">Nothing on the list.</p>}
      <ul className="space-y-2">
        {shown.map((t) => (
          <li key={t.id} className="flex items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-1 size-4 accent-[#0e7c6b]"
              checked={t.status === "done"}
              aria-label={t.title}
              onChange={async (e) => {
                await api.updateTask(t.id, { status: e.target.checked ? "done" : "todo" });
                onChanged();
              }}
            />
            <div className="min-w-0 flex-1">
              <p className={`text-[15px] ${t.status === "done" ? "text-muted line-through" : "text-ink"}`}>{t.title}</p>
              <p className="text-[13px] text-muted">
                {t.bucket ? BUCKET_LABEL[t.bucket] : "No bucket"}
                {t.estimateMinutes ? ` · ${hhmm(t.estimateMinutes)}` : ""}
                {t.source === "mentor" ? " · from your check-in" : ""}
                {t.overdue ? " · overdue" : ""}
              </p>
            </div>
            <button
              className="link text-[13px] text-muted"
              onClick={async () => {
                await api.deleteTask(t.id);
                onChanged();
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      {showAdd && (
        <div className="space-y-2 border-t border-line pt-3">
          <div className="flex flex-wrap gap-2">
            <input className="field min-w-40 flex-1 text-sm" placeholder="Add something to today" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New task" />
            <select className="field w-auto text-sm" value={bucket} onChange={(e) => setBucket(e.target.value as Bucket)} aria-label="Bucket">
              {BUCKETS.map((b) => (
                <option key={b} value={b}>
                  {BUCKET_LABEL[b]}
                </option>
              ))}
            </select>
            <input className="field w-20 text-sm" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))} aria-label="Estimated minutes" />
            <button className="btn-quiet py-1.5 text-sm" disabled={busy || !title.trim()} onClick={() => add(false)}>
              Add
            </button>
          </div>
          {warning && (
            <div className="space-y-2 rounded-lg border border-line bg-warn-bg/40 p-3 text-sm">
              <p className="text-ink">{warning.message}</p>
              <button className="btn-quiet py-1.5 text-sm" disabled={busy} onClick={() => add(true)}>
                Add it anyway
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** This week's project: hours, what it's building, and what it needs before it counts. */
export function ProjectCard({ project, ideas, onChanged }: { project: ProjectRecord | null; ideas: { title: string; oneLine: string; skills: string[]; wildcard: boolean }[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState(project?.repoUrl ?? "");
  const [result, setResult] = useState(project?.resultMetric ?? "");
  const [error, setError] = useState<string | null>(null);
  const lastId = useRef(project?.id);
  if (lastId.current !== project?.id) {
    lastId.current = project?.id;
    setRepo(project?.repoUrl ?? "");
    setResult(project?.resultMetric ?? "");
  }

  if (!project) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">No project started this week.</p>
        {ideas.length > 0 ? (
          <ul className="space-y-2.5">
            {ideas.map((i) => (
              <li key={i.title} className="space-y-1">
                <div className="flex items-baseline gap-2">
                  <p className="font-medium text-ink">{i.title}</p>
                  {i.wildcard && <span className="chip">wildcard</span>}
                </div>
                <p className="text-[13px] text-muted">{i.oneLine}</p>
                <button
                  className="link text-[13px]"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.startProject({ title: i.title, summary: i.oneLine, skills: i.skills });
                      onChanged();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Start this one
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">Run the weekly review for six ideas built around the skills postings keep asking for.</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-[17px] font-medium text-ink">{project.title}</p>
        {project.summary && <p className="text-[13px] text-muted">{project.summary}</p>}
      </div>
      <p className="text-sm text-muted">
        {project.hoursLogged}h logged this week{project.skills.length > 0 && <> · building {project.skills.join(", ")}</>}
      </p>
      {project.status === "shipped" ? (
        <p className="text-sm text-pass">Shipped · {project.resultMetric}</p>
      ) : (
        <div className="space-y-2 border-t border-line pt-3">
          <p className="text-[13px] text-muted">It counts once it's on GitHub with one measured result.</p>
          <input className="field text-sm" placeholder="github.com/mkhan2025/…" value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Repo URL" />
          <input className="field text-sm" placeholder="The one result you measured" value={result} onChange={(e) => setResult(e.target.value)} aria-label="Measured result" />
          {error && <p className="text-[13px] text-fail">{error}</p>}
          <div className="flex gap-2">
            <button
              className="btn-quiet py-1.5 text-sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await api.updateProject(project.id, { repoUrl: repo || null, resultMetric: result || null });
                  onChanged();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save
            </button>
            <button
              className="btn-primary py-1.5 text-sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await api.updateProject(project.id, { repoUrl: repo || null, resultMetric: result || null, status: "shipped" });
                  onChanged();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Mark it shipped
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
