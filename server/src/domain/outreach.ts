import type { ContactRelationship, OutreachStatus } from "../../../shared/types";

// Referral outreach rules, pure so they're testable. The app never touches
// linkedin.com: it drafts, opens the page in your browser, and keeps count.
// Every rule that protects your account or your reputation lives here in
// code, not in a prompt.

/** Connection-note limit on Premium (free accounts get 200). */
export const NOTE_LIMIT = 300;
/** Invite caps, counted from the app's own log. Well inside the 100-200/week range automation vendors report as safe. */
export const DAILY_INVITE_CAP = 20;
export const WEEKLY_INVITE_CAP = 80;
/** One follow-up, this many days after the ask. Then the app stops. */
export const FOLLOW_UP_AFTER_DAYS = 7;
/** Don't contact the same person about a different role within this window. */
export const NO_REPEAT_DAYS = 30;

/** How many people to find per role: 3 for Tier A, 1 for Tier B (only worth it when you know someone there). */
export const wantedContacts = (tier: "A" | "B" | null) => (tier === "A" ? 3 : 1);

export const ACTIVE: OutreachStatus[] = ["planned", "invited", "connected", "asked", "followed_up", "replied"];
export const ENDED: OutreachStatus[] = ["referred", "declined", "no_reply"];

/**
 * What you can do next from each status. "invite" = you sent the connection
 * request; "message" = you sent the ask (or the opener, with no role);
 * "follow_up" = the one follow-up. A 1st-degree connection skips the invite.
 */
export type OutreachAction = "invite" | "accepted" | "message" | "follow_up" | "replied" | "referred" | "declined" | "no_reply";

const NEXT: Record<OutreachAction, { from: OutreachStatus[]; to: OutreachStatus }> = {
  invite: { from: ["planned"], to: "invited" },
  accepted: { from: ["invited"], to: "connected" },
  message: { from: ["planned", "connected"], to: "asked" }, // planned → asked only for 1st-degree
  follow_up: { from: ["asked"], to: "followed_up" },
  replied: { from: ["invited", "connected", "asked", "followed_up"], to: "replied" },
  referred: { from: ["asked", "followed_up", "replied"], to: "referred" },
  declined: { from: ["invited", "connected", "asked", "followed_up", "replied"], to: "declined" },
  no_reply: { from: ["invited", "connected", "asked", "followed_up"], to: "no_reply" },
};

export class OutreachError extends Error {}

export function nextStatus(current: OutreachStatus, action: OutreachAction, relationship: ContactRelationship): OutreachStatus {
  const rule = NEXT[action];
  if (!rule.from.includes(current)) throw new OutreachError(`Can't do "${action.replace("_", " ")}" from "${current.replace("_", " ")}".`);
  if (action === "message" && current === "planned" && relationship !== "first_degree") {
    throw new OutreachError("Connect first. The referral ask goes in a message once they accept.");
  }
  if (action === "invite" && relationship === "first_degree") throw new OutreachError("You're already connected. Send the message instead.");
  return rule.to;
}

/** Invites sent today and in the last 7 days, against the caps. */
export function inviteBudget(invitedAt: Date[], now: Date, today: string, localDateOf: (d: Date) => string) {
  const week = invitedAt.filter((d) => now.getTime() - d.getTime() < 7 * 86_400_000).length;
  const day = invitedAt.filter((d) => localDateOf(d) === today).length;
  return { today: day, week, dailyCap: DAILY_INVITE_CAP, weeklyCap: WEEKLY_INVITE_CAP, left: Math.max(0, Math.min(DAILY_INVITE_CAP - day, WEEKLY_INVITE_CAP - week)) };
}

/**
 * linkedin.com/in/jane-doe-123/?trk=x → https://www.linkedin.com/in/jane-doe-123
 * Null if it isn't a profile link.
 */
export function normalizeProfileUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
  const m = /^\/in\/([^/]+)/i.exec(u.pathname);
  if (!m) return null;
  return `https://www.linkedin.com/in/${decodeURIComponent(m[1]!).toLowerCase()}`;
}

// ---- Lint: the "sounds like a person" rules ------------------------------------

const BANNED_PHRASES = [
  "hope this finds you well",
  "hope you're doing well",
  "hope you are doing well",
  "came across your profile",
  "i came across",
  "passionate",
  "leverage",
  "pick your brain",
  "excited to connect",
  "reaching out because",
  "i wanted to reach out",
  "synergy",
  "touch base",
  "circle back",
  "esteemed",
  "dear sir",
  "to whom it may concern",
  "i am writing to",
  "thrilled",
  "delve",
  "in today's",
];

export type LintIssue = { field: "note" | "ask" | "followUp"; severity: "fail" | "warn"; message: string };

export function lintOutreach(texts: { note: string; ask: string; followUp: string }, opts: { needsNote: boolean }): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const field of ["note", "ask", "followUp"] as const) {
    const text = texts[field];
    if (field === "note" && !opts.needsNote) continue;
    if (!text.trim()) {
      issues.push({ field, severity: "fail", message: "Empty." });
      continue;
    }
    const lower = text.toLowerCase();
    for (const p of BANNED_PHRASES) if (lower.includes(p)) issues.push({ field, severity: "fail", message: `"${p}" reads like a template. Say it plainly.` });
    if ((text.match(/!/g) ?? []).length > 1) issues.push({ field, severity: "warn", message: "More than one exclamation point." });
    if ((text.match(/—/g) ?? []).length > 1) issues.push({ field, severity: "warn", message: "Several em dashes. Use a period." });
    const ph = /\[[^\]]{1,40}\]|\{[^}]{1,40}\}/.exec(text);
    if (ph) issues.push({ field, severity: "fail", message: `Fill in ${ph[0]}.` });
  }
  if (opts.needsNote) {
    if (texts.note.length > NOTE_LIMIT) issues.push({ field: "note", severity: "fail", message: `${texts.note.length} characters. LinkedIn notes stop at ${NOTE_LIMIT}.` });
    if (/\brefer(ral|rals|ring)?\b/i.test(texts.note)) issues.push({ field: "note", severity: "fail", message: "Keep the referral ask out of the connection note. It goes in the message after they accept." });
  }
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  if (words(texts.ask) > 120) issues.push({ field: "ask", severity: "warn", message: `${words(texts.ask)} words. Under 100 gets read.` });
  if (words(texts.followUp) > 60) issues.push({ field: "followUp", severity: "warn", message: `${words(texts.followUp)} words. A follow-up should be two lines.` });
  return issues;
}

// ---- Where to look --------------------------------------------------------------

/**
 * LinkedIn people searches for one company, opened in your own browser. The
 * app can't run these for you (that would be scraping); you open them, pick
 * people, and paste their profile links back.
 */
export function searchLinks(companyName: string, jobTitle: string, school = "DePauw") {
  const q = (keywords: string, extra = "") => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}${extra}`;
  const co = `"${companyName}"`;
  const role = roleKeywords(jobTitle);
  return [
    { label: "People you know there", why: "1st-degree: no invite needed, best odds", url: q(co, `&network=${encodeURIComponent('["F"]')}`) },
    { label: `${school} alumni there`, why: "a real shared tie", url: q(`${co} ${school}`) },
    { label: "People in this role", why: "peers refer more readily than managers", url: q(`${co} ${role}`) },
    { label: "Recruiters there", why: "for the role's recruiter, if you can find them", url: q(`${co} technical recruiter`) },
  ];
}

/** "Senior Forward Deployed Engineer, Public Sector" → "forward deployed engineer" */
export function roleKeywords(title: string): string {
  const cleaned = title
    .split(/,|\(|\||\s[–-]\s/)[0]!
    .replace(/\b(senior|sr\.?|junior|jr\.?|staff|principal|lead|ii|iii|i|new grad|early career|entry level)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return cleaned || "software engineer";
}

// ---- LinkedIn acceptance emails (read from the 8pm inbox check) ------------------

/**
 * LinkedIn emails you when someone accepts. Only the subject is read (the body
 * is never downloaded). Returns the name it mentions, or null.
 */
export function acceptanceName(env: { fromAddress: string; subject: string }): string | null {
  if (!/@([a-z0-9-]+\.)*linkedin\.com$/i.test(env.fromAddress)) return null;
  const s = env.subject.trim();
  const patterns = [
    /^(.+?) (?:has )?accepted your invitation/i,
    /^you and (.+?) are now connected/i,
    /^(.+?) is now a connection/i,
    /start a conversation with your new connection,? (.+?)\.?$/i,
  ];
  for (const p of patterns) {
    const m = p.exec(s);
    if (m) return m[1]!.trim();
  }
  return null;
}

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/** The invited contact the name belongs to: full-name match, or a first name only one invite has. */
export function matchAcceptance<T extends { name: string }>(name: string, invited: T[]): T | null {
  const n = norm(name);
  const full = invited.filter((c) => norm(c.name) === n);
  if (full.length === 1) return full[0]!;
  if (full.length > 1) return null;
  if (n.includes(" ")) return null;
  const first = invited.filter((c) => norm(c.name).split(" ")[0] === n);
  return first.length === 1 ? first[0]! : null;
}
