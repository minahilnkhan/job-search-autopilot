import { useEffect, useState } from "react";
import type { ApplicationDetail, Profile, SubmitAsk, SubmitSession } from "../../../shared/types";
import { api } from "../lib/api";

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-t border-line py-2 first:border-t-0">
      <div className="min-w-0">
        <p className="text-sm text-ink-soft">{label}</p>
        <p className="whitespace-pre-wrap break-words text-[15px]">{value}</p>
      </div>
      <button
        type="button"
        className="btn-quiet py-1 text-sm"
        onClick={async () => {
          await navigator.clipboard.writeText(value).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Everything a form might ask for, each with a copy button. Also the fallback when prefill fails. */
function CopyPanel({ app, profile, open }: { app: ApplicationDetail; profile: Profile | null; open: boolean }) {
  const p = profile;
  return (
    <details className="rounded-md border border-line" open={open}>
      <summary className="cursor-pointer px-3 py-2 text-[15px] font-medium">Copy panel: every value, ready to paste</summary>
      <div className="px-3 pb-2">
        {p && (
          <>
            <CopyRow label="First name" value={p.firstName} />
            <CopyRow label="Last name" value={p.lastName} />
            <CopyRow label="Full name" value={`${p.firstName} ${p.lastName}`.trim()} />
            <CopyRow label="Email" value={p.email} />
            <CopyRow label="Phone" value={p.phone} />
            <CopyRow label="Location" value={p.location} />
            <CopyRow label="Current company" value={p.currentCompany} />
            <CopyRow label="LinkedIn" value={p.linkedin} />
            <CopyRow label="GitHub" value={p.github} />
            <CopyRow label="Website" value={p.website} />
          </>
        )}
        <div className="border-t border-line py-2">
          <p className="text-sm text-ink-soft">Resume</p>
          <a className="text-[15px] font-medium text-accent underline underline-offset-2" href={`/api/applications/${app.id}/resume.pdf`} download>
            Download the PDF to attach
          </a>
        </div>
        {app.answers.map((a, i) => (
          <CopyRow key={i} label={a.question} value={a.answer} />
        ))}
      </div>
    </details>
  );
}

/** One question from the app, chat style: its question, your reply, and where the reply went. */
function AskBubble({ appId, ask, onAnswered }: { appId: number; ask: SubmitAsk; onAnswered: (s: SubmitSession) => void }) {
  const [reply, setReply] = useState(ask.draft ?? "");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="space-y-2">
      <div className="max-w-[85%] rounded-lg rounded-tl-sm bg-paper px-3 py-2">
        <p className="text-sm text-ink-soft">
          {ask.label}
          {ask.required && <span className="text-fail"> · required</span>}
        </p>
        <p className="text-[15px]">{ask.question}</p>
      </div>
      {ask.answer ? (
        <div className="ml-auto max-w-[85%] space-y-1 text-right">
          <p className="inline-block rounded-lg rounded-tr-sm bg-accent px-3 py-2 text-left text-[15px] text-white">{ask.answer}</p>
          <p className="text-sm text-ink-soft">{ask.filled ? "Typed into the form." : "Saved. The form window is closed, so paste it from the copy panel."}</p>
        </div>
      ) : (
        <form
          className="ml-auto max-w-[85%] space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              onAnswered(await api.answerAsk(appId, ask.id, reply, remember));
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <textarea aria-label={`Your answer: ${ask.label}`} className="field" rows={ask.draft ? 4 : 2} value={reply} onChange={(e) => setReply(e.target.value)}
            placeholder="Type your answer" />
          <div className="flex flex-wrap items-center justify-end gap-3">
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input type="checkbox" className="h-4 w-4 accent-accent" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Use this answer on every application
            </label>
            <button className="btn-primary py-1.5" disabled={busy || !reply.trim()}>{busy ? "Filling…" : "Send"}</button>
          </div>
          {error && <p className="text-sm text-fail">{error}</p>}
        </form>
      )}
    </li>
  );
}

/**
 * Assisted submit for an approved application: open the real form in a
 * browser window, prefill it, you review and press Submit there.
 */
export function SubmitPanel({ app, onChanged }: { app: ApplicationDetail; onChanged: (a: ApplicationDetail) => void }) {
  const [session, setSession] = useState<SubmitSession | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => setProfile(s.profile)).catch(() => {});
    api.submitSession(app.id).then(setSession).catch(() => {});
  }, [app.id]);

  // While the form is open, follow along: the report arrives, then "submitted".
  const live = session?.state === "opening" || session?.state === "open";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(async () => {
      const s = await api.submitSession(app.id).catch(() => null);
      if (!s) return;
      setSession(s);
      if (s.state === "submitted" && app.status !== "submitted") onChanged(await api.application(app.id));
    }, 1500);
    return () => clearInterval(t);
  }, [live, app.id, app.status, onChanged]);

  // The extension can mark it submitted from your browser; notice that here.
  useEffect(() => {
    if (app.status !== "approved") return;
    const t = setInterval(async () => {
      const fresh = await api.application(app.id).catch(() => null);
      if (fresh && (fresh.status !== app.status || fresh.prefillReport?.at !== app.prefillReport?.at)) onChanged(fresh);
    }, 5000);
    return () => clearInterval(t);
  }, [app.id, app.status, app.prefillReport?.at, onChanged]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const report = session?.report ?? app.prefillReport;
  const missingProfile = profile && (!profile.firstName || !profile.lastName || !profile.email || !profile.phone);
  const required = report?.leftForYou.filter((l) => l.required) ?? [];
  const optional = report?.leftForYou.filter((l) => !l.required) ?? [];

  if (app.status === "submitted") {
    return (
      <div className="w-full space-y-2">
        <p className="text-[15px] text-pass">
          Submitted {app.submittedAt ? new Date(app.submittedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}.
          {app.followUpDue ? ` Follow up on ${new Date(`${app.followUpDue}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" })} if you haven't heard back.` : ""}{" "}
          Track it on the <a className="font-medium text-accent underline underline-offset-2" href="#/applications?stage=submitted">Applications page</a>.
        </p>
        <button className="btn-quiet py-1" disabled={busy} onClick={() => run(async () => onChanged(await api.unmarkSubmitted(app.id)))}>
          Not actually submitted? Undo
        </button>
        {error && <p className="text-[15px] text-fail">{error}</p>}
      </div>
    );
  }

  const copyMode = report?.mode === "copy";
  return (
    <div className="w-full space-y-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Submit</h3>
        <p className="text-[15px] text-ink-soft">
          {copyMode
            ? "For this site you apply in your own browser, with every answer prepared below."
            : "The form gets filled in for you; you check everything and press Submit yourself. Nothing is ever submitted for you, and CAPTCHAs are left to you."}
        </p>
      </div>
      {missingProfile && (
        <p className="rounded-md bg-warn-bg px-3 py-2 text-[15px] text-warn">
          Add your name, email and phone in <a className="font-medium underline underline-offset-2" href="#/settings">Settings → Profile</a> first, or those fields stay blank.
        </p>
      )}
      <div className="space-y-2 rounded-md border border-accent/40 p-3">
        <p className="font-medium">Fill it in your own Chrome (recommended)</p>
        <ol className="list-decimal space-y-0.5 pl-5 text-[15px]">
          <li>Press <span className="font-medium">Open in my browser</span>.</li>
          <li>Click the Job Search Autopilot extension in Chrome's toolbar and press <span className="font-medium">Fill this form</span>.</li>
          <li>Answer any questions it asks, check the form, and press Submit on the page.</li>
          <li>Press <span className="font-medium">I submitted it</span> (in the extension or here).</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          {(app.applyUrl ?? report?.url) && (
            <a className="btn-primary" href={(app.applyUrl ?? report?.url)!} target="_blank" rel="noreferrer">Open in my browser</a>
          )}
          <button className="btn-quiet" disabled={busy} onClick={() => run(async () => onChanged(await api.markSubmitted(app.id)))}>
            I submitted it
          </button>
        </div>
        <p className="text-sm text-ink-soft">
          No extension yet? Set it up once in <a className="underline underline-offset-2" href="#/settings">Settings → Chrome extension</a>.
        </p>
      </div>
      <details className="text-[15px]">
        <summary className="cursor-pointer text-ink-soft">Other ways: the app's own window, or prepared answers to paste</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="btn-quiet" disabled={busy || session?.state === "opening"} onClick={() => run(async () => setSession(await api.openToSubmit(app.id)))}>
            {session?.state === "opening"
              ? copyMode || !report ? "Reading the form…" : "Opening and filling…"
              : session?.state === "open"
                ? "Show the form window"
                : copyMode
                  ? "Read the form again"
                  : "Fill in the app's window"}
          </button>
        </div>
        <p className="mt-1 text-sm text-ink-soft">The app's window is automated, so some sites (like Ashby) block it; for those it prepares every answer for you to paste instead.</p>
      </details>
      {copyMode && (
        <div className="space-y-2 rounded-md border border-accent/40 p-3">
          <p className="text-[15px]">
            This site blocks automated browsers, so apply in your own browser. The app read the form and prepared every answer below, in the form's
            order. Open the form, paste each one, attach your resume, and press Submit. Then press <span className="font-medium">I submitted it</span>.
          </p>
          <a className="text-[15px] font-medium text-accent underline underline-offset-2" href={`/api/applications/${app.id}/resume.pdf`} download>
            Download your resume PDF
          </a>
          {(report?.prepared?.length ?? 0) > 0 && (
            <div className="rounded-md bg-paper px-3 py-1">
              {report!.prepared!.map((p, i) => (
                <CopyRow key={i} label={p.label} value={p.value} />
              ))}
            </div>
          )}
        </div>
      )}
      {session?.state === "opening" && (
        <p className="text-[15px]">Opening the form, filling it in, and drafting answers to its open questions. This takes about half a minute.</p>
      )}
      {session?.state === "open" && (
        <p className="text-[15px]">The form is open in the Chromium window. When you submit, the app notices the thank-you page and marks it submitted.</p>
      )}
      {error && <p className="text-[15px] text-fail">{error}</p>}

      {report?.notices?.map((n, i) => (
        <p key={i} className="rounded-md bg-warn-bg px-3 py-2 text-[15px] text-warn">{n}</p>
      ))}

      {(report?.asks?.length ?? 0) > 0 && (
        <div className="space-y-3 rounded-md border border-line p-3">
          <p className="font-medium">
            Questions for you ({report!.asks.filter((a) => !a.answer).length} open)
          </p>
          <ul className="space-y-4">
            {report!.asks.map((a) => (
              <AskBubble key={a.id} appId={app.id} ask={a} onAnswered={setSession} />
            ))}
          </ul>
        </div>
      )}

      {report && (report.error || required.length > 0 || report.filled.length > 0 || optional.length > 0) && (
        <div className="space-y-3 rounded-md border border-line p-3">
          {report.error && <p className="text-[15px] text-fail">{report.error}</p>}
          {required.length > 0 && (
            <div>
              <p className="font-medium">Fill these yourself ({required.length})</p>
              <ul className="mt-1 space-y-1 text-[15px]">
                {required.map((l, i) => (
                  <li key={i}><span className="font-medium">{l.label}</span> <span className="text-ink-soft">· {l.reason}</span></li>
                ))}
              </ul>
            </div>
          )}
          {report.filled.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[15px]">
                Filled {report.filled.length} field{report.filled.length === 1 ? "" : "s"}{report.resumeUploaded ? ", resume attached" : ", resume not attached"}
              </summary>
              <ul className="mt-1 space-y-1 text-sm">
                {report.filled.map((f, i) => (
                  <li key={i}><span className="text-ink-soft">{f.label}:</span> {f.value.length > 80 ? `${f.value.slice(0, 77)}…` : f.value}</li>
                ))}
              </ul>
            </details>
          )}
          {optional.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[15px] text-ink-soft">Optional fields left blank ({optional.length})</summary>
              <ul className="mt-1 space-y-1 text-sm text-ink-soft">
                {optional.map((l, i) => (
                  <li key={i}>{l.label} · {l.reason}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <CopyPanel app={app} profile={profile} open={!!report?.error} />
    </div>
  );
}
