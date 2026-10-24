import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db/client";
import { ConflictError } from "../services/jobs";
import {
  getSubmitSession,
  listTracked,
  markSubmitted,
  openAndPrefill,
  setTrackedStatus,
  unmarkSubmitted,
  updateFollowUp,
  type SubmitDeps,
} from "../services/submissions";

const idParam = z.object({ id: z.coerce.number().int().positive() });

export function submissionRoutes(app: FastifyInstance, db: DB, deps: SubmitDeps | undefined) {
  // Opens the form in a browser window and starts filling it; poll the GET for progress.
  app.post("/api/applications/:id/submit/open", async (req, reply) => {
    if (!deps) throw new ConflictError("Assisted submit isn't available in this setup.");
    reply.code(202);
    return openAndPrefill(db, idParam.parse(req.params).id, deps);
  });
  app.get("/api/applications/:id/submit", async (req) => getSubmitSession(db, idParam.parse(req.params).id));
  app.post("/api/applications/:id/submitted", async (req) => markSubmitted(db, idParam.parse(req.params).id));
  app.post("/api/applications/:id/unsubmit", async (req) => unmarkSubmitted(db, idParam.parse(req.params).id));

  app.get("/api/tracker", async () => listTracked(db));
  app.post("/api/applications/:id/status", async (req) => {
    const { status } = z.object({ status: z.enum(["screen", "interview", "offer", "rejected", "ghosted", "withdrawn"]) }).parse(req.body);
    return setTrackedStatus(db, idParam.parse(req.params).id, status);
  });
  app.post("/api/applications/:id/follow-up", async (req) => {
    const { action } = z.object({ action: z.enum(["done", "later"]) }).parse(req.body);
    return updateFollowUp(db, idParam.parse(req.params).id, action);
  });
}
