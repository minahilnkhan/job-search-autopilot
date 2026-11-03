import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import type { DB } from "../db/client";
import { applications, companies, contacts, jobs, outreach } from "../db/schema";
import {
  ACTIVE,
  ENDED,
  FOLLOW_UP_AFTER_DAYS,
  NOTE_LIMIT,
  NO_REPEAT_DAYS,
  OutreachError,
  inviteBudget,
  lintOutreach,
  matchAcceptance,
  nextStatus,
  normalizeProfileUrl,
  searchLinks,
  wantedContacts,
  type OutreachAction,
} from "../domain/outreach";
import { runTruthCheck } from "../domain/truthCheck";
import type { InventoryFacts } from "../domain/inventory";
import type { OutreachDraft, OutreachDrafter } from "../llm/outreach";
import { ScoreError } from "../llm/scoreJob";
import { accountProblem } from "../llm/errors";
import { recordUsage } from "./usage";
import { getSettings, localDate } from "./settings";
import { ConflictError, NotFoundError } from "./jobs";
import { addDays } from "../domain/week";
import type { ApplicationStatus, ContactRelationship, NetworkRole, NetworkState, OutreachIssue, OutreachItem, Settings } from "../../../shared/types";

// Referral outreach. The app picks nothing and sends nothing on LinkedIn: you
// paste the people you chose, it drafts the messages, you send them from your
// own browser and press the button that says you did. What it does do is
// keep count, hold the caps, and tell you what's due.

export type NetworkDeps = {
  getDrafter?: (s: Settings) => { draft: OutreachDrafter } | { unavailable: string };
  facts?: () => InventoryFacts;
};

/** Roles worth finding people for: still open, from prepared through interviewing. */
const LIVE: ApplicationStatus[] = ["ready_for_review", "approved", "submitted", "screen", "interview"];

const tzOf = (db: DB) => getSettings(db).pipeline.timezone;

function rows(db: DB, where?: ReturnType<typeof eq>) {
  const q = db
    .select({ o: outreach, c: contacts, appId: applications.id, tier: applications.tier, companyName: companies.name, jobTitle: jobs.title, jobUrl: jobs.url })
    .from(outreach)
    .innerJoin(contacts, eq(contacts.id, outreach.contactId))
    .leftJoin(applications, eq(applications.id, outreach.applicationId))
    .leftJoin(jobs, eq(jobs.id, applications.jobId))
    .leftJoin(companies, eq(companies.id, jobs.companyId));
  return (where ? q.where(where) : q).orderBy(desc(outreach.updatedAt)).all();
}
type Row = ReturnType<typeof rows>[number];

function nextStep(r: Row, today: string): OutreachItem["next"] {
  const s = r.o.status;
  const forRole = r.appId !== null;
  if (s === "planned") {
    return r.c.relationship === "first_degree"
      ? { action: "message", label: forRole ? "Send the ask" : "Send a message", text: "ask" }
      : { action: "invite", label: "Send connection request", text: "note" };
  }
  if (s === "connected") return { action: "message", label: forRole ? "They accepted: send the ask" : "They accepted: send a message", text: "ask" };
  if (s === "asked" && r.o.followUpDue && r.o.followUpDue <= today) return { action: "follow_up", label: "No answer in a week: send the follow-up", text: "followUp" };
  return null;
}

function toItem(r: Row, today: string): OutreachItem {
  return {
    id: r.o.id,
    status: r.o.status,
    contact: { id: r.c.id, name: r.c.name, headline: r.c.headline, linkedinUrl: r.c.linkedinUrl, relationship: r.c.relationship, about: r.c.about },
    application: r.appId !== null ? { id: r.appId, companyName: r.companyName ?? "", jobTitle: r.jobTitle ?? "", tier: r.tier ?? null, jobUrl: r.jobUrl ?? "" } : null,
    note: r.o.note,
    ask: r.o.ask,
    followUp: r.o.followUp,
    issues: r.o.issues,
    invitedAt: r.o.invitedAt?.getTime() ?? null,
    connectedAt: r.o.connectedAt?.getTime() ?? null,
    connectedVia: r.o.connectedVia ?? null,
    askedAt: r.o.askedAt?.getTime() ?? null,
    followUpDue: r.o.followUpDue,
    updatedAt: r.o.updatedAt.getTime(),
    next: nextStep(r, today),
  };
}

function getItem(db: DB, id: number, now = new Date()): OutreachItem {
  const r = rows(db, eq(outreach.id, id))[0];
  if (!r) throw new NotFoundError("No such outreach.");
  return toItem(r, localDate(now, tzOf(db)));
}

function budget(db: DB, now: Date) {
  const tz = tzOf(db);
  const since = new Date(now.getTime() - 8 * 86_400_000);
  const sent = db.select({ at: outreach.invitedAt }).from(outreach).where(and(isNotNull(outreach.invitedAt), gte(outreach.invitedAt, since))).all();
  return inviteBudget(sent.map((s) => s.at!), now, localDate(now, tz), (d) => localDate(d, tz));
}

function roles(db: DB): NetworkRole[] {
  const apps = db
    .select({ id: applications.id, tier: applications.tier, status: applications.status, companyName: companies.name, jobTitle: jobs.title, createdAt: applications.createdAt })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(inArray(applications.status, LIVE))
    .orderBy(desc(applications.createdAt))
    .limit(60)
    .all();
  const counts = new Map<number, number>();
  for (const o of db.select({ a: outreach.applicationId }).from(outreach).where(isNotNull(outreach.applicationId)).all()) {
    counts.set(o.a!, (counts.get(o.a!) ?? 0) + 1);
  }
  return apps
    .map((a) => ({
      applicationId: a.id,
      companyName: a.companyName,
      jobTitle: a.jobTitle,
      tier: a.tier ?? null,
      status: a.status,
      wanted: wantedContacts(a.tier ?? null),
      found: counts.get(a.id) ?? 0,
      searches: searchLinks(a.companyName, a.jobTitle),
    }))
    .sort((x, y) => (x.tier === "A" ? 0 : 1) - (y.tier === "A" ? 0 : 1));
}

export function networkState(db: DB, deps: NetworkDeps, now = new Date()): NetworkState {
  const today = localDate(now, tzOf(db));
  const items = rows(db).map((r) => toItem(r, today));
  const d = deps.getDrafter?.(getSettings(db));
  return {
    invites: budget(db, now),
    noteLimit: NOTE_LIMIT,
    due: items.filter((i) => i.next),
    outreach: items,
    roles: roles(db),
    drafting: d && "draft" in d ? { available: true, reason: null } : { available: false, reason: d && "unavailable" in d ? d.unavailable : "drafting isn't set up" },
  };
}

// ---- Checking a draft -------------------------------------------------------------

function checkTexts(texts: OutreachDraft, relationship: ContactRelationship, deps: NetworkDeps): OutreachIssue[] {
  const issues: OutreachIssue[] = lintOutreach(texts, { needsNote: relationship !== "first_degree" });
  let facts: InventoryFacts | undefined;
  try {
    facts = deps.facts?.();
  } catch {
    facts = undefined; // no inventory: the lint still runs
  }
  if (facts) {
    const lines = (["note", "ask", "followUp"] as const).filter((f) => texts[f].trim()).map((f) => ({ where: f, text: texts[f] }));
    for (const i of runTruthCheck({ lines }, facts).issues) {
      if (i.kind === "banned_word" || i.kind === "placeholder") continue; // the lint covers these
      issues.push({ field: i.where as OutreachIssue["field"], severity: i.severity, message: i.message });
    }
  }
  return issues;
}

async function draftFor(db: DB, deps: NetworkDeps, r: Row, now: Date): Promise<{ texts: OutreachDraft; issues: OutreachIssue[] }> {
  const settings = getSettings(db);
  const d = deps.getDrafter?.(settings);
  if (!d || "unavailable" in d) {
    const reason = d && "unavailable" in d ? d.unavailable : "drafting isn't set up";
    return { texts: { note: r.o.note, ask: r.o.ask, followUp: r.o.followUp }, issues: [{ field: "ask", severity: "warn", message: `Couldn't draft (${reason}). Write it yourself, or try again.` }] };
  }
  const job = r.appId !== null ? db.select({ description: jobs.description }).from(applications).innerJoin(jobs, eq(jobs.id, applications.jobId)).where(eq(applications.id, r.appId)).get() : null;
  const input = {
    contact: { name: r.c.name, headline: r.c.headline, relationship: r.c.relationship, about: r.c.about },
    application: r.appId !== null ? { companyName: r.companyName ?? "", jobTitle: r.jobTitle ?? "", jobUrl: r.jobUrl ?? "", description: job?.description ?? "" } : null,
    noteLimit: NOTE_LIMIT,
  };
  const attempt = async (fix?: string[]) => {
    try {
      const out = await d.draft({ ...input, fix });
      recordUsage(db, { purpose: "outreach", model: out.model, usage: out.usage, now });
      const texts = { note: r.c.relationship === "first_degree" ? "" : out.note.trim(), ask: out.ask.trim(), followUp: out.followUp.trim() };
      return { texts, issues: checkTexts(texts, r.c.relationship, deps) };
    } catch (err) {
      if (err instanceof ScoreError && err.usage) recordUsage(db, { purpose: "outreach", model: settings.models.tailoring, usage: err.usage, now });
      throw new ConflictError(accountProblem(err) ?? (err as Error).message);
    }
  };
  const first = await attempt();
  const fails = first.issues.filter((i) => i.severity === "fail");
  if (!fails.length) return first;
  // One redraft with the problems spelled out; if it's still wrong, you see the issues.
  return attempt(fails.map((i) => `${i.field}: ${i.message}`));
}

function save(db: DB, id: number, texts: OutreachDraft, issues: OutreachIssue[], now: Date) {
  db.update(outreach).set({ ...texts, issues, updatedAt: now }).where(eq(outreach.id, id)).run();
}

// ---- Actions ---------------------------------------------------------------------

export type NewContact = {
  applicationId?: number | null;
  linkedinUrl: string;
  name: string;
  headline?: string | null;
  relationship: ContactRelationship;
  about?: string | null;
};

/** Adds a person for a role (or for networking), then drafts their messages. */
export async function addContact(db: DB, deps: NetworkDeps, input: NewContact, now = new Date()): Promise<OutreachItem> {
  const url = normalizeProfileUrl(input.linkedinUrl);
  if (!url) throw new ConflictError("That isn't a LinkedIn profile link. It should look like linkedin.com/in/their-name.");
  const applicationId = input.applicationId ?? null;
  if (applicationId !== null && !db.select({ id: applications.id }).from(applications).where(eq(applications.id, applicationId)).get()) {
    throw new NotFoundError("No such application.");
  }

  let contact = db.select().from(contacts).where(eq(contacts.linkedinUrl, url)).get();
  if (contact) {
    // Same person again: the 30-day rule, and never two conversations at once.
    const past = rows(db, eq(outreach.contactId, contact.id));
    const open = past.find((p) => ACTIVE.includes(p.o.status));
    if (open) {
      const about = open.appId !== null ? ` about ${open.jobTitle} at ${open.companyName}` : "";
      throw new ConflictError(`You're already talking to ${contact.name}${about}. Finish that conversation first.`);
    }
    const recent = past.find((p) => now.getTime() - p.o.createdAt.getTime() < NO_REPEAT_DAYS * 86_400_000);
    if (recent) throw new ConflictError(`You contacted ${contact.name} less than ${NO_REPEAT_DAYS} days ago. Give it some time before asking about another role.`);
    db.update(contacts)
      .set({ name: input.name.trim(), headline: input.headline?.trim() || contact.headline, relationship: input.relationship, about: input.about?.trim() || contact.about })
      .where(eq(contacts.id, contact.id))
      .run();
  } else {
    contact = db
      .insert(contacts)
      .values({ name: input.name.trim(), linkedinUrl: url, headline: input.headline?.trim() || null, relationship: input.relationship, about: input.about?.trim() || null, createdAt: now })
      .returning()
      .get();
  }
  const row = db.insert(outreach).values({ contactId: contact.id, applicationId, createdAt: now, updatedAt: now }).returning().get();
  const r = rows(db, eq(outreach.id, row.id))[0]!;
  try {
    const { texts, issues } = await draftFor(db, deps, r, now);
    save(db, row.id, texts, issues, now);
  } catch (err) {
    // Keep the person; you can redraft or write it yourself.
    save(db, row.id, { note: "", ask: "", followUp: "" }, [{ field: "ask", severity: "warn", message: `Couldn't draft: ${(err as Error).message}` }], now);
  }
  return getItem(db, row.id, now);
}

export async function redraft(db: DB, deps: NetworkDeps, id: number, now = new Date()): Promise<OutreachItem> {
  const r = rows(db, eq(outreach.id, id))[0];
  if (!r) throw new NotFoundError("No such outreach.");
  if (ENDED.includes(r.o.status)) throw new ConflictError("This conversation is closed.");
  const { texts, issues } = await draftFor(db, deps, r, now);
  save(db, id, texts, issues, now);
  return getItem(db, id, now);
}

/** Your edits. Checked the same way as a draft; nothing blocks you from saving. */
export function editOutreach(db: DB, deps: NetworkDeps, id: number, patch: Partial<OutreachDraft> & { about?: string | null; headline?: string | null }, now = new Date()) {
  const r = rows(db, eq(outreach.id, id))[0];
  if (!r) throw new NotFoundError("No such outreach.");
  const texts = { note: patch.note ?? r.o.note, ask: patch.ask ?? r.o.ask, followUp: patch.followUp ?? r.o.followUp };
  if (patch.about !== undefined || patch.headline !== undefined) {
    db.update(contacts)
      .set({ ...(patch.about !== undefined ? { about: patch.about?.trim() || null } : {}), ...(patch.headline !== undefined ? { headline: patch.headline?.trim() || null } : {}) })
      .where(eq(contacts.id, r.c.id))
      .run();
  }
  save(db, id, texts, checkTexts(texts, r.c.relationship, deps), now);
  return getItem(db, id, now);
}

/** You did something on LinkedIn (or they did): move the conversation along. */
export function advance(db: DB, id: number, action: OutreachAction, now = new Date()): OutreachItem {
  const r = rows(db, eq(outreach.id, id))[0];
  if (!r) throw new NotFoundError("No such outreach.");
  let to;
  try {
    to = nextStatus(r.o.status, action, r.c.relationship);
  } catch (err) {
    if (err instanceof OutreachError) throw new ConflictError(err.message);
    throw err;
  }
  if (action === "invite") {
    const b = budget(db, now);
    if (b.left === 0) {
      throw new ConflictError(
        b.today >= b.dailyCap ? `That's ${b.dailyCap} invites today. Send the rest tomorrow.` : `That's ${b.weeklyCap} invites this week. LinkedIn restricts accounts that send many more.`
      );
    }
  }
  const today = localDate(now, tzOf(db));
  db.update(outreach)
    .set({
      status: to,
      updatedAt: now,
      ...(action === "invite" ? { invitedAt: now } : {}),
      ...(action === "accepted" ? { connectedAt: now, connectedVia: "you" as const } : {}),
      ...(action === "message" ? { askedAt: now, followUpDue: addDays(today, FOLLOW_UP_AFTER_DAYS) } : {}),
      ...(action === "follow_up" || action === "replied" ? { followUpDue: null } : {}),
      ...(ENDED.includes(to) ? { endedAt: now, followUpDue: null } : {}),
    })
    .where(eq(outreach.id, id))
    .run();
  return getItem(db, id, now);
}

/** Removes a person you added by mistake. Their contact stays for next time. */
export function removeOutreach(db: DB, id: number) {
  const r = db.select({ id: outreach.id }).from(outreach).where(eq(outreach.id, id)).get();
  if (!r) throw new NotFoundError("No such outreach.");
  db.delete(outreach).where(eq(outreach.id, id)).run();
  return { ok: true };
}

/**
 * Names from LinkedIn's "accepted your invitation" emails (the 8pm inbox
 * check). Moves those invites to "connected" so Today shows the ask. A wrong
 * match costs nothing: it only puts a draft in front of you.
 */
export function recordAcceptances(db: DB, names: string[], now = new Date()): number {
  if (!names.length) return 0;
  const invited = rows(db, eq(outreach.status, "invited")).map((r) => ({ id: r.o.id, name: r.c.name }));
  let n = 0;
  for (const name of names) {
    const hit = matchAcceptance(name, invited);
    if (!hit) continue;
    db.update(outreach).set({ status: "connected", connectedAt: now, connectedVia: "inbox", updatedAt: now }).where(eq(outreach.id, hit.id)).run();
    invited.splice(invited.indexOf(hit), 1);
    n++;
  }
  return n;
}

/** Whether the inbox check should look for LinkedIn acceptance emails at all. */
export const hasPendingInvites = (db: DB) => !!db.select({ id: outreach.id }).from(outreach).where(eq(outreach.status, "invited")).limit(1).get();
