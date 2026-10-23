import { Evidence } from "./Evidence";
import type { EmploymentFlags, ExtractedFields, SponsorshipStated } from "../../../shared/types";

const EMPLOYMENT_LABELS: Record<keyof EmploymentFlags, string> = {
  w1099: "1099 contract",
  c2c: "Corp-to-corp (C2C)",
  freelance: "Freelance",
  unpaid: "Unpaid",
  commissionOnly: "Commission only",
  contract: "Contract",
  contractToHire: "Contract-to-hire",
  staffingAgency: "Staffing / consulting firm",
  partTime: "Part-time",
};


function Toggle({
  label,
  checked,
  onChange,
  evidence,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  evidence?: string;
}) {
  return (
    <div className="py-2">
      <label className="flex cursor-pointer items-center gap-2.5 text-[15px]">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        {label}
      </label>
      {checked && <Evidence text={evidence} />}
    </div>
  );
}

/**
 * The review step. Regex prefilled these; you correct anything it got wrong.
 * The filters run on what's here, not on the raw regex output.
 */
export function FieldsEditor({ value, onChange }: { value: ExtractedFields; onChange: (v: ExtractedFields) => void }) {
  const set = <K extends keyof ExtractedFields>(key: K, v: ExtractedFields[K]) => onChange({ ...value, [key]: v });
  const setFlag = (key: keyof EmploymentFlags, v: boolean) => onChange({ ...value, employment: { ...value.employment, [key]: v } });
  const ev = value.evidence;

  return (
    <div className="divide-y divide-line">
      <div className="grid gap-4 pb-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="years">
            Years required
          </label>
          <input
            id="years"
            type="number"
            min={0}
            max={30}
            className="field"
            placeholder="Not stated"
            value={value.yearsRequired ?? ""}
            onChange={(e) => set("yearsRequired", e.target.value === "" ? null : Number(e.target.value))}
          />
          <Evidence text={ev.yearsRequired} />
        </div>
        <div>
          <label className="label" htmlFor="sponsorship">
            Sponsorship
          </label>
          <select
            id="sponsorship"
            className="field"
            value={value.sponsorshipStated}
            onChange={(e) => set("sponsorshipStated", e.target.value as SponsorshipStated)}
          >
            <option value="unstated">Not stated</option>
            <option value="yes">Offers sponsorship</option>
            <option value="no">No sponsorship</option>
          </select>
          <Evidence text={ev.sponsorshipStated} />
        </div>
      </div>

      <fieldset className="py-3">
        <legend className="label pt-1">Location</legend>
        <Toggle label="Remote" checked={value.remote} onChange={(v) => set("remote", v)} evidence={ev.remote} />
        {value.remote && (
          <Toggle
            label="Posting says remote within the US"
            checked={value.remoteCountryStated}
            onChange={(v) => set("remoteCountryStated", v)}
            evidence={ev.remoteCountryStated}
          />
        )}
      </fieldset>

      <fieldset className="py-3">
        <legend className="label pt-1">Work authorization</legend>
        <Toggle
          label="Requires US citizenship / US person"
          checked={value.requiresCitizenship}
          onChange={(v) => set("requiresCitizenship", v)}
          evidence={ev.requiresCitizenship}
        />
        <Toggle
          label="Requires a security clearance"
          checked={value.requiresClearance}
          onChange={(v) => set("requiresClearance", v)}
          evidence={ev.requiresClearance}
        />
        <Toggle
          label="Mentions E-Verify"
          checked={value.eVerifyMentioned}
          onChange={(v) => set("eVerifyMentioned", v)}
          evidence={ev.eVerifyMentioned}
        />
      </fieldset>

      <fieldset className="pt-3">
        <legend className="label pt-1">Employment type</legend>
        <div className="grid sm:grid-cols-2 sm:gap-x-6">
          {(Object.keys(EMPLOYMENT_LABELS) as (keyof EmploymentFlags)[]).map((k) => (
            <Toggle
              key={k}
              label={EMPLOYMENT_LABELS[k]}
              checked={value.employment[k]}
              onChange={(v) => setFlag(k, v)}
              evidence={ev[`employment.${k}`]}
            />
          ))}
        </div>
      </fieldset>
    </div>
  );
}
