import { useEffect, useState } from "react";
import type { ApplicationDetail, Profile, SubmitSession } from "../../../shared/types";
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
        <CopyRow label="Recruiter note (cover letter or 'additional information')" value={app.recruiterNote ?? ""} />
        {app.answers.map((a, i) => (
          <CopyRow key={i} label={a.question} value={a.answer} />
        ))}
      </div>
    </details>
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
          Track it on the <a className="font-medium text-accent underline underline-offset-2" href="#/tracker">Tracker</a>.
        </p>
        <button className="btn-quiet py-1" disabled={busy} onClick={() => run(async () => onChanged(await api.unmarkSubmitted(app.id)))}>
          Not actually submitted? Undo
        </button>
        {error && <p className="text-[15px] text-fail">{error}</p>}
      </div>
    );
  }

  return (
    <div className="w-full space-y-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Submit</h3>
        <p className="text-[15px] text-ink-soft">
          Opens the real application form in a browser window and fills in what it can. You check everything and press Submit there yourself. The app
          never submits, and it never touches a CAPTCHA.
        </p>
      </div>
      {missingProfile && (
        <p className="rounded-md bg-warn-bg px-3 py-2 text-[15px] text-warn">
          Add your name, email and phone in <a className="font-medium underline underline-offset-2" href="#/settings">Settings → Profile</a> first, or those fields stay blank.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" disabled={busy || session?.state === "opening"} onClick={() => run(async () => setSession(await api.openToSubmit(app.id)))}>
          {session?.state === "opening" ? "Opening and filling…" : session?.state === "open" ? "Show the form window" : report ? "Open and prefill again" : "Open and prefill"}
        </button>
        <button className="btn-quiet" disabled={busy} onClick={() => run(async () => onChanged(await api.markSubmitted(app.id)))}>
          I submitted it
        </button>
        {report?.url && <a className="btn-quiet" href={report.url} target="_blank" rel="noreferrer">Open the form in your browser</a>}
      </div>
      {session?.state === "open" && (
        <p className="text-[15px]">The form is open in the Chromium window. When you submit, the app notices the thank-you page and marks it submitted.</p>
      )}
      {error && <p className="text-[15px] text-fail">{error}</p>}

      {report && (
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
