import { useEffect, useState } from "react";
import type { Settings as SettingsT } from "../../../shared/types";
import { api } from "../lib/api";

function NumberField({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (n: number) => void; step?: number }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input type="number" step={step} className="field" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

const PROFILE_FIELDS: [keyof SettingsT["profile"], string, string][] = [
  ["firstName", "First name", "text"],
  ["lastName", "Last name", "text"],
  ["email", "Email", "email"],
  ["phone", "Phone", "tel"],
  ["location", "City and state", "text"],
  ["currentCompany", "Current company", "text"],
  ["linkedin", "LinkedIn URL", "text"],
  ["github", "GitHub URL", "text"],
  ["website", "Website or portfolio (optional)", "text"],
];

/** Pairing code and setup steps for the Chrome extension. */
function ExtensionSetup() {
  const [code, setCode] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api.pairingCode().then((r) => setCode(r.code)).catch(() => {});
  }, []);
  return (
    <fieldset className="panel space-y-3 p-5">
      <legend className="px-1 text-lg font-semibold">Chrome extension</legend>
      <p className="text-[15px] text-ink-soft">
        Fills application forms in your own Chrome, so sites treat it like you. You still review and press Submit. One-time setup:
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-[15px]">
        <li>In Chrome, go to <code>chrome://extensions</code> and turn on <span className="font-medium">Developer mode</span> (top right).</li>
        <li>Press <span className="font-medium">Load unpacked</span> and choose the <code>extension</code> folder inside <code>job-autoload</code>.</li>
        <li>Pin it (the puzzle-piece icon → pin), click it, and paste this pairing code:</li>
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded-md border border-line bg-paper px-3 py-1.5 text-[15px]">{code ? (shown ? code : "•".repeat(16)) : "…"}</code>
        <button type="button" className="btn-quiet py-1" onClick={() => setShown((v) => !v)}>{shown ? "Hide" : "Show"}</button>
        <button type="button" className="btn-quiet py-1" disabled={!code}
          onClick={async () => {
            await navigator.clipboard.writeText(code!).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="btn-quiet py-1" onClick={() => api.newPairingCode().then((r) => setCode(r.code))}>Make a new code</button>
      </div>
      <p className="text-sm text-ink-soft">
        The code is how the app knows a request comes from your extension. A new code unpairs the old one. The app rebuilds the extension each time you
        run <code>npm run dev</code>; after pulling an update, press the reload icon on the extension in <code>chrome://extensions</code>.
      </p>
    </fieldset>
  );
}

export function Settings() {
  const [s, setS] = useState<SettingsT | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [sitesText, setSitesText] = useState<string | null>(null); // raw text, so typing a comma isn't eaten

  useEffect(() => {
    api.getSettings().then(setS);
  }, []);
  if (!s) return <p className="text-ink-soft">Loading settings…</p>;

  const t = s.targets;
  const bucketTotal = t.bucketHours.applications + t.bucketHours.projects + t.bucketHours.prep;
  const setTargets = (patch: Partial<SettingsT["targets"]>) => setS({ ...s, targets: { ...t, ...patch } });
  const setBucket = (k: keyof SettingsT["targets"]["bucketHours"]) => (n: number) =>
    setTargets({ bucketHours: { ...t.bucketHours, [k]: n } });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      setS(await api.saveSettings(s!));
      setStatus({ ok: true, text: "Settings saved." });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  }

  return (
    <form onSubmit={save} className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-[34px] leading-tight font-semibold tracking-tight">Settings</h1>
        <p className="text-ink-soft">Targets and fixed answers the rest of the app reads from.</p>
      </header>

      <fieldset className="panel space-y-4 p-5">
        <legend className="px-1 text-lg font-semibold">Weekly targets</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField label="Applications per day" value={t.appsPerDay} onChange={(n) => setTargets({ appsPerDay: n })} />
          <NumberField label="Days per week" value={t.daysPerWeek} onChange={(n) => setTargets({ daysPerWeek: n })} />
          <NumberField label="Weekly hour cap" value={t.hoursPerWeekCap} onChange={(n) => setTargets({ hoursPerWeekCap: n })} />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField label="Hours: applications" step={0.5} value={t.bucketHours.applications} onChange={setBucket("applications")} />
          <NumberField label="Hours: projects" step={0.5} value={t.bucketHours.projects} onChange={setBucket("projects")} />
          <NumberField label="Hours: interview prep" step={0.5} value={t.bucketHours.prep} onChange={setBucket("prep")} />
        </div>
        <p className={`text-[15px] ${bucketTotal > t.hoursPerWeekCap ? "text-fail" : "text-ink-soft"}`}>
          {bucketTotal} of {t.hoursPerWeekCap} hours planned
          {bucketTotal > t.hoursPerWeekCap ? ". That's over the cap; lower a bucket before saving." : "."}
        </p>
        <div className="sm:w-1/3">
          <label className="label">Cap review date</label>
          <input type="date" className="field" value={s.capReviewDate} onChange={(e) => setS({ ...s, capReviewDate: e.target.value })} />
        </div>
      </fieldset>

      <fieldset className="panel space-y-4 p-5">
        <legend className="px-1 text-lg font-semibold">Profile</legend>
        <p className="text-[15px] text-ink-soft">
          What the app types into application forms when you press Open and prefill. Stored only in your local database. Never put passwords here.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {PROFILE_FIELDS.map(([key, label, type]) => (
            <div key={key}>
              <label className="label" htmlFor={`p-${key}`}>{label}</label>
              <input id={`p-${key}`} type={type} className="field" value={s.profile[key]} autoComplete="off"
                onChange={(e) => setS({ ...s, profile: { ...s.profile, [key]: e.target.value } })} />
            </div>
          ))}
        </div>
      </fieldset>

      <ExtensionSetup />

      <fieldset className="panel space-y-3 p-5">
        <legend className="px-1 text-lg font-semibold">Apply in your own browser</legend>
        <p className="text-[15px] text-ink-soft">
          Sites that flag the app's automated window as spam. For these, the app reads the form and prepares every answer, and you paste them in your
          own browser. Use ATS names (ashby, greenhouse, lever) or a website (acme.com). The app adds a site here when it sees a spam block.
        </p>
        <input aria-label="Sites to apply to in your own browser" className="field" value={sitesText ?? s.submit.ownBrowserFor.join(", ")}
          onChange={(e) => {
            setSitesText(e.target.value);
            setS({ ...s, submit: { ownBrowserFor: e.target.value.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) } });
          }} />
      </fieldset>

      <fieldset className="panel space-y-4 p-5">
        <legend className="px-1 text-lg font-semibold">Work authorization answers</legend>
        <p className="text-[15px] text-ink-soft">
          Every application uses these exact answers. The AI never writes or changes them.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Authorized to work in the US?</label>
            <select className="field" value={s.workAuth.authorizedToWorkInUS}
              onChange={(e) => setS({ ...s, workAuth: { ...s.workAuth, authorizedToWorkInUS: e.target.value as "Yes" | "No" } })}>
              <option>Yes</option>
              <option>No</option>
            </select>
          </div>
          <div>
            <label className="label">Will you need sponsorship now or in the future?</label>
            <select className="field" value={s.workAuth.requiresSponsorshipNowOrFuture}
              onChange={(e) => setS({ ...s, workAuth: { ...s.workAuth, requiresSponsorshipNowOrFuture: e.target.value as "Yes" | "No" } })}>
              <option>Yes</option>
              <option>No</option>
            </select>
          </div>
        </div>
      </fieldset>

      <fieldset className="panel space-y-4 p-5">
        <legend className="px-1 text-lg font-semibold">Standard answers</legend>
        <p className="text-[15px] text-ink-soft">
          Your own answers to common questions, added to every application as written. Anything in [brackets] is a placeholder;
          the Truth Check holds applications back until it's filled in.
        </p>
        {s.standardAnswers.map((a, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-start">
            <input className="field" aria-label={`Question ${i + 1}`} value={a.question}
              onChange={(e) => setS({ ...s, standardAnswers: s.standardAnswers.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)) })} />
            <textarea className={`field ${/\[[^\]]+\]/.test(a.answer) ? "border-warn" : ""}`} rows={2} aria-label={`Answer ${i + 1}`} value={a.answer}
              onChange={(e) => setS({ ...s, standardAnswers: s.standardAnswers.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)) })} />
            <button type="button" className="btn-quiet py-1.5" onClick={() => setS({ ...s, standardAnswers: s.standardAnswers.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn-quiet" onClick={() => setS({ ...s, standardAnswers: [...s.standardAnswers, { question: "", answer: "" }] })}>
          Add a question
        </button>
      </fieldset>

      <fieldset className="panel space-y-4 p-5">
        <legend className="px-1 text-lg font-semibold">Location</legend>
        <div>
          <label className="label">Preferred locations (comma-separated, used to break ties)</label>
          <input className="field" value={s.locationPrefs.preferred.join(", ")}
            onChange={(e) => setS({ ...s, locationPrefs: { ...s.locationPrefs, preferred: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })} />
        </div>
        <label className="flex items-center gap-2.5 text-[15px]">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={s.locationPrefs.openToRelocation}
            onChange={(e) => setS({ ...s, locationPrefs: { ...s.locationPrefs, openToRelocation: e.target.checked } })} />
          Open to relocating anywhere in the US
        </label>
      </fieldset>

      <fieldset className="panel space-y-4 p-5">
        <legend className="px-1 text-lg font-semibold">Today's picks</legend>
        <p className="text-[15px] text-ink-soft">
          How many jobs of each tier are in today's deck. Tier A comes first. Each time you accept or skip one, the next-best job of that tier takes its place, so you only need a new run for new postings. Changing these re-ranks the deck right away, with no new AI calls.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Tier A picks (fit 8–10)" value={s.shortlist.tierAPicks}
            onChange={(n) => setS({ ...s, shortlist: { ...s.shortlist, tierAPicks: n } })} />
          <NumberField label="Tier B picks (fit 5–7)" value={s.shortlist.tierBPicks}
            onChange={(n) => setS({ ...s, shortlist: { ...s.shortlist, tierBPicks: n } })} />
          <NumberField label="Posted within (days)" value={s.shortlist.maxAgeDays}
            onChange={(n) => setS({ ...s, shortlist: { ...s.shortlist, maxAgeDays: n } })} />
          <div className="sm:col-span-2">
            <label className="label" htmlFor="cityBoost">Extra weight for your preferred city ({s.locationPrefs.preferred.find((p) => !/remote/i.test(p))?.split(",")[0] ?? "none set"})</label>
            <select id="cityBoost" className="field sm:w-1/2" value={s.shortlist.preferredCityBoost}
              onChange={(e) => setS({ ...s, shortlist: { ...s.shortlist, preferredCityBoost: Number(e.target.value) } })}>
              <option value={0}>None: remote and city only break ties</option>
              <option value={1}>+1: within a tier, a 7 there ranks like an 8 elsewhere</option>
              <option value={2}>+2: within a tier, a 6 there ranks like an 8 elsewhere</option>
            </select>
          </div>
        </div>
        <p className="text-sm text-ink-soft">
          If the deck runs short, there aren't enough recent jobs of that tier. Add more companies on the Companies page.
        </p>
      </fieldset>

      <fieldset className="panel space-y-4 p-5">
        <legend className="px-1 text-lg font-semibold">Daily run</legend>
        <p className="text-[15px] text-ink-soft">
          Fetches your companies' job boards, scores new jobs, and builds Today's picks. It runs while the app is open; if your
          laptop was asleep at that time, it catches up when the app starts.
        </p>
        <label className="flex items-center gap-2.5 text-[15px]">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={s.pipeline.enabled}
            onChange={(e) => setS({ ...s, pipeline: { ...s.pipeline, enabled: e.target.checked } })} />
          Run every day
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label">Time</label>
            <input type="time" className="field" value={s.pipeline.dailyTime}
              onChange={(e) => setS({ ...s, pipeline: { ...s.pipeline, dailyTime: e.target.value } })} />
          </div>
          <div>
            <label className="label">Time zone</label>
            <input className="field" value={s.pipeline.timezone}
              onChange={(e) => setS({ ...s, pipeline: { ...s.pipeline, timezone: e.target.value } })} />
          </div>
          <NumberField label="Most jobs to score per run" value={s.pipeline.maxScoresPerRun}
            onChange={(n) => setS({ ...s, pipeline: { ...s.pipeline, maxScoresPerRun: n } })} />
        </div>
        <p className="text-sm text-ink-soft">Scoring costs about $0.001 per job, so 150 is about $0.15 per run at most.</p>
      </fieldset>

      <fieldset className="panel space-y-4 p-5">
        <legend className="px-1 text-lg font-semibold">AI models</legend>
        <p className="text-[15px] text-ink-soft">A smaller model scores in bulk; a larger one writes (from Phase 3).</p>
        <div className="grid gap-4 sm:grid-cols-3">
          {(["scoring", "tailoring", "checkIns"] as const).map((k) => (
            <div key={k}>
              <label className="label">{{ scoring: "Job scoring", tailoring: "Resume tailoring", checkIns: "Mentor check-ins" }[k]}</label>
              <input className="field" value={s.models[k]} onChange={(e) => setS({ ...s, models: { ...s.models, [k]: e.target.value } })} />
            </div>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary">Save settings</button>
        {status && <p className={`text-[15px] ${status.ok ? "text-pass" : "text-fail"}`} role="status">{status.text}</p>}
      </div>
    </form>
  );
}
