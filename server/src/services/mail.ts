import { and, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "../db/client";
import { applications, companies, emailMessages, jobs, mailChecks } from "../db/schema";
import { classifyByRules, matchApplication, snippetOf, suggestStatus, worthOpening, type MailApp, type MailKind } from "../domain/mailMatch";
import type { MailSource } from "../mail/imap";
import type { EmailClassifier } from "../llm/classifyEmail";
import { ScoreError } from "../llm/scoreJob";
import { recordUsage } from "./usage";
import { getSettings, localDate, localTime } from "./settings";
import { markSubmitted, setTrackedStatus } from "./submissions";
import { ConflictError, NotFoundError } from "./jobs";
import { addDays } from "../domain/week";
import { acceptanceName } from "../domain/outreach";
import { hasPendingInvites, recordAcceptances } from "./network";
import type { ApplicationStatus, InboxItem, InboxState, Settings } from "../../../shared/types";

// The once-a-day inbox check. It reads mail since the last check, keeps only
// what's about an application you've sent, works out what each email means,
// and turns that into a suggested status change for you to accept.
//
// The one thing it records on its own is "application received", because that
// changes nothing you'd act on. Rejections, screens, interviews and offers
// always wait for you: a misread email that quietly closed a live application
// would be worse than no automation at all.

export type MailDeps = {
  getSource?: () => { source: MailSource; address: string } | { unavailable: string };
  getClassifier?: (s: Settings) => { classify: EmailClassifier } | { unavailable: string };
};

/** When the daily check runs (local time in your timezone). */
export const MAIL_CHECK_AT = "20:00";
/** How far back the first check looks. */
export const FIRST_LOOKBACK_DAYS = 30;

// Applications the inbox can say something about: approved (you may have sent
// it without marking it) through interviewing.
const WATCHED: ApplicationStatus[] = ["approved", "submitted", "screen", "interview", "ghosted"];

function watchedApps(db: DB): MailApp[] {
  return db
    .select({
      id: applications.id,
      status: applications.status,
      companyName: companies.name,
      companyWebsite: companies.website,
      jobTitle: jobs.title,
      submittedAt: applications.submittedAt,
    })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(inArray(applications.status, WATCHED))
    .all();
}

function lastOkCheck(db: DB) {
  return db.select().from(mailChecks).where(eq(mailChecks.status, "ok")).orderBy(desc(mailChecks.id)).limit(1).get();
}

/**
 * Catch-up rule, pure so it's testable: the check is due if the most recent
 * 8pm has passed since the last successful check. A laptop asleep at 8pm
 * checks when the app next starts; it still checks once a day, not more.
 */
export function mailCheckDue(args: { today: string; timeNow: string; at: string; lastCheck: { date: string; time: string } | null }): boolean {
  if (!args.lastCheck) return true;
  const latest = args.timeNow >= args.at ? `${args.today} ${args.at}` : `${addDays(args.today, -1)} ${args.at}`;
  return `${args.lastCheck.date} ${args.lastCheck.time}` < latest;
}

export function isMailCheckDue(db: DB, now = new Date()): boolean {
  const tz = getSettings(db).pipeline.timezone;
  const last = lastOkCheck(db);
  return mailCheckDue({
    today: localDate(now, tz),
    timeNow: localTime(now, tz),
    at: MAIL_CHECK_AT,
    lastCheck: last ? { date: localDate(last.startedAt, tz), time: localTime(last.startedAt, tz) } : null,
  });
}

let running = false;

export async function runMailCheck(db: DB, deps: MailDeps, trigger: "schedule" | "catch_up" | "manual", now = new Date()) {
  const src = deps.getSource?.();
  if (!src) throw new ConflictError("Inbox checking isn't set up.");
  if ("unavailable" in src) throw new ConflictError(src.unavailable);
  if (running) throw new ConflictError("An inbox check is already running.");
  running = true;

  const check = db.insert(mailChecks).values({ trigger, startedAt: now, status: "running" }).returning().get();
  const stats = { scanned: 0, matched: 0, suggestions: 0, recorded: 0, costUsd: 0, connected: 0 };
  try {
    const last = lastOkCheck(db);
    // A day of overlap: IMAP's SINCE is by date, and duplicates are dropped by Message-ID.
    const since = last ? new Date(last.startedAt.getTime() - 24 * 3600_000) : new Date(now.getTime() - FIRST_LOOKBACK_DAYS * 24 * 3600_000);
    const apps = watchedApps(db);
    const invites = hasPendingInvites(db);
    if (apps.length === 0 && !invites) {
      db.update(mailChecks).set({ status: "ok", finishedAt: new Date(), stats }).where(eq(mailChecks.id, check.id)).run();
      return { ...stats, note: "No sent applications to watch yet." };
    }

    // LinkedIn's "accepted your invitation" emails are read by subject only;
    // their bodies are never downloaded.
    const accepted: string[] = [];
    const { scanned, messages } = await src.source(since, (env) => {
      const name = invites ? acceptanceName(env) : null;
      if (name) {
        accepted.push(name);
        return false;
      }
      return apps.length > 0 && worthOpening(env, apps);
    });
    stats.scanned = scanned;
    stats.connected = recordAcceptances(db, accepted, now);
    const settings = getSettings(db);
    const classifier = deps.getClassifier?.(settings);

    for (const msg of messages) {
      if (db.select({ id: emailMessages.id }).from(emailMessages).where(eq(emailMessages.messageId, msg.messageId)).get()) continue;
      const match = matchApplication(msg, apps);
      if (match.applicationId === null && match.candidateIds.length === 0) continue; // not about anything you sent

      // What it says: rules first, the model only for what they can't place.
      let kind: MailKind = "other";
      let kindSource: "rule" | "model" = "rule";
      let kindReason: string | null = null;
      const byRule = classifyByRules(msg);
      if (byRule) {
        kind = byRule.kind;
        kindReason = `"${byRule.phrase}"`;
      } else if (classifier && "classify" in classifier) {
        const app = apps.find((a) => a.id === (match.applicationId ?? match.candidateIds[0]))!;
        try {
          const r = await classifier.classify({ companyName: app.companyName, jobTitle: app.jobTitle, from: msg.fromAddress, subject: msg.subject, text: msg.text });
          stats.costUsd += recordUsage(db, { purpose: "mail_classify", model: r.model, usage: r.usage, now }) ?? 0;
          kind = r.kind;
          kindSource = "model";
          kindReason = r.reason;
          if (kind === "other") continue; // a newsletter or a generic update: not worth keeping
        } catch (err) {
          if (err instanceof ScoreError && err.usage) stats.costUsd += recordUsage(db, { purpose: "mail_classify", model: settings.models.scoring, usage: err.usage, now }) ?? 0;
          kindReason = "Couldn't tell what this says. Open it to check.";
        }
      } else {
        kindReason = "Couldn't tell what this says. Open it to check.";
      }

      const app = match.applicationId !== null ? apps.find((a) => a.id === match.applicationId)! : null;
      const suggested = app ? suggestStatus(kind, app.status) : null;
      let state: "pending" | "auto" | "info";
      if (app && kind === "received" && !suggested) state = "auto"; // the receipt for something already marked sent
      else if (app && !suggested && kind !== "other") state = "info"; // e.g. a second rejection email; nothing to change
      else if (!app && kind === "received") state = "info";
      else state = "pending";

      db.insert(emailMessages)
        .values({
          messageId: msg.messageId,
          fromAddress: msg.fromAddress,
          fromName: msg.fromName,
          subject: msg.subject || "(no subject)",
          receivedAt: msg.date,
          snippet: snippetOf(msg.text),
          applicationId: app?.id ?? null,
          candidateIds: app ? null : match.candidateIds,
          kind,
          kindSource,
          kindReason,
          suggestedStatus: suggested,
          state,
          decidedAt: state === "auto" ? now : null,
        })
        .run();
      stats.matched++;
      if (state === "pending") stats.suggestions++;
      if (state === "auto") stats.recorded++;
    }

    db.update(mailChecks).set({ status: "ok", finishedAt: new Date(), stats }).where(eq(mailChecks.id, check.id)).run();
    return stats;
  } catch (err) {
    const message = err instanceof ConflictError ? err.message : (err as Error).message;
    db.update(mailChecks).set({ status: "failed", finishedAt: new Date(), stats, error: message }).where(eq(mailChecks.id, check.id)).run();
    throw new ConflictError(`Inbox check failed: ${message}`);
  } finally {
    running = false;
  }
}

const KIND_LABEL: Record<MailKind, string> = {
  received: "Application received",
  rejection: "Rejection",
  assessment: "Online assessment",
  screen: "Recruiter screen",
  interview: "Interview",
  offer: "Offer",
  other: "Unclear",
};

function toItem(db: DB, row: typeof emailMessages.$inferSelect, address: string | null = null): InboxItem {
  const ids = row.applicationId ? [row.applicationId] : (row.candidateIds ?? []);
  const apps = ids.length
    ? db
        .select({ id: applications.id, status: applications.status, companyName: companies.name, jobTitle: jobs.title })
        .from(applications)
        .innerJoin(jobs, eq(jobs.id, applications.jobId))
        .innerJoin(companies, eq(companies.id, jobs.companyId))
        .where(inArray(applications.id, ids))
        .all()
    : [];
  const app = row.applicationId ? apps.find((a) => a.id === row.applicationId) : undefined;
  return {
    id: row.id,
    from: row.fromName ? `${row.fromName} <${row.fromAddress}>` : row.fromAddress,
    subject: row.subject,
    receivedAt: row.receivedAt.getTime(),
    snippet: row.snippet,
    kind: row.kind,
    kindLabel: KIND_LABEL[row.kind],
    kindSource: row.kindSource,
    kindReason: row.kindReason,
    // Recomputed from the application's status now, in case it moved since the check.
    suggestedStatus: row.state === "pending" && app ? suggestStatus(row.kind, app.status) : row.suggestedStatus,
    state: row.state,
    application: app ? { id: app.id, status: app.status, companyName: app.companyName, jobTitle: app.jobTitle } : null,
    candidates: row.applicationId ? [] : apps.map((a) => ({ id: a.id, status: a.status, companyName: a.companyName, jobTitle: a.jobTitle })),
    // authuser opens the right account when you're signed in to more than one.
    gmailUrl: `https://mail.google.com/mail/${address ? `?authuser=${encodeURIComponent(address)}` : "u/0/"}#search/${encodeURIComponent(`rfc822msgid:${row.messageId}`)}`,
  };
}

export function inboxState(db: DB, deps: MailDeps): InboxState {
  const src = deps.getSource?.();
  const lastRow = db.select().from(mailChecks).where(inArray(mailChecks.status, ["ok", "failed"])).orderBy(desc(mailChecks.id)).limit(1).get();
  const pending = db.select().from(emailMessages).where(eq(emailMessages.state, "pending")).orderBy(desc(emailMessages.receivedAt)).all();
  const recent = db
    .select()
    .from(emailMessages)
    .where(inArray(emailMessages.state, ["auto", "accepted", "info"]))
    .orderBy(desc(emailMessages.receivedAt))
    .limit(10)
    .all();
  const settings = getSettings(db);
  const address = src && "address" in src ? src.address : null;
  return {
    configured: !!src && "source" in src,
    unavailable: src && "unavailable" in src ? src.unavailable : null,
    address,
    // Applications are filled from the Settings email; if that's a different address, replies won't land here.
    fillsWithOtherAddress: !!address && !!settings.profile.email && settings.profile.email.trim().toLowerCase() !== address.toLowerCase() ? settings.profile.email : null,
    checkAt: MAIL_CHECK_AT,
    lastCheck: lastRow
      ? { at: lastRow.startedAt.getTime(), status: lastRow.status as "ok" | "failed", error: lastRow.error, stats: lastRow.stats ?? null }
      : null,
    running,
    pending: pending.map((r) => toItem(db, r, address)),
    recent: recent.map((r) => toItem(db, r, address)),
  };
}

/**
 * You agreed with a suggestion. For an email that could be about more than one
 * application, `applicationId` says which. The change goes through the same
 * status rules as changing it by hand.
 */
export function acceptSuggestion(db: DB, id: number, applicationId?: number, now = new Date()) {
  const row = db.select().from(emailMessages).where(eq(emailMessages.id, id)).get();
  if (!row) throw new NotFoundError(`Email ${id} not found`);
  if (row.state !== "pending") throw new ConflictError("This email has already been handled.");
  const appId = row.applicationId ?? applicationId;
  if (!appId) throw new ConflictError("Choose which application this email is about.");
  if (!row.applicationId && !(row.candidateIds ?? []).includes(appId)) throw new ConflictError("That application isn't one this email could be about.");
  const app = db.select({ status: applications.status }).from(applications).where(eq(applications.id, appId)).get();
  if (!app) throw new NotFoundError(`Application ${appId} not found`);
  const to = suggestStatus(row.kind, app.status);
  if (!to) throw new ConflictError("There's nothing to change: the application is already at or past what this email says. Dismiss it instead.");
  if (to === "submitted") markSubmitted(db, appId, now);
  else setTrackedStatus(db, appId, to, now);
  db.update(emailMessages).set({ state: "accepted", applicationId: appId, suggestedStatus: to, decidedAt: now }).where(eq(emailMessages.id, id)).run();
  return toItem(db, db.select().from(emailMessages).where(eq(emailMessages.id, id)).get()!);
}

/** Not right, or not worth acting on. Kept so the next check doesn't suggest it again. */
export function dismissSuggestion(db: DB, id: number, now = new Date()) {
  const row = db.select().from(emailMessages).where(and(eq(emailMessages.id, id), eq(emailMessages.state, "pending"))).get();
  if (!row) throw new NotFoundError(`No pending email ${id}`);
  db.update(emailMessages).set({ state: "dismissed", decidedAt: now }).where(eq(emailMessages.id, id)).run();
  return { ok: true };
}
