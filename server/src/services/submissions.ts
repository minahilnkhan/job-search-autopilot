import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desc, eq, inArray } from "drizzle-orm";
import type { Page } from "playwright";
import type { DB } from "../db/client";
import { applications, companies, jobs } from "../db/schema";
import { assertTransition } from "../domain/applicationStatus";
import { applyTarget } from "../submit/applyUrl";
import { looksSubmitted } from "../submit/confirm";
import { prefillPage } from "../submit/prefill";
import { ConflictError, NotFoundError } from "./jobs";
import { applicationFile, getApplication } from "./applications";
import { getSettings, localDate } from "./settings";
import type { ApplicationStatus, PrefillReport, SubmitSession, TrackedApplication } from "../../../shared/types";

// Phase 4, assisted submit: open the real form in a browser window on your
// machine, fill what we can, and wait for you to press Submit. The app never
// clicks Submit; it only notices the confirmation page (or you tell it).

export type SubmitDeps = {
  /** Opens a visible browser tab at the URL. Tests pass a headless one. */
  openPage: (url: string) => Promise<Page>;
  watchEveryMs?: number;
};

type Live = { state: SubmitSession["state"]; report: PrefillReport | null; page: Page | null; timer: NodeJS.Timeout | null };
const sessions = new Map<number, Live>();

/** Days until a Tier A follow-up, per the mentor prompt (7–10 days). Tier B gets none. */
export const FOLLOW_UP_DAYS = 7;

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function getSubmitSession(db: DB, id: number): SubmitSession {
  const live = sessions.get(id);
  if (live) return { applicationId: id, state: live.state, report: live.report };
  const app = getApplication(db, id);
  return { applicationId: id, state: app.status === "approved" ? "closed" : "submitted", report: app.prefillReport };
}

/** Copy the PDF to a temp folder under a proper name ("Minahil_Khan_Resume.pdf", not "resume.pdf"). */
function uploadCopy(db: DB, id: number): string {
  const f = applicationFile(db, id, "pdf");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `autopilot-upload-${id}-`));
  const out = path.join(dir, f.filename);
  fs.copyFileSync(f.path, out);
  return out;
}

export async function openAndPrefill(db: DB, id: number, deps: SubmitDeps): Promise<SubmitSession> {
  const app = getApplication(db, id);
  if (app.status !== "approved") throw new ConflictError("Approve the application first; only approved applications are opened for submitting.");
  const live = sessions.get(id);
  if (live?.page && !live.page.isClosed() && live.state !== "closed") {
    await live.page.bringToFront().catch(() => {});
    return getSubmitSession(db, id);
  }

  const row = db
    .select({ source: jobs.source, externalId: jobs.externalId, url: jobs.url, token: companies.atsBoardToken })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(jobs.id, app.jobId))
    .get()!;
  const target = applyTarget(row, row.token);
  if (!target) throw new ConflictError("This job has no application link. Use the copy panel and apply on the company's site.");
  const resumePath = uploadCopy(db, id);
  const settings = getSettings(db);

  const entry: Live = { state: "opening", report: null, page: null, timer: null };
  sessions.set(id, entry);
  const save = (report: PrefillReport) => {
    entry.report = report;
    db.update(applications).set({ prefillReport: report, lastActivityAt: new Date() }).where(eq(applications.id, id)).run();
  };

  // Runs in the background; the UI polls the session.
  void (async () => {
    let page: Page;
    try {
      page = await deps.openPage(target.url);
      entry.page = page;
    } catch (err) {
      entry.state = "closed";
      save({ ats: target.ats, url: target.url, filled: [], leftForYou: [], resumeUploaded: false, error: `Couldn't open the form: ${(err as Error).message.split("\n")[0]}`, at: Date.now() });
      return;
    }
    entry.state = "open";
    page.on("close", () => {
      if (entry.state !== "submitted") entry.state = "closed";
      if (entry.timer) clearInterval(entry.timer);
    });
    try {
      const r = await prefillPage(page, { profile: settings.profile, answers: app.answers, recruiterNote: app.recruiterNote, resumeFileName: path.basename(resumePath) }, resumePath);
      const { readError, ...found } = r;
      const error = found.filled.length ? null : readError ? `Couldn't read the form (${readError}). Use the copy panel.` : "Found nothing to fill on this page. Use the copy panel.";
      save({ ats: target.ats, url: target.url, ...found, error, at: Date.now() });
    } catch (err) {
      save({ ats: target.ats, url: target.url, filled: [], leftForYou: [], resumeUploaded: false, error: `Prefill stopped: ${(err as Error).message.split("\n")[0]}. Use the copy panel.`, at: Date.now() });
    }
    // Watch for the "thank you for applying" page.
    entry.timer = setInterval(async () => {
      if (page.isClosed() || entry.state !== "open") return;
      try {
        for (const frame of page.frames()) {
          const body = await frame.locator("body").innerText({ timeout: 1000 }).catch(() => "");
          if (looksSubmitted(frame.url(), body)) {
            markSubmitted(db, id);
            entry.state = "submitted";
            if (entry.timer) clearInterval(entry.timer);
            return;
          }
        }
      } catch {
        // page navigating; try again next tick
      }
    }, deps.watchEveryMs ?? 2000);
  })();

  return getSubmitSession(db, id);
}

/** You pressed Submit on the real form (or the app saw the confirmation page). */
export function markSubmitted(db: DB, id: number, now = new Date()) {
  const app = db.select().from(applications).where(eq(applications.id, id)).get();
  if (!app) throw new NotFoundError(`Application ${id} not found`);
  if (app.status === "submitted") return getApplication(db, id);
  assertTransition(app.status, "submitted");
  const today = localDate(now, getSettings(db).pipeline.timezone);
  db.update(applications)
    .set({ status: "submitted", submittedAt: now, lastActivityAt: now, followUpDue: app.tier === "A" ? addDays(today, FOLLOW_UP_DAYS) : null })
    .where(eq(applications.id, id))
    .run();
  const live = sessions.get(id);
  if (live) live.state = "submitted";
  return getApplication(db, id);
}

/** Undo a "submitted" that was wrong (e.g. the confirmation check misfired). */
export function unmarkSubmitted(db: DB, id: number, now = new Date()) {
  const app = getApplication(db, id);
  assertTransition(app.status, "approved");
  db.update(applications).set({ status: "approved", submittedAt: null, followUpDue: null, lastActivityAt: now }).where(eq(applications.id, id)).run();
  const live = sessions.get(id);
  if (live && live.state === "submitted") live.state = live.page && !live.page.isClosed() ? "open" : "closed";
  return getApplication(db, id);
}

const TRACKED: ApplicationStatus[] = ["submitted", "screen", "interview", "offer", "rejected", "ghosted"];
const ENDED: ApplicationStatus[] = ["offer", "rejected", "ghosted", "withdrawn"];

/** Move a submitted application along: screen, interview, offer, rejected, ghosted, withdrawn. */
export function setTrackedStatus(db: DB, id: number, status: ApplicationStatus, now = new Date()) {
  const app = getApplication(db, id);
  if (!TRACKED.includes(app.status)) throw new ConflictError("Only submitted applications are tracked here.");
  assertTransition(app.status, status);
  db.update(applications)
    .set({ status, lastActivityAt: now, ...(ENDED.includes(status) || status === "screen" || status === "interview" ? { followUpDue: null } : {}) })
    .where(eq(applications.id, id))
    .run();
  return getApplication(db, id);
}

/** "Followed up" clears it; "later" pushes it out three days. */
export function updateFollowUp(db: DB, id: number, action: "done" | "later", now = new Date()) {
  const app = getApplication(db, id);
  if (!app.followUpDue) throw new ConflictError("This application has no follow-up due.");
  const today = localDate(now, getSettings(db).pipeline.timezone);
  db.update(applications)
    .set({ followUpDue: action === "done" ? null : addDays(today, 3), lastActivityAt: now })
    .where(eq(applications.id, id))
    .run();
  return getApplication(db, id);
}

export function listTracked(db: DB): TrackedApplication[] {
  const rows = db
    .select({ app: applications, job: jobs, companyName: companies.name })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(inArray(applications.status, [...TRACKED, "withdrawn"]))
    .orderBy(desc(applications.submittedAt))
    .all()
    .filter((r) => r.app.submittedAt); // withdrawn before submitting isn't tracked
  return rows.map((r) => ({
    id: r.app.id,
    jobId: r.job.id,
    jobTitle: r.job.title,
    companyName: r.companyName,
    tier: r.app.tier,
    fitScore: r.job.fitScore,
    status: r.app.status,
    truthPass: r.app.truthReport?.pass ?? false,
    truthOverride: r.app.truthOverride ?? null,
    failCount: 0,
    snoozedUntil: null,
    createdAt: r.app.createdAt.getTime(),
    submittedAt: r.app.submittedAt?.getTime() ?? null,
    followUpDue: r.app.followUpDue ?? null,
    lastActivityAt: r.app.lastActivityAt?.getTime() ?? null,
    jobUrl: r.job.url,
  }));
}

/** For tests: forget open sessions. */
export function resetSubmitSessions() {
  for (const s of sessions.values()) if (s.timer) clearInterval(s.timer);
  sessions.clear();
}
