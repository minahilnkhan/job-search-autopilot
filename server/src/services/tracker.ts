import { desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { DB } from "../db/client";
import { applications, companies, interviews, jobs, projects } from "../db/schema";
import { getSettings, localDate } from "./settings";
import { listApplications, skillsToBuild } from "./applications";
import { listTime, weekHours } from "./time";
import { listTasks } from "./tasks";
import { monthSpend } from "./usage";
import { addDays, daysBetween, hours, streakDays, weekStart, type Bucket } from "../domain/week";
import type { TrackerState } from "../../../shared/types";

// <tracker_state> for the mentor prompt: "Base ALL counts on this, not
// memory." Everything the mentor is allowed to assert about her week is
// counted here, in code, from the database — so it can't drift or be guessed.
// The same numbers feed the dashboard, so the screen and the check-in can
// never disagree.

/** A response: anything past "submitted" counts, including a rejection (they read it). */
const RESPONDED = ["screen", "interview", "offer", "rejected"];

export function trackerState(db: DB, now = new Date()): TrackerState {
  const s = getSettings(db);
  const tz = s.pipeline.timezone;
  const today = localDate(now, tz);
  const thisWeek = weekStart(today);
  const lastWeek = addDays(thisWeek, -7);

  const rows = db
    .select({ app: applications, job: jobs, companyName: companies.name })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(isNotNull(applications.submittedAt))
    .all();

  const submitted = rows.map((r) => ({
    date: localDate(r.app.submittedAt!, tz),
    tier: r.app.tier === "A" ? ("A" as const) : ("B" as const),
    status: r.app.status,
    title: r.job.title,
    companyName: r.companyName,
    followUpDue: r.app.followUpDue,
  }));

  const countBy = (days: (d: string) => boolean) => {
    const list = submitted.filter((x) => days(x.date));
    return { total: list.length, tierA: list.filter((x) => x.tier === "A").length, tierB: list.filter((x) => x.tier === "B").length };
  };
  const perDay = new Map<string, number>();
  for (const x of submitted) perDay.set(x.date, (perDay.get(x.date) ?? 0) + 1);

  const rate = (list: typeof submitted) => {
    const responded = list.filter((x) => RESPONDED.includes(x.status)).length;
    return { applications: list.length, responses: responded, rate: list.length ? Math.round((responded / list.length) * 100) : null };
  };

  // Role type comes from the title, so "which kind of role is converting" is
  // answerable without a column she'd have to maintain.
  const roleTypes = new Map<string, typeof submitted>();
  for (const x of submitted) {
    const key = roleType(x.title);
    roleTypes.set(key, [...(roleTypes.get(key) ?? []), x]);
  }

  const thisWeekHours = weekHours(db, now);
  const lastWeekMinutes = { applications: 0, projects: 0, prep: 0 } as Record<Bucket, number>;
  for (const e of listTime(db, lastWeek, addDays(lastWeek, 6))) lastWeekMinutes[e.bucket] += e.minutes;
  const todayMinutes = { applications: 0, projects: 0, prep: 0 } as Record<Bucket, number>;
  for (const e of listTime(db, today, today)) todayMinutes[e.bucket] += e.minutes;

  const upcoming = db
    .select({ i: interviews, app: applications, job: jobs, companyName: companies.name })
    .from(interviews)
    .innerJoin(applications, eq(interviews.applicationId, applications.id))
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(inArray(interviews.outcome, ["scheduled"]))
    .orderBy(interviews.scheduledAt)
    .all()
    .map((r) => ({
      id: r.i.id,
      companyName: r.companyName,
      jobTitle: r.job.title,
      stage: r.i.stage,
      scheduledAt: r.i.scheduledAt ? localDate(r.i.scheduledAt, tz) : null,
    }));

  const project = db.select().from(projects).where(eq(projects.weekStart, thisWeek)).orderBy(desc(projects.id)).get();
  const dueFollowUps = submitted.filter((x) => x.status === "submitted" && x.followUpDue && x.followUpDue <= today);

  return {
    date: today,
    weekStart: thisWeek,
    targets: { appsPerDay: s.targets.appsPerDay, appsPerWeek: s.targets.appsPerDay * s.targets.daysPerWeek, cap: s.targets.hoursPerWeekCap, bucketHours: s.targets.bucketHours },
    capReviewDate: s.capReviewDate,
    daysToCapReview: daysBetween(today, s.capReviewDate),
    today: {
      submitted: countBy((d) => d === today),
      hours: hours(todayMinutes.applications + todayMinutes.projects + todayMinutes.prep),
    },
    week: {
      submitted: countBy((d) => d >= thisWeek && d <= today),
      hours: thisWeekHours,
    },
    lastWeek: {
      submitted: countBy((d) => d >= lastWeek && d < thisWeek),
      hours: {
        applications: hours(lastWeekMinutes.applications),
        projects: hours(lastWeekMinutes.projects),
        prep: hours(lastWeekMinutes.prep),
      },
    },
    streak: streakDays(perDay, today, s.targets.appsPerDay),
    queue: {
      review: listApplications(db, "review", now).length,
      blocked: listApplications(db, "blocked", now).length,
      approved: listApplications(db, "approved", now).length,
      snoozed: listApplications(db, "snoozed", now).length,
    },
    pipeline: {
      submitted: submitted.filter((x) => x.status === "submitted").length,
      screen: submitted.filter((x) => x.status === "screen").length,
      interview: submitted.filter((x) => x.status === "interview").length,
      offer: submitted.filter((x) => x.status === "offer").length,
      rejected: submitted.filter((x) => x.status === "rejected").length,
      ghosted: submitted.filter((x) => x.status === "ghosted").length,
    },
    responseRate: {
      overall: rate(submitted),
      tierA: rate(submitted.filter((x) => x.tier === "A")),
      tierB: rate(submitted.filter((x) => x.tier === "B")),
      byRoleType: [...roleTypes.entries()]
        .map(([type, list]) => ({ type, ...rate(list) }))
        .sort((a, b) => b.applications - a.applications),
    },
    followUpsDue: dueFollowUps.map((x) => `${x.companyName} — ${x.title}`),
    interviews: upcoming,
    tasks: listTasks(db, {}, now).map((t) => ({ title: t.title, bucket: t.bucket, dueDate: t.dueDate, status: t.status, overdue: t.overdue })),
    project: project ? { title: project.title, status: project.status, hoursLogged: project.hoursLogged, skills: project.skills ?? [], repoUrl: project.repoUrl } : null,
    skillsToBuild: skillsToBuild(db, now).slice(0, 8).map((k) => ({ skill: k.skill, postings: k.count })),
    spendThisMonth: monthSpend(db, now).costUsd,
  };
}

/** Rough role families, from the title alone. Enough to answer "what's converting". */
export function roleType(title: string): string {
  const t = title.toLowerCase();
  if (/forward.?deployed|solutions? (engineer|architect)|implementation|customer engineer|deployment/.test(t)) return "FDE / Solutions";
  if (/applied ai|ai engineer|machine learning|ml engineer|llm/.test(t)) return "Applied AI";
  if (/data (engineer|scientist|analyst)/.test(t)) return "Data";
  if (/consult/.test(t)) return "Consulting";
  if (/instructor|teach|curriculum|education|developer advocate|advocacy|enablement/.test(t)) return "Teaching / DevEd";
  if (/support|success/.test(t)) return "Support / Success";
  return "Software Engineering";
}

const pct = (r: { rate: number | null; responses: number; applications: number }) =>
  r.applications === 0 ? "no applications yet" : `${r.responses}/${r.applications}${r.rate === null ? "" : ` (${r.rate}%)`}`;

/**
 * The same state as text, for the prompt. Written out rather than sent as raw
 * JSON so the model reads units and targets the same way every time ("12 of
 * 70" rather than a bare number it might treat as a percentage).
 */
export function trackerStateText(t: TrackerState): string {
  const bucket = (b: { bucket: string; hours: number; target: number }) => `${b.bucket} ${b.hours}/${b.target}h`;
  const lines = [
    `Today (${t.date}): ${t.today.submitted.total}/${t.targets.appsPerDay} applications (A ${t.today.submitted.tierA}, B ${t.today.submitted.tierB}), ${t.today.hours}h logged.`,
    `Week (from ${t.weekStart}): ${t.week.submitted.total}/${t.targets.appsPerWeek} applications (A ${t.week.submitted.tierA}, B ${t.week.submitted.tierB}).`,
    `Hours this week: ${t.week.hours.buckets.map(bucket).join(", ")}. Core ${t.week.hours.coreHours}/${t.targets.cap}h${t.week.hours.projectOverflow ? `, plus ${t.week.hours.projectOverflow}h approved project overflow` : ""}.`,
    `Last week: ${t.lastWeek.submitted.total} applications (A ${t.lastWeek.submitted.tierA}, B ${t.lastWeek.submitted.tierB}); hours applications ${t.lastWeek.hours.applications}, projects ${t.lastWeek.hours.projects}, prep ${t.lastWeek.hours.prep}.`,
    `Streak at target: ${t.streak} day${t.streak === 1 ? "" : "s"}. Cap review ${t.capReviewDate} (${t.daysToCapReview} days away).`,
    "",
    `Queue: ${t.queue.review} waiting for review, ${t.queue.blocked} blocked by the Truth Check, ${t.queue.approved} approved and not sent, ${t.queue.snoozed} snoozed.`,
    `Pipeline: ${t.pipeline.submitted} submitted, ${t.pipeline.screen} screens, ${t.pipeline.interview} interviews, ${t.pipeline.offer} offers, ${t.pipeline.rejected} rejected, ${t.pipeline.ghosted} ghosted.`,
    `Response rate: overall ${pct(t.responseRate.overall)}; Tier A ${pct(t.responseRate.tierA)}; Tier B ${pct(t.responseRate.tierB)}.`,
    t.responseRate.byRoleType.length ? `By role type: ${t.responseRate.byRoleType.map((r) => `${r.type} ${pct(r)}`).join("; ")}.` : null,
    t.followUpsDue.length ? `Follow-ups due: ${t.followUpsDue.join("; ")}.` : "Follow-ups due: none.",
    t.interviews.length ? `Interviews scheduled: ${t.interviews.map((i) => `${i.companyName} ${i.stage}${i.scheduledAt ? ` on ${i.scheduledAt}` : ""}`).join("; ")}.` : "Interviews scheduled: none.",
    "",
    t.project ? `This week's project: ${t.project.title} (${t.project.status}, ${t.project.hoursLogged}h logged${t.project.skills.length ? `, building ${t.project.skills.join(", ")}` : ""}).` : "This week's project: none chosen yet.",
    t.skillsToBuild.length ? `Skills to build (from recent postings): ${t.skillsToBuild.map((k) => `${k.skill} (${k.postings})`).join(", ")}.` : null,
    "",
    t.tasks.length
      ? `Open tasks:\n${t.tasks.map((x) => `- ${x.title}${x.bucket ? ` [${x.bucket}]` : ""}${x.dueDate ? ` due ${x.dueDate}` : ""}${x.overdue ? " (OVERDUE)" : ""}`).join("\n")}`
      : "Open tasks: none.",
  ];
  return lines.filter((l) => l !== null).join("\n");
}
