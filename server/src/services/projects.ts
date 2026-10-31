import { desc, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { projects, tasks } from "../db/schema";
import { getSettings, localDate } from "./settings";
import { listTime } from "./time";
import { listTasks } from "./tasks";
import { ConflictError, NotFoundError } from "./jobs";
import { addDays, hours, weekStart } from "../domain/week";
import type { ProjectRecord, ProjectPatch } from "../../../shared/types";

// One project a week, from the mentor prompt's portfolio module: real API or
// messy data, deployed, one honest measured result, and it only goes on the
// resume once it's built and on GitHub.
//
// Hours aren't stored on the project. They're the project-bucket time logged
// in its week, so the project and the week's hours can never disagree.

function toRecord(db: DB, row: typeof projects.$inferSelect): ProjectRecord {
  const week = row.weekStart;
  const minutes = week
    ? listTime(db, week, addDays(week, 6))
        .filter((e) => e.bucket === "projects")
        .reduce((n, e) => n + e.minutes, 0)
    : 0;
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    repoUrl: row.repoUrl,
    status: row.status as ProjectRecord["status"],
    weekStart: week,
    skills: row.skills ?? [],
    resultMetric: row.resultMetric,
    hoursLogged: hours(minutes),
    tasks: listTasks(db, { includeDone: true }).filter((t) => t.linkedEntity === `project:${row.id}`),
    createdAt: row.createdAt.getTime(),
  };
}

export function listProjects(db: DB): ProjectRecord[] {
  return db.select().from(projects).orderBy(desc(projects.id)).all().map((r) => toRecord(db, r));
}

/** The project for the week containing `now`, if one has been started. */
export function currentProject(db: DB, now = new Date()): ProjectRecord | null {
  const week = weekStart(localDate(now, getSettings(db).pipeline.timezone));
  const row = db.select().from(projects).where(eq(projects.weekStart, week)).orderBy(desc(projects.id)).get();
  return row ? toRecord(db, row) : null;
}

export type NewProject = { title: string; summary?: string | null; skills?: string[]; repoUrl?: string | null; weekStart?: string };

/** Starts this week's project, usually from one of the weekly review's ideas. */
export function startProject(db: DB, p: NewProject, now = new Date()): ProjectRecord {
  const title = p.title.trim();
  if (!title) throw new ConflictError("A project needs a title.");
  const week = p.weekStart ?? weekStart(localDate(now, getSettings(db).pipeline.timezone));
  const row = db
    .insert(projects)
    .values({ title, summary: p.summary?.trim() || null, skills: p.skills ?? [], repoUrl: p.repoUrl?.trim() || null, weekStart: week, status: "active" })
    .returning()
    .get();
  return toRecord(db, row);
}

export function updateProject(db: DB, id: number, patch: ProjectPatch): ProjectRecord {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) throw new NotFoundError(`Project ${id} not found`);
  // The prompt's rule: it goes on the resume once it's built, on GitHub, and
  // has one honest measured result. Shipping without those is the gap.
  if (patch.status === "shipped") {
    const repo = patch.repoUrl ?? row.repoUrl;
    const result = patch.resultMetric ?? row.resultMetric;
    if (!repo?.trim()) throw new ConflictError("Add the GitHub URL before marking it shipped; a project only counts once it's public.");
    if (!result?.trim()) throw new ConflictError("Add the one result you measured before marking it shipped (the prompt asks for one honest number).");
  }
  db.update(projects)
    .set({
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.repoUrl !== undefined ? { repoUrl: patch.repoUrl } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.resultMetric !== undefined ? { resultMetric: patch.resultMetric } : {}),
      ...(patch.skills !== undefined ? { skills: patch.skills } : {}),
    })
    .where(eq(projects.id, id))
    .run();
  return toRecord(db, db.select().from(projects).where(eq(projects.id, id)).get()!);
}

export function deleteProject(db: DB, id: number) {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) throw new NotFoundError(`Project ${id} not found`);
  db.update(tasks).set({ linkedEntity: null }).where(eq(tasks.linkedEntity, `project:${id}`)).run();
  db.delete(projects).where(eq(projects.id, id)).run();
}
