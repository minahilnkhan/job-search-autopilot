import type { ScoreBreakdown, Tier } from "../../../shared/types";

const TIER_STYLE: Record<Tier, string> = {
  A: "bg-accent-bg text-accent-ink",
  B: "bg-paper text-ink-soft",
  skip: "bg-paper text-muted",
};

export function ScoreBadge({ score, tier }: { score: number | null; tier: Tier | null }) {
  if (score === null || tier === null) return null;
  return (
    <span className={`inline-flex shrink-0 items-baseline gap-1 rounded-full px-3 py-1 text-[13px] font-semibold ${TIER_STYLE[tier]}`}>
      {tier === "skip" ? "Skip" : `Tier ${tier}`} · {score}/10
    </span>
  );
}

const MET_LABEL = { yes: "Met", partial: "Partly", no: "Not met" } as const;
const MET_STYLE = { yes: "text-pass", partial: "text-warn", no: "text-fail" } as const;

function Part({ label, value, max, children }: { label: string; value: number; max: number; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-12 shrink-0 text-right font-semibold tabular-nums">
        {value}<span className="font-normal text-ink-soft">/{max}</span>
      </span>
      <div className="min-w-0">
        <p className="font-medium">{label}</p>
        {children && <div className="text-[15px] text-ink-soft">{children}</div>}
      </div>
    </div>
  );
}

/** The mentor rubric, line by line: what the AI judged and what code added. */
export function ScoreBreakdownView({ b, redFlags }: { b: ScoreBreakdown; redFlags: string[] }) {
  return (
    <div className="space-y-4">
      <Part label="Requirements match" value={b.requirementsMatch} max={4}>
        <ul className="mt-1.5 space-y-1.5">
          {b.requirements.map((r, i) => (
            <li key={i} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
              <span className={`font-medium ${MET_STYLE[r.met]}`}>{MET_LABEL[r.met]}</span>
              <span>
                <span className="text-ink">{r.requirement}</span>
                {r.evidence && <span className="block font-serif text-[14px]">{r.evidence}</span>}
              </span>
            </li>
          ))}
        </ul>
      </Part>
      <Part label="Role signal" value={b.roleSignal} max={2}>{b.roleSignalReason}</Part>
      <Part label="Stack match" value={b.stackMatch} max={2}>{b.stackMatchReason}</Part>
      <Part label="Strategic bonus" value={b.strategicBonus} max={2}>
        {b.strategicReasons.length ? b.strategicReasons.join(". ") + "." : "None of AI-native, focus domain, H-1B history, or a warm contact."}
      </Part>
      {(b.tierCap || redFlags.length > 0) && (
        <ul className="space-y-1 border-t border-line pt-3 text-[15px]">
          {b.tierCap && <li className="text-warn">{b.tierCap}</li>}
          {redFlags.map((f, i) => (
            <li key={i} className="text-fail">Red flag: {f}</li>
          ))}
        </ul>
      )}
      <p className="text-sm text-ink-soft">Judged by {b.model}; totals and tiers computed in code.</p>
    </div>
  );
}
