import { useState } from "react";
import { api } from "../lib/api";

/**
 * Accept = "I'll apply": prepares the application right away (tailored resume
 * for Tier A, base resume for Tier B), runs the Truth Check, and puts it in
 * Review. Tier A takes ~20–40s because of the tailoring call.
 */
export function AcceptButton({ jobId, tier, onDone, className = "btn-primary py-1.5" }: {
  jobId: number;
  tier: string | null;
  onDone: () => void;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "busy" | { id: number; ready: boolean } | { error: string }>("idle");

  if (typeof state === "object" && "id" in state) {
    return (
      <a className="btn-quiet py-1.5" href={`#/review?id=${state.id}`}>
        {state.ready ? "Ready to review" : "Needs fixes"}: open in Review
      </a>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        className={className}
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          try {
            const app = await api.prepare(jobId);
            setState({ id: app.id, ready: app.status === "ready_for_review" });
            onDone();
          } catch (e) {
            setState({ error: (e as Error).message });
          }
        }}
      >
        {state === "busy" ? (tier === "A" ? "Tailoring your resume…" : "Preparing…") : "Accept and prepare"}
      </button>
      {typeof state === "object" && "error" in state && (
        <span className="text-[15px] text-fail">
          {state.error}{" "}
          {/base resume/i.test(state.error) && <a className="font-medium text-accent underline underline-offset-2" href="#/settings/resumes">Open Resumes</a>}
        </span>
      )}
    </span>
  );
}
