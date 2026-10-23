import type { FastifyInstance } from "fastify";
import type { DB } from "../db/client";
import { getJob } from "../services/jobs";
import { getShortlist, isPipelineRunning, listRuns, runPipeline, scoreJob, type PipelineDeps } from "../services/pipeline";
import { getSettings } from "../services/settings";
import { monthSpend } from "../services/usage";
import { ConflictError } from "../services/jobs";
import { idParam } from "./validation";

export function pipelineRoutes(app: FastifyInstance, db: DB, deps: PipelineDeps) {
  // A run takes minutes (fetching boards, then scoring), so start it and
  // return; the UI polls /api/pipeline/runs.
  app.post("/api/pipeline/run", async (_req, reply) => {
    if (isPipelineRunning()) throw new ConflictError("A run is already in progress.");
    void runPipeline(db, deps, "manual").catch((err) => app.log.error(err));
    reply.code(202);
    return { started: true };
  });

  app.get("/api/pipeline/runs", async () => ({ running: isPipelineRunning(), runs: listRuns(db) }));

  app.get("/api/shortlist", async (req) => {
    const { date } = req.query as { date?: string };
    return getShortlist(db, date);
  });

  // Score one job now, e.g. right after pasting it.
  app.post("/api/jobs/:id/score", async (req) => {
    const { id } = idParam.parse(req.params);
    const s = deps.getScorer(getSettings(db));
    if ("unavailable" in s) throw new ConflictError(`Can't score yet: ${s.unavailable}`);
    await scoreJob(db, id, s.scorer, new Date());
    return getJob(db, id);
  });

  app.get("/api/usage/month", async () => monthSpend(db, new Date()));
}
