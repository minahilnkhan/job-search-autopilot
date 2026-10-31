import { and, asc, eq, inArray } from "drizzle-orm";
import type { DB } from "../db/client";
import { tasks } from "../db/schema";
import { getSettings, localDate } from "./settings";
import { ConflictError, NotFoundError } from "./jobs";
import { weekHours } from "./time";
import { addDays, hours, weekStart, type Bucket } from "../domain/week";
import type { Task, TaskPatch, CapWarning } from "../../../shared/types";

// The to-do list. Most of it is written by the mentor's daily check-in and
// weekly review; you can add your own. Tasks carry an estimate so the app can
// tell you when the week is already full (the prompt's 30-hour cap).

const OPEN = ["todo", "doing"] as const;

export function listTasks(db: DB, opts: { includeDone?: boolean } = {}, now = new Date()): Task[] {
  const rows = db
    .select()
    .from(tasks)
    .where(opts.includeDone ? undefined : inArray(tasks.status, [...OPEN]))
    .orderBy(asc(tasks.priority), asc(tasks.dueDate), asc(tasks.id))
    .all();
  const today = localDate(now, getSettings(db).pipeline.timezone);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    bucket: r.bucket,
    dueDate: r.dueDate,
    priority: r.priority,
    source: r.source,
    status: r.status,
    linkedEntity: r.linkedEntity,
    estimateMinutes: r.estimateMinutes,
    overdue: !!r.dueDate && r.dueDate < today && (r.status === "todo" || r.status === "doing"),
  }));
}

export type NewTask = {
  title: string;
  bucket?: Bucket | null;
  dueDate?: string | null;
  priority?: number;
  source?: "mentor" | "manual";
  linkedEntity?: string | null;
  estimateMinutes?: number | null;
};

export function createTask(db: DB, t: NewTask): Task {
  const title = t.title.trim();
  if (!title) throw new ConflictError("A task needs a title.");
  const row = db
    .insert(tasks)
    .values({
      title,
      bucket: t.bucket ?? null,
      dueDate: t.dueDate ?? null,
      priority: t.priority ?? 2,
      source: t.source ?? "manual",
      linkedEntity: t.linkedEntity ?? null,
      estimateMinutes: t.estimateMinutes ?? null,
    })
    .returning()
    .get();
  return listTasks(db, { includeDone: true }).find((x) => x.id === row.id)!;
}

export function updateTask(db: DB, id: number, patch: TaskPatch): Task {
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!row) throw new NotFoundError(`Task ${id} not found`);
  if (patch.title !== undefined && !patch.title.trim()) throw new ConflictError("A task needs a title.");
  db.update(tasks)
    .set({
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.bucket !== undefined ? { bucket: patch.bucket } : {}),
      ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.estimateMinutes !== undefined ? { estimateMinutes: patch.estimateMinutes } : {}),
    })
    .where(eq(tasks.id, id))
    .run();
  return listTasks(db, { includeDone: true }).find((x) => x.id === id)!;
}

export function deleteTask(db: DB, id: number) {
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!row) throw new NotFoundError(`Task ${id} not found`);
  db.delete(tasks).where(eq(tasks.id, id)).run();
}

/** The check-in's priorities for a day: it rewrites them rather than piling new ones on top. */
export function replaceMentorTasks(db: DB, dueDate: string, items: NewTask[]) {
  const existing = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.source, "mentor"), eq(tasks.dueDate, dueDate)))
    .all();
  // Anything you already started or finished stays; only untouched ones are replaced.
  const replaceable = existing.filter((t) => t.status === "todo");
  if (replaceable.length) db.delete(tasks).where(inArray(tasks.id, replaceable.map((t) => t.id))).run();
  return items.map((t, i) => createTask(db, { priority: i + 1, ...t, dueDate, source: "mentor" }));
}

/**
 * Hours already planned this week: what you've logged, plus the estimates on
 * open tasks due this week. The mentor prompt's cap is 30 core hours, with
 * project hours past their 6 as approved overflow, so overflow is excluded
 * from the figure the warning compares against the cap.
 */
export function plannedHours(db: DB, now = new Date()) {
  const s = getSettings(db);
  const today = localDate(now, s.pipeline.timezone);
  const start = weekStart(today);
  const end = addDays(start, 6);
  const logged = weekHours(db, now);
  const openEstimates = listTasks(db, {}, now).filter((t) => t.estimateMinutes && t.dueDate && t.dueDate >= start && t.dueDate <= end);
  const plannedByBucket = { applications: 0, projects: 0, prep: 0 } as Record<Bucket, number>;
  for (const t of openEstimates) plannedByBucket[(t.bucket ?? "applications") as Bucket] += t.estimateMinutes!;
  const plannedCore = hours(plannedByBucket.applications + plannedByBucket.prep + plannedByBucket.projects);
  return {
    weekStart: start,
    loggedCore: logged.coreHours,
    plannedFromTasks: plannedCore,
    projectOverflow: logged.projectOverflow,
    cap: s.targets.hoursPerWeekCap,
    totalCore: Math.round((logged.coreHours + plannedCore) * 10) / 10,
  };
}

/** What to show before adding `extraMinutes` of work to this week, or null when there's room. */
export function capWarning(db: DB, extraMinutes: number, now = new Date()): CapWarning | null {
  const p = plannedHours(db, now);
  const after = Math.round((p.totalCore + hours(extraMinutes)) * 10) / 10;
  if (after <= p.cap) return null;
  return {
    cap: p.cap,
    plannedHours: p.totalCore,
    afterHours: after,
    message: `This week is already at ${p.totalCore} of your ${p.cap}-hour cap; this would take it to ${after}. Say what it replaces, or raise the cap in Settings.`,
  };
}
