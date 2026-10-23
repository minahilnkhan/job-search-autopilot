import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db/client";
import {
  applicationFile,
  approveApplication,
  editApplication,
  finalizeApplication,
  getApplication,
  listApplications,
  overrideTruthCheck,
  prepareApplication,
  rejectApplication,
  snoozeApplication,
  unapproveApplication,
  type PrepDeps,
} from "../services/applications";
import { getBase, saveBase } from "../services/resumes";
import { ResumeFormatError } from "../domain/resumeFormat";
import { ConflictError, NotFoundError } from "../services/jobs";
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
  // Accept → prepare. Tier A calls the tailoring model, so this can take ~20–40s.
  app.post("/api/applications", async (req, reply) => {
    const { jobId } = z.object({ jobId: z.number().int().positive() }).parse(req.body);
    const id = await prepareApplication(db, jobId, deps);
    reply.code(201);
    return getApplication(db, id);
  });

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
        answers: z.array(z.object({ index: z.number().int().min(0), answer: z.string() })).optional(),
        lines: z.array(z.object({ id: z.string(), text: z.string().min(1) })).optional(),
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
