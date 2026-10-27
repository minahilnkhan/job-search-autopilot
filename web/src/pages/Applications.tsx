import { useCallback, useEffect, useState } from "react";
import type { ApplicationStatus, ApplicationSummary, TrackedApplication } from "../../../shared/types";
import { api, type TrackStatus } from "../lib/api";
import { PreparingTray, type Preparing } from "../components/PreparingTray";

// Every application in one place, from review to offer (Review and Tracker
// merged). The stage tabs follow the order you work in.

type StageId = "review" | "blocked" | "snoozed" | "approved" | "submitted" | "interviewing" | "closed";
const STAGES: { id: StageId; label: string }[] = [
  { id: "review", label: "To review" },
  { id: "blocked", label: "Needs a fix" },
  { id: "approved", label: "Ready to submit" },
  { id: "submitted", label: "Submitted" },
  { id: "interviewing", label: "Interviewing" },
  { id: "snoozed", label: "Snoozed" },
  { id: "closed", label: "Closed" },
];
const QUEUE: StageId[] = ["review", "blocked", "snoozed", "approved"];

const LABEL: Record<ApplicationStatus, string> = {
  draft: "Needs a fix",
  ready_for_review: "To review",
  approved: "Ready to submit",
  submitted: "Submitted",
  screen: "Recruiter screen",
  interview: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  ghosted: "No reply",
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
const DAY = 86_400_000;
const today = () => new Date().toLocaleDateString("en-CA");
const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" }) : "");
const tierChip = (tier: string | null, score: number | null) =>
  tier ? (
    <span className={`chip shrink-0 font-semibold ${tier === "A" ? "bg-accent-bg text-accent-ink" : "bg-paper text-ink-soft"}`}>
      {tier}{score !== null ? ` · ${score}` : ""}
    </span>
  ) : null;

function inStage(t: TrackedApplication, s: StageId) {
  if (s === "submitted") return t.status === "submitted";
  if (s === "interviewing") return ["screen", "interview", "offer"].includes(t.status);
  if (s === "closed") return ["rejected", "ghosted", "withdrawn"].includes(t.status);
  return false;
}

function FollowUpCard({ t, onDone }: { t: TrackedApplication; onDone: () => void }) {
  const [draft, setDraft] = useState<{ text: string; warning: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const days = t.submittedAt ? Math.round((Date.now() - t.submittedAt) / DAY) : null;
  return (
    <div className="flex flex-[1_1_320px] flex-col gap-2 rounded-2xl bg-warn-bg p-6">
      <p className="text-[13px] font-semibold tracking-wider text-warn uppercase">Follow-up due</p>
      <p className="font-semibold text-ink">{t.companyName} · {t.jobTitle}</p>
      <p className="text-sm text-[#5C3A0A]">Submitted {days !== null ? `${days} days ago` : ""} with no reply. A short note to the recruiter is enough.</p>
      {draft && (
        <div className="space-y-2 rounded-xl bg-surface p-3">
          <p className="text-sm whitespace-pre-wrap text-ink">{draft.text}</p>
          {draft.warning && <p className="text-[13px] text-warn">Check before sending: {draft.warning}</p>}
          <button className="link text-sm" onClick={async () => {
            await navigator.clipboard.writeText(draft.text).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}>{copied ? "Copied" : "Copy"}</button>
        </div>
      )}
      {error && <p className="text-sm text-fail">{error}</p>}
      <div className="flex flex-wrap gap-2.5 pt-1">
        <button className="btn-dark py-2 text-sm" disabled={busy} onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setDraft(await api.draftFollowUp(t.id));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}>{busy ? "Writing…" : draft ? "Write it again" : "Draft a follow-up"}</button>
        <button className="rounded-full border border-[#E8C99A] px-4 py-2 text-sm font-semibold text-[#5C3A0A]" onClick={() => api.followUp(t.id, "done").then(onDone)}>Done</button>
        <button className="rounded-full px-3 py-2 text-sm font-semibold text-[#5C3A0A]" onClick={() => api.followUp(t.id, "later").then(onDone)}>In 3 days</button>
      </div>
    </div>
  );
}

export function Applications({ onCountsChanged }: { onCountsChanged: () => void }) {
  const initial = (new RegExp("[?&]stage=([a-z]+)").exec(location.hash)?.[1] as StageId | undefined) ?? null;
  const [stage, setStage] = useState<StageId | null>(initial);
  const [queues, setQueues] = useState<Record<string, ApplicationSummary[]> | null>(null);
  const [tracked, setTracked] = useState<TrackedApplication[]>([]);
  const [preparing, setPreparing] = useState<Preparing[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [lists, t, prep] = await Promise.all([
      Promise.all((["review", "blocked", "snoozed", "approved"] as const).map(async (v) => [v, await api.applications(v)] as const)),
      api.tracker(),
      api.preparing(),
    ]);
    setQueues(Object.fromEntries(lists));
    setTracked(t);
    setPreparing(prep);
    onCountsChanged();
  }, [onCountsChanged]);
  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  const inFlight = preparing.some((p) => !p.error);
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => load().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [inFlight, load]);

  const count = (s: StageId) => (QUEUE.includes(s) ? (queues?.[s]?.length ?? 0) : tracked.filter((t) => inStage(t, s)).length);
  // Open on the first stage with something in it.
  const active: StageId = stage ?? (queues ? (STAGES.find((s) => count(s.id) > 0)?.id ?? "review") : "review");
  const pick = (s: StageId) => {
    setStage(s);
    history.replaceState(null, "", `#/applications?stage=${s}`);
  };

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const due = tracked.filter((t) => t.followUpDue && t.followUpDue <= today());
  const queueRows = QUEUE.includes(active) ? (queues?.[active] ?? []) : [];
  const trackRows = QUEUE.includes(active) ? [] : tracked.filter((t) => inStage(t, active));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[34px] leading-tight font-semibold tracking-tight">Applications</h1>
        <p className="mt-1.5 text-[17px]">Every application in one place, from review to offer.</p>
      </div>

      <nav aria-label="Stage" className="flex flex-wrap gap-2">
        {STAGES.filter((s) => s.id !== "snoozed" || count("snoozed") > 0).map((s) => (
          <button key={s.id} onClick={() => pick(s.id)} aria-pressed={active === s.id}
            className={`rounded-full px-4 py-2 text-sm ${active === s.id ? "bg-dark font-semibold text-white" : "border border-line bg-surface font-medium text-ink"} ${s.id === "closed" && active !== s.id ? "border-transparent bg-transparent text-muted" : ""}`}>
            {s.label} {count(s.id) > 0 && <span className="opacity-70">{count(s.id)}</span>}
          </button>
        ))}
      </nav>

      <PreparingTray items={preparing} onChanged={() => load().catch(() => {})} />
      {error && <p className="rounded-xl bg-fail-bg px-4 py-3 text-fail" role="alert">{error}</p>}

      <section className="panel-raised overflow-hidden">
        {queueRows.length + trackRows.length === 0 ? (
          <p className="p-6 text-muted">
            {active === "review" ? "Nothing to review. Accept jobs on Today and they show up here when they're prepared." : "Nothing here."}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {queueRows.map((a, i) => (
              <li key={a.id} className="flex flex-wrap items-center gap-4 px-6 py-4">
                {tierChip(a.tier, a.fitScore)}
                <div className="min-w-[220px] flex-1">
                  <p className="font-semibold text-ink">{a.jobTitle}</p>
                  <p className="text-sm">
                    {a.companyName}
                    {active === "snoozed" && a.snoozedUntil ? ` · until ${a.snoozedUntil}` : ` · prepared ${fmt(a.createdAt)}`}
                  </p>
                </div>
                {active === "blocked" ? (
                  <span className="text-[13px] font-medium text-fail">{a.failCount} to fix</span>
                ) : a.truthOverride ? (
                  <span className="text-[13px] font-medium text-warn">Truth Check overridden</span>
                ) : (
                  <span className="text-[13px] font-medium text-pass">Truth Check passed</span>
                )}
                <a className={i === 0 ? "btn-primary py-2 text-sm" : "btn-quiet py-2 text-sm"} href={`#/review?id=${a.id}&stage=${active}`}>
                  {active === "approved" ? "Submit →" : active === "blocked" ? "Fix →" : "Review →"}
                </a>
              </li>
            ))}
            {trackRows.map((t) => {
              const quiet = t.status === "submitted" && t.submittedAt && Date.now() - t.submittedAt > 30 * DAY;
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-4 px-6 py-4">
                  {tierChip(t.tier, t.fitScore)}
                  <div className="min-w-[220px] flex-1">
                    <a className="font-semibold text-ink hover:underline" href={`#/review?id=${t.id}`}>{t.jobTitle}</a>
                    <p className="text-sm">
                      {t.companyName} · submitted {fmt(t.submittedAt)}
                      {t.followUpDue && ` · follow up ${new Date(`${t.followUpDue}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })}`}
                    </p>
                    {quiet && <p className="text-[13px] text-warn">No reply in 30 days. Mark it "No reply"?</p>}
                  </div>
                  <span className="chip bg-paper font-semibold text-ink-soft">{LABEL[t.status]}</span>
                  {NEXT[t.status] && (
                    <select aria-label={`Change status of ${t.jobTitle}`} className="field w-auto rounded-full py-1.5 text-sm" value=""
                      onChange={(e) => e.target.value && act(() => api.setStatus(t.id, e.target.value as TrackStatus))}>
                      <option value="">Move to…</option>
                      {NEXT[t.status]!.map((s) => (
                        <option key={s} value={s}>{LABEL[s]}</option>
                      ))}
                    </select>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {(due.length > 0 || tracked.length > 0) && (
        <section className="flex flex-wrap gap-4">
          {due.slice(0, 2).map((t) => (
            <FollowUpCard key={t.id} t={t} onDone={() => load().catch(() => {})} />
          ))}
          <div className="panel flex flex-[1_1_320px] flex-col gap-3 p-6">
            <p className="text-[13px] font-semibold tracking-wider text-muted uppercase">Pipeline</p>
            <div className="grid grid-cols-4 gap-3">
              {(
                [
                  ["submitted", tracked.length],
                  ["screens", tracked.filter((t) => t.status === "screen").length],
                  ["interviews", tracked.filter((t) => t.status === "interview").length],
                  ["offers", tracked.filter((t) => t.status === "offer").length],
                ] as const
              ).map(([label, n]) => (
                <div key={label}>
                  <p className="text-[26px] leading-tight font-semibold text-ink">{n}</p>
                  <p className="text-[13px]">{label}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
