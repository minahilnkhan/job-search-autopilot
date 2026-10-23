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

export function Settings() {
  const [s, setS] = useState<SettingsT | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

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
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
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
        <legend className="px-1 text-lg font-semibold">AI models</legend>
        <p className="text-[15px] text-ink-soft">Used from Phase 2. A smaller model scores in bulk; a larger one writes.</p>
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
