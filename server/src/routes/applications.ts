import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db/client";
import {
  answerTailoringQuestion,
  skillsToBuild,
  applicationFile,
  approveApplication,
  editApplication,
  finalizeApplication,
  getApplication,
  listApplications,
  overrideTruthCheck,
  prepareApplication,
  redraftNote,
  suggestNote,
  rejectApplication,
  restartApplication,
  snoozeApplication,
  unapproveApplication,
  type PrepDeps,
} from "../services/applications";
import { getBase, saveBase } from "../services/resumes";
import { ResumeFormatError } from "../domain/resumeFormat";
import { ConflictError, NotFoundError, getJob } from "../services/jobs";
import { jobs } from "../db/schema";
import { idParam } from "./validation";
import { resumeVersions } from "../db/schema";
import { eq } from "drizzle-orm";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const baseParam = z.object({ type: z.enum(["fde", "swe"]) });

function sendFile(reply: import("fastify").FastifyReply, file: { path: string; filename: string }, inline: boolean) {
  const type = file.path.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return reply
    .header("Content-Type", type)
    .header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${file.filename}"`)
    .header("Cache-Control", "no-store")
    .send(fs.readFileSync(file.path));
}

export function applicationRoutes(app: FastifyInstance, db: DB, deps: PrepDeps) {
  // ---- Base resumes
  app.get("/api/resumes/bases", async () => [getBase(db, "fde"), getBase(db, "swe")]);

  app.put("/api/resumes/bases/:type", async (req) => {
    const { type } = baseParam.parse(req.params);
    const { text } = z.object({ text: z.string().min(1) }).parse(req.body);
    try {
      return await saveBase(db, type, text, deps);
    } catch (err) {
      if (err instanceof ResumeFormatError) throw new ConflictError(err.message);
      throw err;
    }
  });

  app.get("/api/resumes/bases/:type/file.:kind", async (req, reply) => {
    const { type } = baseParam.parse(req.params);
    const kind = z.enum(["pdf", "docx"]).parse((req.params as { kind: string }).kind);
    const base = getBase(db, type);
    const row = base.id ? db.select().from(resumeVersions).where(eq(resumeVersions.id, base.id)).get() : undefined;
    const p = kind === "pdf" ? row?.filePathPdf : row?.filePathDocx;
    if (!row || !p || !fs.existsSync(p)) throw new NotFoundError(`No ${kind.toUpperCase()} for the ${type.toUpperCase()} base yet`);
    return sendFile(reply, { path: p, filename: `${row.content.name.replace(/[^A-Za-z0-9]+/g, "_")}_Resume_${type.toUpperCase()}.${kind}` }, kind === "pdf");
  });

  // ---- Applications
  // Preparing runs in the background so Accept returns at once (Tier A
  // tailoring takes ~20–40s). The Review page lists what's in progress.
  type Preparing = { jobId: number; jobTitle: string; companyName: string; startedAt: number; error: string | null };
  const preparing = new Map<number, Preparing>();

  app.post("/api/applications", async (req, reply) => {
    const { jobId, background } = z.object({ jobId: z.number().int().positive(), background: z.boolean().optional() }).parse(req.body);
    if (!background) {
      const id = await prepareApplication(db, jobId, deps);
      reply.code(201);
      return getApplication(db, id);
    }
    const job = getJob(db, jobId);
    if (!job.hardFilterPass) throw new ConflictError("This job fails a hard filter. Correct its fields first.");
    if (preparing.get(jobId)?.error === null) return reply.code(202).send({ jobId, preparing: true });
    db.update(jobs).set({ status: "shortlisted" }).where(eq(jobs.id, jobId)).run(); // leaves the deck right away
    const entry: Preparing = { jobId, jobTitle: job.title, companyName: job.companyName, startedAt: Date.now(), error: null };
    preparing.set(jobId, entry);
    void prepareApplication(db, jobId, deps)
      .then(() => preparing.delete(jobId))
      .catch((err) => {
        entry.error = (err as Error).message;
      });
    return reply.code(202).send({ jobId, preparing: true });
  });

  app.get("/api/applications/preparing", async () => [...preparing.values()]);

  // Dismiss a failed preparation (the job goes back to the deck).
  app.delete("/api/applications/preparing/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    preparing.delete(id);
    db.update(jobs).set({ status: "new" }).where(eq(jobs.id, id)).run();
    return { ok: true };
  });

  app.post("/api/applications/:id/note", async (req) => redraftNote(db, idParam.parse(req.params).id, deps));
  // "Suggest an edit": a rewrite following your instructions, not saved until you use it.
  app.post("/api/applications/:id/note/suggest", async (req) => {
    const b = z.object({ instructions: z.string().trim().min(1).max(2000), currentNote: z.string().max(4000).nullable().optional() }).parse(req.body);
    return suggestNote(db, idParam.parse(req.params).id, b.instructions, b.currentNote ?? null, deps);
  });
  // Assumption protocol: confirm or decline one question or suggested skill.
  app.post("/api/applications/:id/tailoring/answer", async (req) => {
    const b = z
      .object({
        kind: z.enum(["assumption", "skill"]),
        index: z.number().int().min(0),
        confirmed: z.boolean(),
        answer: z.string().max(2000).optional(),
        text: z.string().max(600).optional(),
      })
      .parse(req.body);
    return answerTailoringQuestion(db, idParam.parse(req.params).id, b, deps);
  });
  app.get("/api/skills-to-build", async () => skillsToBuild(db));
  app.post("/api/applications/:id/restart", async (req) => restartApplication(db, idParam.parse(req.params).id, deps));

  app.get("/api/applications", async (req) => {
    const { view } = z.object({ view: z.enum(["review", "blocked", "snoozed", "approved", "closed"]).default("review") }).parse(req.query);
    return listApplications(db, view);
  });

  app.get("/api/applications/:id", async (req) => getApplication(db, idParam.parse(req.params).id));

  app.patch("/api/applications/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        recruiterNote: z.string().nullable().optional(),
        noteBasis: z.object({ companyValue: z.string(), valueSource: z.string(), story: z.string(), standout: z.string() }).nullable().optional(),
        contact: z.string().min(1).optional(),
        answers: z.array(z.object({ index: z.number().int().min(0), answer: z.string() })).optional(),
        lines: z.array(z.object({ id: z.string(), text: z.string() })).optional(), // empty text = delete the line
      })
      .parse(req.body);
    return editApplication(db, id, body, deps);
  });

  app.post("/api/applications/:id/regenerate", async (req) => {
    const { id } = idParam.parse(req.params);
    await finalizeApplication(db, id, deps);
    return getApplication(db, id);
  });

  app.post("/api/applications/:id/override", async (req) => {
    const { id } = idParam.parse(req.params);
    const { reason } = z.object({ reason: z.string() }).parse(req.body);
    return overrideTruthCheck(db, id, reason, deps);
  });

  app.post("/api/applications/:id/approve", async (req) => approveApplication(db, idParam.parse(req.params).id));
  app.post("/api/applications/:id/unapprove", async (req) => unapproveApplication(db, idParam.parse(req.params).id));

  app.post("/api/applications/:id/reject", async (req) => {
    const { id } = idParam.parse(req.params);
    const { reason } = z.object({ reason: z.string() }).parse(req.body);
    return rejectApplication(db, id, reason);
  });

  app.post("/api/applications/:id/snooze", async (req) => {
    const { id } = idParam.parse(req.params);
    const { until } = z.object({ until: ymd.nullable() }).parse(req.body);
    return snoozeApplication(db, id, until);
  });

  app.get("/api/applications/:id/resume.:kind", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const kind = z.enum(["pdf", "docx"]).parse((req.params as { kind: string }).kind);
    return sendFile(reply, applicationFile(db, id, kind), kind === "pdf");
  });
}
