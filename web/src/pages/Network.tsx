import { useCallback, useEffect, useRef, useState } from "react";
import type { ContactRelationship, NetworkRole, NetworkState, OutreachItem, OutreachStatus } from "../../../shared/types";
import { api } from "../lib/api";

// Referral outreach. The app drafts and keeps count; you send everything from
// LinkedIn yourself, then press the button that says you did. LinkedIn bans
// bots that connect or message, and your account matters more than the
// seconds saved.

const RELATIONSHIP_LABEL: Record<ContactRelationship, string> = {
  first_degree: "Already connected",
  alum: "DePauw alum",
  ex_colleague: "Worked together / same company before",
  team: "On the team or in the role",
  recruiter: "Recruiter",
  other: "No tie",
};

const STATUS_LABEL: Record<OutreachStatus, string> = {
  planned: "Not sent yet",
  invited: "Invite sent",
  connected: "Connected",
  asked: "Asked",
  followed_up: "Followed up",
  replied: "They replied",
  referred: "Referred you",
  declined: "Said no",
  no_reply: "No reply",
};

const FIELD_LABEL = { note: "Connection note", ask: "Message after they accept", followUp: "Follow-up (one, after a week)" } as const;

const day = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

function AutoText({ value, onSave, limit, disabled }: { value: string; onSave: (v: string) => void; limit?: number; disabled?: boolean }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);
  return (
    <div>
      <textarea ref={ref} className="field resize-none text-[15px] leading-relaxed" rows={2} value={text} disabled={disabled}
        onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onSave(text)} />
      {limit !== undefined && (
        <p className={`mt-1 text-right text-[12px] ${text.length > limit ? "text-fail" : "text-muted"}`}>{text.length} / {limit}</p>
      )}
    </div>
  );
}

function OutreachCard({ item, noteLimit, invitesLeft, onChanged }: { item: OutreachItem; noteLimit: number; invitesLeft: number; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const ended = ["referred", "declined", "no_reply"].includes(item.status);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const next = item.next;
  const blocked = next?.action === "invite" && invitesLeft === 0;
  const fields = (["note", "ask", "followUp"] as const).filter((f) => !(f === "note" && item.contact.relationship === "first_degree"));
  // Only the message for the next step; waiting cards stay folded until you ask.
  const shown = showAll ? fields : next ? fields.filter((f) => f === next.text) : [];

  async function copyAndOpen() {
    if (!next) return;
    try {
      await navigator.clipboard.writeText(item[next.text]);
      setCopied(true);
    } catch {
      setError("Couldn't copy. Select the text and copy it yourself.");
    }
    window.open(item.contact.linkedinUrl, "_blank", "noopener");
  }

  return (
    <li className="panel space-y-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <a className="font-semibold text-ink hover:underline" href={item.contact.linkedinUrl} target="_blank" rel="noreferrer">{item.contact.name}</a>
          <span className="text-sm text-muted"> · {RELATIONSHIP_LABEL[item.contact.relationship]}</span>
          {item.contact.headline && <p className="text-sm text-ink-soft">{item.contact.headline}</p>}
        </div>
        <div className="text-right text-[13px] text-muted">
          <p className="font-medium text-ink-soft">{STATUS_LABEL[item.status]}{item.connectedVia === "inbox" && item.status === "connected" ? " (from your inbox)" : ""}</p>
          {item.application ? <p>{item.application.companyName}, {item.application.jobTitle}</p> : <p>Networking, no role</p>}
          {item.status === "asked" && item.followUpDue && <p>Follow-up {item.followUpDue}</p>}
          {item.invitedAt && item.status === "invited" && <p>Invited {day(item.invitedAt)}</p>}
        </div>
      </div>

      {!ended &&
        shown.map((f) => {
          const issues = item.issues.filter((i) => i.field === f);
          return (
            <div key={f} className="space-y-1">
              <p className="label">{FIELD_LABEL[f]}</p>
              <AutoText value={item[f]} limit={f === "note" ? noteLimit : undefined} disabled={busy} onSave={(v) => void act(() => api.editOutreach(item.id, { [f]: v }))} />
              {issues.map((i, n) => (
                <p key={n} className={`text-[13px] ${i.severity === "fail" ? "text-fail" : "text-warn"}`}>{i.message}</p>
              ))}
            </div>
          );
        })}

      {!ended && (
        <div className="flex flex-wrap items-center gap-3">
          {next && (
            <>
              <button className="btn-primary py-1.5 text-sm" disabled={busy || blocked} onClick={() => void copyAndOpen()}>
                {next.action === "invite" ? "Copy note, open profile" : "Copy message, open profile"}
              </button>
              <button className="btn-quiet py-1.5 text-sm" disabled={busy || blocked} onClick={() => act(() => api.advanceOutreach(item.id, next.action))}>
                {next.action === "invite" ? "I sent the request" : next.action === "follow_up" ? "I sent the follow-up" : "I sent it"}
              </button>
            </>
          )}
          {item.status === "invited" && (
            <button className="btn-quiet py-1.5 text-sm" disabled={busy} onClick={() => act(() => api.advanceOutreach(item.id, "accepted"))}>They accepted</button>
          )}
          {["invited", "connected", "asked", "followed_up"].includes(item.status) && (
            <button className="btn-quiet py-1.5 text-sm" disabled={busy} onClick={() => act(() => api.advanceOutreach(item.id, "replied"))}>They replied</button>
          )}
          {["asked", "followed_up", "replied"].includes(item.status) && item.application && (
            <button className="btn-quiet py-1.5 text-sm" disabled={busy} onClick={() => act(() => api.advanceOutreach(item.id, "referred"))}>They referred me</button>
          )}
          {item.status !== "planned" && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted">Close it</summary>
              <div className="mt-2 flex gap-2">
                <button className="btn-quiet py-1 text-sm" disabled={busy} onClick={() => act(() => api.advanceOutreach(item.id, "declined"))}>They said no</button>
                {item.status !== "replied" && (
                  <button className="btn-quiet py-1 text-sm" disabled={busy} onClick={() => act(() => api.advanceOutreach(item.id, "no_reply"))}>No reply</button>
                )}
              </div>
            </details>
          )}
          <span className="flex-1" />
          {(next ? fields.length > 1 : fields.length > 0) && (
            <button className="link text-sm" onClick={() => setShowAll(!showAll)}>{showAll ? (next ? "Show just this step" : "Hide messages") : "See all messages"}</button>
          )}
          <button className="link text-sm" disabled={busy} onClick={() => act(() => api.redraftOutreach(item.id))}>{busy ? "Working…" : "Redraft"}</button>
          {item.status === "planned" && (
            <button className="link text-sm text-fail" disabled={busy} onClick={() => act(() => api.removeOutreach(item.id))}>Remove</button>
          )}
        </div>
      )}
      {copied && next && (
        <p className="text-[13px] text-pass">
          Copied. {next.action === "invite" ? "On their profile: Connect → Add a note → paste → Send. Then come back and press \"I sent the request\"." : "On their profile: Message → paste → Send. Then press \"I sent it\"."}
        </p>
      )}
      {blocked && <p className="text-[13px] text-warn">Invite limit reached. Send this one tomorrow.</p>}
      {error && <p className="text-sm text-fail">{error}</p>}
    </li>
  );
}

function AddPerson({ applicationId, onAdded, drafting }: { applicationId: number | null; onAdded: () => void; drafting: NetworkState["drafting"] }) {
  const empty = { linkedinUrl: "", name: "", headline: "", relationship: "team" as ContactRelationship, about: "" };
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3 rounded-lg border border-line bg-paper p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.addContact({ applicationId, linkedinUrl: f.linkedinUrl, name: f.name, headline: f.headline || null, relationship: f.relationship, about: f.about || null });
          setF(empty);
          onAdded();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Their profile link</label>
          <input className="field" placeholder="linkedin.com/in/…" value={f.linkedinUrl} onChange={(e) => setF({ ...f, linkedinUrl: e.target.value })} required />
        </div>
        <div>
          <label className="label">Name</label>
          <input className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </div>
        <div>
          <label className="label">Headline</label>
          <input className="field" placeholder="Forward Deployed Engineer at …" value={f.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} />
        </div>
        <div>
          <label className="label">How you're connected</label>
          <select className="field" value={f.relationship} onChange={(e) => setF({ ...f, relationship: e.target.value as ContactRelationship })}>
            {(Object.keys(RELATIONSHIP_LABEL) as ContactRelationship[]).map((r) => (
              <option key={r} value={r}>{RELATIONSHIP_LABEL[r]}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label">One real thing about them (optional, makes the note better)</label>
        <textarea className="field text-[15px]" rows={2} placeholder="e.g. posted about how their team runs pilots; DePauw '19; paste their About section"
          value={f.about} onChange={(e) => setF({ ...f, about: e.target.value })} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary py-1.5 text-sm" disabled={busy}>{busy ? "Drafting…" : "Add and draft"}</button>
        {!drafting.available && <span className="text-[13px] text-warn">Drafting is off ({drafting.reason}). You can still add people and write the messages.</span>}
        {error && <span className="text-sm text-fail">{error}</span>}
      </div>
    </form>
  );
}

function RoleRow({ role, open, onToggle, onAdded, drafting }: { role: NetworkRole; open: boolean; onToggle: () => void; onAdded: () => void; drafting: NetworkState["drafting"] }) {
  const done = role.found >= role.wanted;
  return (
    <li className="border-t border-line py-3 first:border-0">
      <button className="flex w-full flex-wrap items-baseline justify-between gap-2 text-left" onClick={onToggle}>
        <span>
          <span className="font-medium text-ink">{role.companyName}</span>
          <span className="text-ink-soft">, {role.jobTitle}</span>
          {role.tier && <span className="chip ml-2">Tier {role.tier}</span>}
        </span>
        <span className={`text-[13px] ${done ? "text-pass" : "text-muted"}`}>
          {role.found} of {role.wanted} {role.wanted === 1 ? "person" : "people"}{role.tier === "B" && !done ? " (only if you know someone)" : ""} {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {role.searches.map((s) => (
              <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="rounded-md border border-line px-3 py-2 hover:border-line-strong">
                <span className="text-sm font-medium text-accent-ink">{s.label} ↗</span>
                <span className="block text-[13px] text-muted">{s.why}</span>
              </a>
            ))}
          </div>
          <p className="text-[13px] text-muted">Open a search, pick someone worth talking to, and paste their link here. Start with people you know, then alumni, then peers in the role.</p>
          <AddPerson applicationId={role.applicationId} onAdded={onAdded} drafting={drafting} />
        </div>
      )}
    </li>
  );
}

export function Network() {
  const [state, setState] = useState<NetworkState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRole, setOpenRole] = useState<number | null>(null);
  const [openGeneral, setOpenGeneral] = useState(false);
  const load = useCallback(() => api.network().then(setState).catch((e) => setError((e as Error).message)), []);
  useEffect(() => void load(), [load]);

  if (error) return <p className="text-fail">{error}</p>;
  if (!state) return <p className="text-muted">Loading…</p>;

  const waiting = state.outreach.filter((o) => !o.next && ["invited", "asked", "followed_up", "replied", "connected"].includes(o.status));
  const closed = state.outreach.filter((o) => ["referred", "declined", "no_reply"].includes(o.status));
  const referred = closed.filter((o) => o.status === "referred").length;
  const card = (o: OutreachItem) => <OutreachCard key={o.id} item={o} noteLimit={state.noteLimit} invitesLeft={state.invites.left} onChanged={() => void load()} />;
  const needPeople = state.roles.filter((r) => r.found < r.wanted && r.tier === "A").length;

  return (
    <div className="max-w-4xl space-y-8">
      <header className="space-y-1">
        <h1 className="text-[34px] leading-tight font-semibold tracking-tight">Network</h1>
        <p className="text-ink-soft">The app finds the right people with you and drafts the messages. You send them from LinkedIn yourself.</p>
        <p className="text-[13px] text-muted">
          Invites: {state.invites.today} of {state.invites.dailyCap} today · {state.invites.week} of {state.invites.weeklyCap} this week
          {referred ? ` · ${referred} referral${referred === 1 ? "" : "s"} so far` : ""}
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Do now {state.due.length ? <span className="text-muted">({state.due.length})</span> : null}</h2>
        {state.due.length ? <ul className="space-y-3">{state.due.map(card)}</ul> : <p className="text-[15px] text-muted">Nothing to send. Add people for a role below.</p>}
      </section>

      <section className="panel space-y-2 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Find people</h2>
          <p className="text-[13px] text-muted">{needPeople ? `${needPeople} Tier A role${needPeople === 1 ? "" : "s"} still need people` : "Every Tier A role has its 3"}</p>
        </div>
        {state.roles.length ? (
          <ul>
            {state.roles.map((r) => (
              <RoleRow key={r.applicationId} role={r} open={openRole === r.applicationId} onToggle={() => setOpenRole(openRole === r.applicationId ? null : r.applicationId)}
                onAdded={() => void load()} drafting={state.drafting} />
            ))}
          </ul>
        ) : (
          <p className="text-[15px] text-muted">No open applications yet. Roles show up here once an application is prepared.</p>
        )}
        <div className="border-t border-line pt-3">
          <button className="link text-sm" onClick={() => setOpenGeneral(!openGeneral)}>{openGeneral ? "Hide" : "Add someone you'd like to know, not for a specific role"}</button>
          {openGeneral && <div className="mt-3"><AddPerson applicationId={null} onAdded={() => void load()} drafting={state.drafting} /></div>}
        </div>
      </section>

      {waiting.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Waiting on them <span className="text-muted">({waiting.length})</span></h2>
          <p className="text-[13px] text-muted">Acceptances show up here on their own after the 8pm inbox check, if LinkedIn emails your job-search inbox.</p>
          <ul className="space-y-3">{waiting.map(card)}</ul>
        </section>
      )}

      {closed.length > 0 && (
        <details className="space-y-3">
          <summary className="cursor-pointer text-lg font-semibold">Closed <span className="text-muted">({closed.length})</span></summary>
          <ul className="mt-3 space-y-3">{closed.map(card)}</ul>
        </details>
      )}
    </div>
  );
}

/** On Today: what's due in Network, in one line. Hidden when nothing is. */
export function NetworkCard({ state }: { state: NetworkState | null }) {
  if (!state) return null;
  const due = state.due.length;
  const need = state.roles.filter((r) => r.tier === "A" && r.found < r.wanted).length;
  if (!due && !need) return null;
  const parts = [
    due ? `${due} message${due === 1 ? "" : "s"} to send` : null,
    need ? `${need} Tier A role${need === 1 ? "" : "s"} need people for referrals` : null,
  ].filter(Boolean);
  return (
    <section className="panel flex flex-wrap items-center justify-between gap-3 p-5">
      <p className="text-[15px] text-ink"><span className="font-semibold">Networking:</span> {parts.join(" · ")}</p>
      <a className="btn-quiet py-1.5 text-sm" href="#/network">Open Network</a>
    </section>
  );
}
