import type { ApplicationStatus } from "../../../shared/types";

// Reading the job-search inbox, in plain code. Three questions per email:
//   1. Is it worth opening? (decided from the sender and subject alone)
//   2. Which application is it about?
//   3. What does it say? (rules first; the model only for what rules can't tell)
// Nothing here talks to the network, so all of it is tested directly.

export type Envelope = { messageId: string; fromAddress: string; fromName: string | null; subject: string; date: Date };
export type MailMessage = Envelope & { text: string };

/** An application that's been sent, with what's needed to recognise mail about it. */
export type MailApp = {
  id: number;
  status: ApplicationStatus;
  companyName: string;
  companyWebsite: string | null;
  jobTitle: string;
  submittedAt: Date | null;
};

export type MailKind = "received" | "rejection" | "assessment" | "screen" | "interview" | "offer" | "other";

/** Senders the ATSs use for candidate mail. Company names are in the subject or body. */
export const ATS_DOMAINS = [
  "greenhouse.io",
  "greenhouse-mail.io",
  "us.greenhouse-mail.io",
  "lever.co",
  "hire.lever.co",
  "ashbyhq.com",
  "ashby-mail.com",
  "myworkday.com",
  "workday.com",
  "smartrecruiters.com",
  "icims.com",
  "jobvite.com",
  "bamboohr.com",
  "rippling.com",
  "gem.com",
  "hackerrank.com",
  "codesignal.com",
  "calendly.com",
  "goodtime.io",
];

const lower = (s: string) => s.toLowerCase();
export const domainOf = (address: string) => lower(address.split("@")[1] ?? "").trim();

/** "https://www.anthropic.com/careers" → "anthropic.com" */
export function siteDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    const host = new URL(website.includes("://") ? website : `https://${website}`).hostname;
    return lower(host).replace(/^www\./, "");
  } catch {
    return null;
  }
}

const sameOrSub = (domain: string, root: string) => domain === root || domain.endsWith(`.${root}`);

/** Company names reduced to the words that identify them ("Scale AI, Inc." → "scale ai"). */
export function companyKey(name: string): string {
  return lower(name)
    .replace(/[,.]?\s+(inc|llc|ltd|corp|corporation|co|pbc|technologies|technology|labs)\.?$/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whole-word, case-insensitive. "Ramp" mustn't match "rampant". */
function mentions(haystack: string, needle: string): boolean {
  const n = companyKey(needle);
  if (n.length < 2) return false;
  const h = ` ${lower(haystack).replace(/[^a-z0-9]+/g, " ")} `;
  return h.includes(` ${n} `);
}

/**
 * Step 1: decide from the envelope whether to download the body at all. An
 * email from an ATS, from a company you applied to, or naming one in the
 * subject is worth opening; everything else in the inbox is left unread.
 */
export function worthOpening(env: Envelope, apps: MailApp[]): boolean {
  const d = domainOf(env.fromAddress);
  if (ATS_DOMAINS.some((root) => sameOrSub(d, root))) return true;
  return apps.some((a) => {
    const site = siteDomain(a.companyWebsite);
    return (site && sameOrSub(d, site)) || mentions(`${env.fromName ?? ""} ${env.subject}`, a.companyName);
  });
}

export type Match = { applicationId: number | null; candidateIds: number[] };

/**
 * Step 2: which application this is about. The company has to be identified
 * (sender domain, or its name in the sender, subject or body). If you applied
 * there more than once, the job title picks one; if it can't, the email is
 * linked to none and you choose.
 */
export function matchApplication(msg: MailMessage, apps: MailApp[]): Match {
  const d = domainOf(msg.fromAddress);
  const head = `${msg.fromName ?? ""} ${msg.subject}`;
  const all = `${head} ${msg.text}`;
  const atCompany = apps.filter((a) => {
    const site = siteDomain(a.companyWebsite);
    return (site && sameOrSub(d, site)) || mentions(head, a.companyName) || mentions(msg.text.slice(0, 1500), a.companyName);
  });
  // If several companies are named (a newsletter, say), take the one in the sender or subject.
  const companies = [...new Set(atCompany.map((a) => companyKey(a.companyName)))];
  const pool = companies.length > 1 ? atCompany.filter((a) => mentions(head, a.companyName) || sameOrSub(d, siteDomain(a.companyWebsite) ?? "\0")) : atCompany;
  if (pool.length === 0 || new Set(pool.map((a) => companyKey(a.companyName))).size > 1) return { applicationId: null, candidateIds: pool.map((a) => a.id) };
  if (pool.length === 1) return { applicationId: pool[0]!.id, candidateIds: [] };
  const byTitle = pool.filter((a) => lower(all).includes(lower(a.jobTitle)));
  if (byTitle.length === 1) return { applicationId: byTitle[0]!.id, candidateIds: [] };
  return { applicationId: null, candidateIds: pool.map((a) => a.id) };
}

// Step 3: what it says. Checked strongest first, so "thanks for applying...
// unfortunately we won't be moving forward" reads as a rejection, and
// "thank you for taking the time to interview... not moving forward" too.
const RULES: { kind: MailKind; patterns: RegExp[] }[] = [
  { kind: "offer", patterns: [/\b(pleased|happy|excited|delighted) to (extend|offer) (you )?(an |the |a )?offer\b/, /\boffer letter\b/, /\bverbal offer\b/] },
  {
    kind: "rejection",
    patterns: [
      /\b(not|won't|will not|unable to) (be )?(moving|move|proceed|proceeding|progress|progressing) (forward )?(with|in)? ?(your|the)/,
      /\bnot (be )?moving forward\b/,
      /\bdecided to (move forward|proceed|go forward|pursue) with (other|another)/,
      /\bpursue other candidates\b/,
      /\b(other|another) candidates? (whose|who|that)\b/,
      /\bposition has (been|now been) filled\b/,
      /\bno longer (being )?considered\b/,
      /\bnot (been )?selected\b/,
      /\bwill not be (offering|extending)\b/,
      /\bregret to inform\b/,
      /\bunfortunately,? (we|after|at this time|the team)\b/,
    ],
  },
  { kind: "assessment", patterns: [/\b(online|technical|coding) (assessment|challenge|exercise)\b/, /\btake[- ]home\b/, /\bhackerrank\b/, /\bcodesignal\b/, /\bcoderpad\b/] },
  {
    kind: "interview",
    patterns: [/\b(onsite|on-site|final round|virtual onsite|technical interview|panel interview|interview loop)\b/, /\binvite you to (an |the )?(next |final )?(round|interview)\b/, /\binterview (is )?(scheduled|confirmed)\b/],
  },
  {
    kind: "screen",
    patterns: [
      /\b(phone|recruiter|intro|introductory|initial) (screen|call|chat|conversation)\b/,
      /\b(schedule|set up|book) (a |some )?(time|call|chat|conversation)\b/,
      /\bshare (your|some) availability\b/,
      /\bwhat does your availability look like\b/,
      /\b(like|love|want) to (chat|speak|talk|connect) with you\b/,
      /\bcalendly\.com\b/,
    ],
  },
  {
    kind: "received",
    patterns: [/\b(received|receiving) your application\b/, /\bthanks? (you )?for (applying|your application|your interest in)\b/, /\bapplication (has been|was) (received|submitted)\b/, /\bwe('ve| have) (got|received) your\b/],
  },
];

export function classifyByRules(msg: Pick<MailMessage, "subject" | "text">): { kind: MailKind; phrase: string } | null {
  const text = lower(`${msg.subject}\n${msg.text}`).replace(/[’‘]/g, "'").replace(/\s+/g, " ");
  for (const r of RULES) {
    for (const p of r.patterns) {
      const m = p.exec(text);
      if (m) return { kind: r.kind, phrase: m[0] };
    }
  }
  return null;
}

/** Statuses in order, so a suggestion never moves an application backwards. */
const RANK: Partial<Record<ApplicationStatus, number>> = { approved: 0, submitted: 1, ghosted: 1, screen: 2, interview: 3, offer: 4 };
const TARGET: Partial<Record<MailKind, ApplicationStatus>> = { rejection: "rejected", assessment: "screen", screen: "screen", interview: "interview", offer: "offer" };

/**
 * The status change an email suggests for an application currently at
 * `status`, or null when it doesn't move anything (it's already there, or
 * it would be a step back, or the application has ended).
 */
export function suggestStatus(kind: MailKind, status: ApplicationStatus): ApplicationStatus | null {
  if (["rejected", "withdrawn", "offer"].includes(status)) return null;
  if (kind === "received") return status === "approved" ? "submitted" : null; // the receipt proves you sent it
  if (status === "approved") return null; // mark it submitted first
  const to = TARGET[kind];
  if (!to) return null;
  if (to === "rejected") return "rejected";
  return (RANK[to] ?? 0) > (RANK[status] ?? 0) ? to : null;
}

/** A short excerpt to show in the app: the start of the body, whitespace collapsed. */
export const snippetOf = (text: string, max = 400) => {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
