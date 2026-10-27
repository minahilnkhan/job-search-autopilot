import { useState } from "react";
import type { FilterReason, Job } from "../../../shared/types";
import { api } from "../lib/api";
import { Evidence } from "./Evidence";

/** Linkify bare URLs in a reason message (the E-Verify search link). */
function Message({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="font-medium text-accent underline underline-offset-2">
            E-Verify employer search
          </a>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

export function VerdictBadge({ pass, reasons, overridden = false }: { pass: boolean; reasons: FilterReason[]; overridden?: boolean }) {
  const fails = reasons.filter((r) => r.severity === "fail").length;
  const warns = reasons.length - fails;
  if (overridden && fails > 0) {
    return <span className="chip shrink-0 bg-warn-bg font-semibold text-warn">Continued anyway</span>;
  }
  if (!pass) {
    return (
      <span className="chip shrink-0 bg-fail-bg font-semibold text-fail">
        Fails {fails} {fails === 1 ? "filter" : "filters"}
      </span>
    );
  }
  return (
    <span className="chip shrink-0 gap-1.5 bg-pass-bg font-semibold text-pass">
      Passes
      {warns > 0 && <span className="font-medium text-warn">({warns} to check)</span>}
    </span>
  );
}

export function ReasonList({ reasons }: { reasons: FilterReason[] }) {
  if (reasons.length === 0) {
    return <p className="text-[15px] text-pass">Clears every hard filter. Nothing to check.</p>;
  }
  // Fails first, then warnings.
  const sorted = [...reasons].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1));
  return (
    <ul className="space-y-3">
      {sorted.map((r, i) => (
        <li key={`${r.code}-${i}`} className="flex gap-3">
          <span
            aria-hidden
            className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${r.severity === "fail" ? "bg-fail" : "bg-warn"}`}
          />
          <div className="min-w-0 space-y-1">
            <p className="text-[15px] leading-snug">
              <span className={`sr-only`}>{r.severity === "fail" ? "Fail: " : "Check: "}</span>
              <Message text={r.message} />
            </p>
            <Evidence text={r.evidence} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Continue anyway": go ahead with a job despite a failed hard filter. The
 * reasons stay visible; it's your call. Undo puts the filters back in charge.
 */
export function ContinueAnyway({ jobId, overridden, onChange }: { jobId: number; overridden: boolean; onChange: (j: Job) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={overridden ? "btn-quiet" : "btn-dark"}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          onChange(await api.continueAnyway(jobId, !overridden));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Saving…" : overridden ? "Undo Continue anyway" : "Continue anyway →"}
    </button>
  );
}
