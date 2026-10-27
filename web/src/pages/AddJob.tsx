import { useEffect, useState } from "react";
import type { ExtractedFields, Job } from "../../../shared/types";
import { api, type FilterResult } from "../lib/api";
import { FieldsEditor } from "../components/FieldsEditor";
import { ReasonList, VerdictBadge } from "../components/Verdict";
import { ScoreBadge, ScoreBreakdownView } from "../components/Score";

type Posting = { companyName: string; title: string; location: string; url: string; postedAt: string; description: string };
const EMPTY: Posting = { companyName: "", title: "", location: "", url: "", postedAt: "", description: "" };

export function AddJob({ onSaved }: { onSaved: () => void }) {
  const [posting, setPosting] = useState<Posting>(EMPTY);
  const [fields, setFields] = useState<ExtractedFields | null>(null);
  const [preview, setPreview] = useState<FilterResult | null>(null);
  const [saved, setSaved] = useState<{ job: Job; duplicate: boolean } | null>(null);
  const [scoring, setScoring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof Posting) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setPosting((p) => ({ ...p, [k]: e.target.value }));
    // Changing the JD text invalidates the extraction; other fields just re-preview.
    if (k === "description") setFields(null);
  };

  // Live verdict while you review fields. Debounced so typing doesn't spam the server.
  useEffect(() => {
    if (!fields || !posting.companyName.trim() || !posting.title.trim()) return;
    const t = setTimeout(() => {
      api
        .preview({ companyName: posting.companyName, title: posting.title, location: posting.location, fields })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(t);
  }, [fields, posting.companyName, posting.title, posting.location]);

  async function readPosting(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.extract({ title: posting.title, location: posting.location, description: posting.description });
      setFields(res.fields);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!fields) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.createJob({ ...posting, fields });
      setSaved(res);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPosting(EMPTY);
    setFields(null);
    setPreview(null);
    setSaved(null);
    setError(null);
  }

  if (saved) {
    const { job, duplicate } = saved;
    return (
      <section className="max-w-3xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-[34px] leading-tight font-semibold tracking-tight">{duplicate ? "Already saved" : "Saved"}</h1>
          <p className="text-ink-soft">
            {duplicate
              ? "This company, title and location were already saved. Here's the existing job; nothing new was added."
              : "Stored with its hard-filter result."}
          </p>
        </header>
        <article className="panel space-y-5 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{job.title}</h2>
              <p className="text-ink-soft">
                {job.companyName}
                {job.location ? `, ${job.location}` : ""}
              </p>
            </div>
            <VerdictBadge pass={job.hardFilterPass} reasons={job.filterReasons} />
          </div>
          <ReasonList reasons={job.filterReasons} />
          {job.scoreBreakdown && (
            <div className="border-t border-line pt-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p className="font-semibold">{job.scoreBreakdown.whyFits}</p>
                <ScoreBadge score={job.fitScore} tier={job.tier} />
              </div>
              <ScoreBreakdownView b={job.scoreBreakdown} redFlags={job.redFlags} />
            </div>
          )}
        </article>
        {error && <p className="text-[15px] text-fail">{error}</p>}
        <div className="flex flex-wrap gap-3">
          {job.hardFilterPass && !job.scoreBreakdown && (
            <button
              className="btn-primary"
              disabled={scoring}
              onClick={async () => {
                setScoring(true);
                setError(null);
                try {
                  setSaved({ duplicate, job: await api.scoreJob(job.id) });
                  onSaved();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setScoring(false);
                }
              }}
            >
              {scoring ? "Scoring…" : "Score now"}
            </button>
          )}
          <button className={job.hardFilterPass && !job.scoreBreakdown ? "btn-quiet" : "btn-primary"} onClick={reset}>
            Add another job
          </button>
          <a className="btn-quiet" href="#/jobs">
            See all jobs
          </a>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <header className="max-w-2xl space-y-1">
        <h1 className="text-[34px] leading-tight font-semibold tracking-tight">Add a job</h1>
        <p className="text-ink-soft">
          Paste a posting from anywhere, including LinkedIn. The app reads it, you check what it found, then it runs the hard filters.
        </p>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <form onSubmit={readPosting} className="panel space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="company">Company</label>
              <input id="company" className="field" required value={posting.companyName} onChange={set("companyName")} />
            </div>
            <div>
              <label className="label" htmlFor="title">Job title</label>
              <input id="title" className="field" required value={posting.title} onChange={set("title")} />
            </div>
            <div>
              <label className="label" htmlFor="location">Location</label>
              <input id="location" className="field" placeholder="Chicago, IL or Remote - US" value={posting.location} onChange={set("location")} />
            </div>
            <div>
              <label className="label" htmlFor="posted">Date posted</label>
              <input id="posted" type="date" className="field" value={posting.postedAt} onChange={set("postedAt")} />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="url">Link to posting</label>
            <input id="url" type="url" className="field" placeholder="Saved for reference. The app doesn't open it." value={posting.url} onChange={set("url")} />
          </div>
          <div>
            <label className="label" htmlFor="jd">Job description</label>
            <textarea
              id="jd"
              required
              rows={16}
              className="field font-serif text-[15px] leading-relaxed"
              placeholder="Paste the full description, including requirements and the fine print at the bottom."
              value={posting.description}
              onChange={set("description")}
            />
          </div>
          {error && !fields && <p className="text-[15px] text-fail">{error}</p>}
          <button className="btn-primary" disabled={busy}>
            {fields ? "Read it again" : "Read posting"}
          </button>
        </form>

        <div className="lg:sticky lg:top-6">
          {!fields ? (
            <div className="rounded-lg border border-dashed border-line p-6 text-ink-soft">
              <p className="font-medium text-ink">Nothing to check yet</p>
              <p className="mt-1 text-[15px]">
                After you read the posting, what the app found shows here: years asked, sponsorship, location, and anything that rules
                it out under STEM OPT. Highlighted text is the line in the posting it came from.
              </p>
            </div>
          ) : (
            <div className="panel divide-y divide-line">
              <div className="space-y-4 p-5">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold">Verdict</h2>
                  {preview && <VerdictBadge pass={preview.pass} reasons={preview.reasons} />}
                </div>
                {preview ? <ReasonList reasons={preview.reasons} /> : <p className="text-ink-soft">Checking…</p>}
              </div>
              <div className="p-5">
                <h2 className="mb-1 text-lg font-semibold">What the app found</h2>
                <p className="mb-4 text-[15px] text-ink-soft">Fix anything it got wrong. The verdict updates as you edit.</p>
                <FieldsEditor value={fields} onChange={setFields} />
              </div>
              <div className="flex flex-wrap items-center gap-3 p-5">
                <button className="btn-primary" onClick={save} disabled={busy}>
                  Save job
                </button>
                {error && <p className="text-[15px] text-fail">{error}</p>}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
