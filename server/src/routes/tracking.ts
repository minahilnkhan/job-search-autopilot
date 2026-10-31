import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db/client";
import { idParam } from "./validation";
import { capWarning, createTask, deleteTask, listTasks, plannedHours, updateTask } from "../services/tasks";
import { deleteTimeEntry, discardTimer, listTime, logTime, runningTimer, startTimer, stopTimer, weekHours } from "../services/time";
import { getSettings, localDate } from "../services/settings";
import { addDays, weekStart } from "../domain/week";
import { latestCheckIn, runDailyCheckIn, runWeeklyReview, type CheckInDeps } from "../services/checkIns";
import { trackerState } from "../services/tracker";

const bucket = z.enum(["applications", "projects", "prep"]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export function trackingRoutes(app: FastifyInstance, db: DB) {
  // ---- Time -------------------------------------------------------------------
  app.get("/api/time", async (req) => {
    const q = z.object({ from: date.optional(), to: date.optional() }).parse(req.query);
    const today = localDate(new Date(), getSettings(db).pipeline.timezone);
    const from = q.from ?? weekStart(today);
    return { running: runningTimer(db), week: weekHours(db), entries: listTime(db, from, q.to ?? addDays(from, 6)) };
  });

  app.post("/api/time/start", async (req) => {
    const b = z.object({ bucket, note: z.string().max(200).nullable().optional() }).parse(req.body);
    return startTimer(db, b.bucket, b.note ?? null);
  });

  // minutes: what you confirm after leaving a timer running too long.
  app.post("/api/time/:id/stop", async (req) => {
    const b = z.object({ minutes: z.number().int().min(0).max(24 * 60).optional() }).parse(req.body ?? {});
    return stopTimer(db, idParam.parse(req.params).id, new Date(), b.minutes);
  });

  app.post("/api/time/:id/discard", async (req) => {
    discardTimer(db, idParam.parse(req.params).id);
    return { ok: true };
  });

  app.post("/api/time", async (req) => {
    const b = z.object({ bucket, minutes: z.number().int().min(1).max(24 * 60), date: date.optional(), note: z.string().max(200).nullable().optional() }).parse(req.body);
    return logTime(db, b);
  });

  app.delete("/api/time/:id", async (req) => {
    deleteTimeEntry(db, idParam.parse(req.params).id);
    return { ok: true };
  });

  // ---- Tasks ------------------------------------------------------------------
  app.get("/api/tasks", async (req) => {
    const q = z.object({ includeDone: z.coerce.boolean().default(false) }).parse(req.query);
    return { tasks: listTasks(db, { includeDone: q.includeDone }), hours: plannedHours(db) };
  });

  app.post("/api/tasks", async (req) => {
    const b = z
      .object({
        title: z.string().trim().min(1).max(300),
        bucket: bucket.nullable().optional(),
        dueDate: date.nullable().optional(),
        priority: z.number().int().min(1).max(5).optional(),
        estimateMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
        /** Set once you've seen the cap warning and still want it. */
        acceptOverCap: z.boolean().default(false),
      })
      .parse(req.body);
    const warning = b.acceptOverCap ? null : capWarning(db, b.estimateMinutes ?? 0);
    if (warning) return { task: null, warning };
    return { task: createTask(db, b), warning: null };
  });

  app.patch("/api/tasks/:id", async (req) => {
    const b = z
      .object({
        title: z.string().trim().min(1).max(300).optional(),
        status: z.enum(["todo", "doing", "done", "dropped"]).optional(),
        bucket: bucket.nullable().optional(),
        dueDate: date.nullable().optional(),
        priority: z.number().int().min(1).max(5).optional(),
        estimateMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
      })
      .parse(req.body);
    return updateTask(db, idParam.parse(req.params).id, b);
  });

  app.delete("/api/tasks/:id", async (req) => {
    deleteTask(db, idParam.parse(req.params).id);
    return { ok: true };
  });
}

export function checkInRoutes(app: FastifyInstance, db: DB, deps: CheckInDeps) {
  app.get("/api/tracker-state", async () => trackerState(db));

  app.get("/api/check-ins", async () => ({ daily: latestCheckIn(db, "daily"), weekly: latestCheckIn(db, "weekly") }));

  // Both take a minute or so; the UI waits, since you pressed the button.
  app.post("/api/check-ins/daily", async () => runDailyCheckIn(db, deps));
  app.post("/api/check-ins/weekly", async () => runWeeklyReview(db, deps));
}
