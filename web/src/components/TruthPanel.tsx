import type { ReactNode } from "react";
import type { TruthIssue, TruthReport } from "../../../shared/types";

const KIND_LABEL: Record<TruthIssue["kind"], string> = {
  do_not_claim: "DO NOT CLAIM",
  unverified_number: "Number not in inventory",
  ownership: "Ownership",
  placeholder: "Placeholder",
  length: "Too long",
  banned_word: "Style",
  render: "PDF",
};

/**
 * Truth Check results: every failing line, where it is, and why. `fix` lets
 * the page put an edit box right under each problem.
 */
export function TruthPanel({ report, override, fix }: {
  report: TruthReport;
  override?: { reason: string } | null;
  fix?: (issue: TruthIssue) => ReactNode;
}) {
  const fails = report.issues.filter((i) => i.severity === "fail");
  const warns = report.issues.filter((i) => i.severity === "warn");
  return (
    <div className="space-y-3">
      <p className={`font-semibold ${report.pass ? "text-pass" : override ? "text-warn" : "text-fail"}`}>
        {report.pass
          ? "Truth Check passed: every number and claim traces to your inventory."
          : override
            ? `Truth Check overridden by you: "${override.reason}"`
            : `Truth Check: ${fails.length} ${fails.length === 1 ? "problem" : "problems"} to fix before this can be reviewed.`}
      </p>
      {[...fails, ...warns].length > 0 && (
        <ul className="space-y-3">
          {[...fails, ...warns].map((i, n) => (
            <li key={n} className="flex gap-3">
              <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${i.severity === "fail" ? "bg-fail" : "bg-warn"}`} />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm text-ink-soft">
                  <span className={`font-semibold ${i.severity === "fail" ? "text-fail" : "text-warn"}`}>{KIND_LABEL[i.kind]}</span>
                  {" in "}
                  {i.where}
                </p>
                {i.text && (
                  <p className="evidence">
                    <mark>{i.text}</mark>
                  </p>
                )}
                <p className="text-[15px]">{i.message}</p>
                {fix?.(i)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
