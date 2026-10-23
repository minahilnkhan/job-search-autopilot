import { useEffect, useState } from "react";
import type { AtsType, Company, EVerify } from "../../../shared/types";
import { api, E_VERIFY_SEARCH_URL } from "../lib/api";

type Draft = {
  name: string;
  website: string;
  atsType: AtsType | "";
  atsBoardToken: string;
  tags: string;
  warmContact: boolean;
  notes: string;
};

const toDraft = (c?: Company): Draft => ({
  name: c?.name ?? "",
  website: c?.website ?? "",
  atsType: c?.atsType ?? "",
  atsBoardToken: c?.atsBoardToken ?? "",
  tags: c?.tags.join(", ") ?? "",
  warmContact: c?.warmContact ?? false,
  notes: c?.notes ?? "",
});

const fromDraft = (d: Draft) => ({
  name: d.name.trim(),
  website: d.website.trim() || null,
  atsType: d.atsType || null,
  atsBoardToken: d.atsBoardToken.trim() || null,
  tags: d.tags.split(",").map((t) => t.trim()).filter(Boolean),
  warmContact: d.warmContact,
  notes: d.notes.trim() || null,
});

function CompanyForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial?: Company;
  submitLabel: string;
  onSubmit: (d: ReturnType<typeof fromDraft>) => Promise<void>;
  onCancel?: () => void;
}) {
  const [d, setD] = useState<Draft>(toDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setD({ ...d, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await onSubmit(fromDraft(d));
          if (!initial) setD(toDraft());
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Name</label>
          <input className="field" required value={d.name} onChange={set("name")} />
        </div>
        <div>
          <label className="label">Website</label>
          <input className="field" type="url" value={d.website} onChange={set("website")} />
        </div>
        <div>
          <label className="label">Job board (ATS)</label>
          <select className="field" value={d.atsType} onChange={set("atsType")}>
            <option value="">Unknown</option>
            <option value="greenhouse">Greenhouse</option>
            <option value="lever">Lever</option>
            <option value="ashby">Ashby</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <label className="label">Board token</label>
          <input className="field" placeholder="e.g. anthropic" value={d.atsBoardToken} onChange={set("atsBoardToken")} />
        </div>
        <div>
          <label className="label">Tags</label>
          <input className="field" placeholder="ai-native, ed-tech" value={d.tags} onChange={set("tags")} />
        </div>
        <div>
          <label className="label">Notes</label>
          <input className="field" value={d.notes} onChange={set("notes")} />
        </div>
      </div>
      <label className="flex items-center gap-2.5 text-[15px]">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={d.warmContact} onChange={set("warmContact")} />
        I know someone there
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary">{submitLabel}</button>
        {onCancel && <button type="button" className="btn-quiet" onClick={onCancel}>Cancel</button>}
        {error && <p className="text-[15px] text-fail">{error}</p>}
      </div>
    </form>
  );
}

const EVERIFY_LABEL: Record<EVerify, string> = { confirmed: "Confirmed", likely: "Likely", unknown: "Not checked" };

export function Companies({ onJobsChanged }: { onJobsChanged: () => void }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => api.listCompanies().then(setCompanies);
  useEffect(() => {
    load();
  }, []);

  async function setEVerify(c: Company, eVerify: EVerify) {
    const res = await api.updateCompany(c.id, { eVerify });
    setCompanies((all) => all.map((x) => (x.id === c.id ? res.company : x)));
    if (res.refilteredJobs > 0) {
      setNotice(`Re-checked ${res.refilteredJobs} ${res.refilteredJobs === 1 ? "job" : "jobs"} at ${c.name}.`);
      onJobsChanged();
    }
  }

  return (
    <section className="max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Companies</h1>
        <p className="max-w-2xl text-ink-soft">
          STEM OPT only allows employers enrolled in E-Verify. There's no API for it, so look each company up once in the{" "}
          <a className="font-medium text-accent underline underline-offset-2" href={E_VERIFY_SEARCH_URL} target="_blank" rel="noreferrer">
            E-Verify employer search
          </a>{" "}
          and record it here. Jobs at that company are re-checked when you do.
        </p>
      </header>

      {notice && <p className="rounded-md bg-pass-bg px-3 py-2 text-[15px] text-pass" role="status">{notice}</p>}

      <ul className="panel divide-y divide-line">
        {companies.map((c) => (
          <li key={c.id} className="p-4">
            {editing === c.id ? (
              <CompanyForm
                initial={c}
                submitLabel="Save company"
                onCancel={() => setEditing(null)}
                onSubmit={async (body) => {
                  const res = await api.updateCompany(c.id, body);
                  setCompanies((all) => all.map((x) => (x.id === c.id ? res.company : x)));
                  setEditing(null);
                }}
              />
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {c.website ? (
                      <a href={c.website} target="_blank" rel="noreferrer" className="hover:underline">{c.name}</a>
                    ) : (
                      c.name
                    )}
                    {c.warmContact && <span className="ml-2 text-sm font-medium text-accent">Warm contact</span>}
                  </p>
                  <p className="text-[15px] text-ink-soft">
                    {[c.atsType ? `${c.atsType}${c.atsBoardToken ? `: ${c.atsBoardToken}` : ""}` : "No job board set", ...c.tags].join(", ")}
                  </p>
                  {c.notes && <p className="text-sm text-ink-soft">{c.notes}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <label className="sr-only" htmlFor={`ev-${c.id}`}>E-Verify for {c.name}</label>
                  <select
                    id={`ev-${c.id}`}
                    className={`field w-auto py-1.5 ${c.eVerify === "unknown" ? "text-warn" : c.eVerify === "confirmed" ? "text-pass" : ""}`}
                    value={c.eVerify}
                    onChange={(e) => setEVerify(c, e.target.value as EVerify)}
                  >
                    {(Object.keys(EVERIFY_LABEL) as EVerify[]).map((k) => (
                      <option key={k} value={k}>E-Verify: {EVERIFY_LABEL[k]}</option>
                    ))}
                  </select>
                  <button className="btn-quiet py-1.5" onClick={() => setEditing(c.id)}>Edit</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="panel p-5">
        <h2 className="mb-4 text-lg font-semibold">Add a company</h2>
        <CompanyForm
          submitLabel="Add company"
          onSubmit={async (body) => {
            const c = await api.createCompany(body);
            setCompanies((all) => [...all, c].sort((a, b) => a.name.localeCompare(b.name)));
          }}
        />
      </div>
    </section>
  );
}
