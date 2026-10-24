import { useCallback, useEffect, useState } from "react";
import type { ApplicationStatus, TrackedApplication } from "../../../shared/types";
import { api, type TrackStatus } from "../lib/api";

const LABEL: Record<ApplicationStatus, string> = {
  draft: "Draft",
  ready_for_review: "In review",
  approved: "Approved",
  submitted: "Submitted",
  screen: "Recruiter screen",
  interview: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  ghosted: "Ghosted",
  withdrawn: "Withdrawn",
};
// Same rules as the server (domain/applicationStatus.ts).
const NEXT: Partial<Record<ApplicationStatus, TrackStatus[]>> = {
  submitted: ["screen", "interview", "rejected", "ghosted", "withdrawn"],
  screen: ["interview", "offer", "rejected", "ghosted", "withdrawn"],
  interview: ["offer", "rejected", "ghosted", "withdrawn"],
  offer: ["withdrawn"],
  ghosted: ["screen", "interview", "rejected"],
};
const ACTIVE: ApplicationStatus[] = ["submitted", "screen", "interview", "offer"];
const DAY = 86_400_000;

const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" }) : "");
const today = () => new Date().toLocaleDateString("en-CA");

export function Tracker() {
  const [rows, setRows] = useState<TrackedApplication[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.tracker().then(setRows).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!rows) return <p className="text-ink-soft">{error ?? "Loading…"}</p>;
  const dueNow = rows.filter((r) => r.followUpDue && r.followUpDue <= today());
  const active = rows.filter((r) => ACTIVE.includes(r.status));
  const closed = rows.filter((r) => !ACTIVE.includes(r.status));
  const counts = ACTIVE.map((s) => [s, rows.filter((r) => r.status === s).length] as const);

  const Row = ({ r }: { r: TrackedApplication }) => {
    const quiet = r.status === "submitted" && r.submittedAt && Date.now() - r.submittedAt > 30 * DAY;
    return (
      <li className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0 space-y-0.5">
          <p className="font-semibold">
            <a className="hover:underline" href={`#/review?id=${r.id}`}>{r.jobTitle}</a>
          </p>
          <p className="text-sm text-ink-soft">
            {r.companyName}
            {r.tier ? ` · Tier ${r.tier}` : ""} · submitted {fmt(r.submittedAt)}
            {r.followUpDue && ` · follow up ${new Date(`${r.followUpDue}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })}`}
          </p>
          {quiet && <p className="text-sm text-warn">No reply in 30 days. Mark it ghosted?</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {r.followUpDue && r.followUpDue <= today() && (
            <>
              <button className="btn-quiet py-1" onClick={() => act(() => api.followUp(r.id, "done"))}>Followed up</button>
              <button className="btn-quiet py-1" onClick={() => act(() => api.followUp(r.id, "later"))}>In 3 days</button>
            </>
          )}
          <span className="rounded-md bg-paper px-2 py-1 text-sm font-medium">{LABEL[r.status]}</span>
          {NEXT[r.status] && (
            <select aria-label={`Change status of ${r.jobTitle}`} className="field w-auto py-1" value=""
              onChange={(e) => e.target.value && act(() => api.setStatus(r.id, e.target.value as TrackStatus))}>
              <option value="">Move to…</option>
              {NEXT[r.status]!.map((s) => (
                <option key={s} value={s}>{LABEL[s]}</option>
              ))}
            </select>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="max-w-4xl space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Tracker</h1>
        <p className="text-ink-soft">Every application you've submitted. Move each one along as you hear back.</p>
      </header>
      <dl className="flex flex-wrap gap-6">
        {counts.map(([s, n]) => (
          <div key={s}>
            <dt className="text-sm text-ink-soft">{LABEL[s]}</dt>
            <dd className="text-2xl font-bold tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>
      {error && <p className="text-[15px] text-fail" role="alert">{error}</p>}
      {dueNow.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Follow-ups due ({dueNow.length})</h2>
          <p className="text-[15px] text-ink-soft">Tier A applications a week after submitting. A short note to the recruiter or hiring manager is enough.</p>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-6 text-[15px] text-ink-soft">
          Nothing submitted yet. Approve an application in Review, then press Open and prefill.
        </div>
      ) : (
        <>
          <ul className="space-y-2">{[...active].sort((a, b) => (a.followUpDue ?? "9").localeCompare(b.followUpDue ?? "9")).map((r) => <Row key={r.id} r={r} />)}</ul>
          {closed.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[15px] font-medium text-ink-soft">Closed ({closed.length})</summary>
              <ul className="mt-2 space-y-2">{closed.map((r) => <Row key={r.id} r={r} />)}</ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
