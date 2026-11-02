import { useEffect, useState } from "react";
import type { ApplicationStatus, InboxItem, InboxState } from "../../../shared/types";
import { api } from "../lib/api";

// What the 8pm inbox check found. Suggestions wait for you; only
// "application received" is recorded on its own.

const STATUS_VERB: Partial<Record<ApplicationStatus, string>> = {
  submitted: "Mark submitted",
  screen: "Move to recruiter screen",
  interview: "Move to interviewing",
  offer: "Mark offer",
  rejected: "Mark rejected",
};

const when = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Suggestion({ item, onDone }: { item: InboxItem; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<number | "">(item.candidates[0]?.id ?? "");
  const tone = item.kind === "rejection" ? "text-fail" : item.kind === "other" ? "text-muted" : item.kind === "received" ? "text-ink-soft" : "text-pass";

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 border-t border-line pt-3 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold text-ink">
          <span className={tone}>{item.kindLabel}</span>
          {item.application && <span className="font-normal text-ink-soft"> · {item.application.companyName}, {item.application.jobTitle}</span>}
        </p>
        <span className="text-[13px] text-muted">{when(item.receivedAt)}</span>
      </div>
      <p className="text-sm text-ink">
        <span className="font-medium">{item.subject}</span> <span className="text-muted">— {item.from}</span>
      </p>
      <p className="text-sm text-ink-soft">{item.snippet}</p>
      {item.kindReason && (
        <p className="text-[13px] text-muted">
          {item.kindSource === "model" ? "Read by AI: " : item.kind === "other" ? "" : "Matched on "}
          {item.kindReason}
        </p>
      )}
      {item.candidates.length > 0 && (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">You applied there more than once. Which one?</span>
          <select className="field w-auto py-1 text-sm" value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
            {item.candidates.map((c) => (
              <option key={c.id} value={c.id}>{c.jobTitle}</option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {(item.suggestedStatus || item.candidates.length > 0) && item.kind !== "other" && (
          <button className="btn-primary py-1.5 text-sm" disabled={busy}
            onClick={() => act(() => api.acceptInbox(item.id, item.candidates.length ? Number(choice) : undefined))}>
            {item.suggestedStatus ? STATUS_VERB[item.suggestedStatus] ?? "Accept" : "Apply to this one"}
          </button>
        )}
        <button className="btn-quiet py-1.5 text-sm" disabled={busy} onClick={() => act(() => api.dismissInbox(item.id))}>
          {item.kind === "other" ? "Done" : "Not right"}
        </button>
        <a className="link text-sm" href={item.gmailUrl} target="_blank" rel="noreferrer">Open in Gmail</a>
      </div>
      {error && <p className="text-sm text-fail">{error}</p>}
    </li>
  );
}

/** On Today: the emails waiting for a decision. Hidden when there's nothing to decide. */
export function InboxCard({ inbox, onChanged }: { inbox: InboxState | null; onChanged: () => void }) {
  if (!inbox?.configured || inbox.pending.length === 0) return null;
  return (
    <section className="panel space-y-4 p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">From your inbox</h2>
        <p className="text-[13px] text-muted">{inbox.pending.length} to confirm · checked {inbox.lastCheck ? when(inbox.lastCheck.at) : "—"}</p>
      </div>
      <ul className="space-y-3">
        {inbox.pending.map((i) => (
          <Suggestion key={i.id} item={i} onDone={onChanged} />
        ))}
      </ul>
    </section>
  );
}

/** One line for the sidebar on Today: when it last looked and what it found. */
export function InboxStatusLine({ inbox }: { inbox: InboxState | null }) {
  if (!inbox) return null;
  if (!inbox.configured) {
    return (
      <p className="text-[13px] text-muted">
        Inbox not connected. <a className="link" href="#/settings">Set it up</a>
      </p>
    );
  }
  const l = inbox.lastCheck;
  return (
    <p className={`text-[13px] ${l?.status === "failed" ? "text-fail" : "text-muted"}`}>
      {!l ? `Inbox: first check at ${inbox.checkAt === "20:00" ? "8pm" : inbox.checkAt}.` : l.status === "failed" ? `Inbox check failed: ${l.error}` : `Inbox checked ${when(l.at)}: ${l.stats?.matched ?? 0} job emails, ${inbox.pending.length} to confirm.`}
    </p>
  );
}

/** On Settings: connection status, the one-time setup, and a button to try it. */
export function InboxSetup() {
  const [inbox, setInbox] = useState<InboxState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api.inbox().then(setInbox).catch(() => {});
  useEffect(() => void load(), []);

  return (
    <fieldset className="panel space-y-3 p-5">
      <legend className="px-1 text-lg font-semibold">Job-search inbox</legend>
      <p className="text-[15px] text-ink-soft">
        Once a day at 8pm, the app reads new mail in this inbox, keeps only emails about applications you've sent, and suggests status changes on Today. It opens the
        mailbox read-only: it never sends, deletes, or marks anything as read. Only "application received" is recorded without asking you.
      </p>
      {inbox?.configured ? (
        <>
          <p className="text-[15px]">
            Watching <span className="font-medium">{inbox.address}</span>.{" "}
            {inbox.lastCheck
              ? inbox.lastCheck.status === "ok"
                ? `Last checked ${when(inbox.lastCheck.at)}.`
                : <span className="text-fail">Last check failed: {inbox.lastCheck.error}</span>
              : "Not checked yet."}
          </p>
          {inbox.fillsWithOtherAddress && (
            <p className="rounded-md bg-warn-bg px-3 py-2 text-[15px] text-warn">
              Forms are filled with {inbox.fillsWithOtherAddress} (Profile, above), so replies go there, not to {inbox.address}. Change the Profile email and your
              resumes' contact line to {inbox.address} if that's the address you're applying with.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn-quiet py-1.5"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setMessage(null);
                try {
                  const r = await api.checkInbox();
                  setMessage({ ok: true, text: "note" in r && r.note ? r.note : `Looked at ${r.scanned} emails: ${r.matched} about your applications, ${r.suggestions} to confirm on Today.` });
                  await load();
                } catch (e) {
                  setMessage({ ok: false, text: (e as Error).message });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Checking…" : "Check now"}
            </button>
            <span className="text-sm text-muted">To test the setup. It checks on its own at 8pm.</span>
          </div>
          {message && <p className={`text-[15px] ${message.ok ? "text-pass" : "text-fail"}`}>{message.text}</p>}
        </>
      ) : (
        <ol className="list-decimal space-y-1 pl-5 text-[15px]">
          <li>On the Google account for this address, turn on 2-Step Verification (myaccount.google.com → Security).</li>
          <li>Go to <span className="font-medium">myaccount.google.com/apppasswords</span>, make one named "Autopilot", and copy the 16-letter password.</li>
          <li>
            In the <code>.env</code> file in <code>job-autoload</code>, add <code>MAIL_ADDRESS=</code> your address and <code>MAIL_APP_PASSWORD=</code> that password.
          </li>
          <li>Restart the app (Ctrl+C, then <code>npm run dev</code>) and come back here.</li>
        </ol>
      )}
      {inbox?.unavailable && !inbox.configured && <p className="text-sm text-muted">Now: {inbox.unavailable}.</p>}
    </fieldset>
  );
}
