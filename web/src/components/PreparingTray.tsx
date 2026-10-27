import { api } from "../lib/api";

export type Preparing = Awaited<ReturnType<typeof api.preparing>>[number];

/** Applications being prepared in the background, and any that failed. */
export function PreparingTray({ items, onChanged }: { items: Preparing[]; onChanged: () => void }) {
  if (items.length === 0) return null;
  const busy = items.filter((p) => !p.error);
  const failed = items.filter((p) => p.error);
  return (
    <div className="panel space-y-2 p-4 text-[15px]" role="status">
      {busy.length > 0 && (
        <p>
          Preparing {busy.length} application{busy.length === 1 ? "" : "s"} ({busy.map((p) => p.companyName).join(", ")}). Each one shows up in{" "}
          <a className="font-medium text-accent underline underline-offset-2" href="#/applications">Review</a> when it's ready (under Needs fixes if the Truth Check flags something), usually within a minute.
        </p>
      )}
      {failed.map((p) => (
        <div key={p.jobId} className="space-y-1">
          <p className="text-fail">
            {p.jobTitle} at {p.companyName} couldn't be prepared: {p.error}{" "}
            {/base resume/i.test(p.error ?? "") && (
              <a className="font-medium text-accent underline underline-offset-2" href="#/settings/resumes">Open Resumes</a>
            )}
          </p>
          <div className="flex gap-2">
            <button
              className="btn-quiet py-1"
              onClick={async () => {
                await api.prepareInBackground(p.jobId);
                onChanged();
              }}
            >
              Try again
            </button>
            <button
              className="btn-quiet py-1"
              onClick={async () => {
                await api.dismissPreparing(p.jobId);
                onChanged();
              }}
            >
              Put back in the deck
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
