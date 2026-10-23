import type { FilterReason } from "../../../shared/types";
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

export function VerdictBadge({ pass, reasons }: { pass: boolean; reasons: FilterReason[] }) {
  const fails = reasons.filter((r) => r.severity === "fail").length;
  const warns = reasons.length - fails;
  if (!pass) {
    return (
      <span className="inline-flex shrink-0 items-center rounded-md bg-fail-bg px-2 py-1 text-sm font-semibold text-fail">
        Fails {fails} {fails === 1 ? "filter" : "filters"}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-pass-bg px-2 py-1 text-sm font-semibold text-pass">
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
