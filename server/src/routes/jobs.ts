import type { FastifyInstance } from "fastify";
import type { DB } from "../db/client";
import { extractFields } from "../domain/extract";
import { runHardFilters } from "../domain/hardFilters";
import { applicationHistory } from "../services/history";
import { createJob, deleteJobs, getJob, listJobs, overrideFilters, updateJob } from "../services/jobs";
import { getSettings } from "../services/settings";
import { z } from "zod";
import { companies } from "../db/schema";
import { sql } from "drizzle-orm";
import { createJobBody, extractBody, idParam, patchJobBody, previewBody } from "./validation";

export function jobRoutes(app: FastifyInstance, db: DB) {
  // Delete several jobs at once (Jobs page, select all). Submitted ones are kept.
  // "Continue anyway" past a failed hard filter (or undo it).
  app.post("/api/jobs/:id/continue", async (req) => {
    const { on } = z.object({ on: z.boolean().default(true) }).parse(req.body ?? {});
    return overrideFilters(db, idParam.parse(req.params).id, on);
  });

  app.post("/api/jobs/delete", async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).min(1).max(5000) }).parse(req.body);
    return deleteJobs(db, ids);
  });

  // Step 1 of manual paste: regex extraction to prefill the review form. Nothing is saved.
  app.post("/api/jobs/extract", async (req) => {
    const body = extractBody.parse(req.body);
    return { fields: extractFields(body) };
  });

  // Step 2: live filter preview while you edit fields. Nothing is saved.
  app.post("/api/jobs/preview", async (req) => {
    const body = previewBody.parse(req.body);
    const company = db
      .select()
      .from(companies)
      .where(sql`lower(${companies.name}) = lower(${body.companyName})`)
      .get();
    const history = company
      ? applicationHistory(db, { companyId: company.id, title: body.title, now: new Date() })
      : { alreadyApplied: false, companyAppsLast30Days: 0 };
    return runHardFilters({
      title: body.title,
      location: body.location?.trim() || null,
      fields: body.fields,
      company: { eVerify: company?.eVerify ?? "unknown" },
      history,
      otherCountries: getSettings(db).locationPrefs.otherCountries,
    });
  });

  // Step 3: save. Returns { duplicate: true, job } instead of inserting a second copy.
  app.post("/api/jobs", async (req, reply) => {
    const body = createJobBody.parse(req.body);
    const result = createJob(db, body);
    reply.code(result.duplicate ? 200 : 201);
    return result;
  });

  app.get("/api/jobs", async (req) => {
    const q = req.query as { includeOffTarget?: string };
    return listJobs(db, { includeOffTarget: q.includeOffTarget === "1" });
  });

  app.get("/api/jobs/:id", async (req) => getJob(db, idParam.parse(req.params).id));

  app.patch("/api/jobs/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    return updateJob(db, id, patchJobBody.parse(req.body));
  });
}
