import Fastify from "fastify";
import { ZodError } from "zod";
import type { DB } from "./db/client";
import { jobRoutes } from "./routes/jobs";
import { companyRoutes } from "./routes/companies";
import { settingsRoutes } from "./routes/settings";
import { pipelineRoutes } from "./routes/pipeline";
import { applicationRoutes } from "./routes/applications";
import { submissionRoutes } from "./routes/submissions";
import { extensionRoutes } from "./routes/extension";
import { checkInRoutes, projectRoutes, trackingRoutes } from "./routes/tracking";
import type { CheckInDeps } from "./services/checkIns";
import type { SubmitDeps } from "./services/submissions";
import type { PrepDeps } from "./services/applications";
import { TransitionError } from "./domain/applicationStatus";
import { MissingInventoryError } from "./services/truth";
import { ConflictError, NotFoundError } from "./services/jobs";
import type { PipelineDeps } from "./services/pipeline";

/**
 * Builds the app around a given DB. Tests pass an in-memory DB and call
 * app.inject(), so route tests run without a port or a file on disk.
 */
export function buildApp(
  db: DB,
  opts: { logger?: boolean; pipeline: PipelineDeps; prep: PrepDeps; submit?: SubmitDeps; checkIn?: CheckInDeps; onSettingsChanged?: () => void }
) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid input",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof ConflictError || err instanceof TransitionError || err instanceof MissingInventoryError) {
      return reply.code(409).send({ error: err.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "Internal error" });
  });

  // Only answer requests addressed to this machine. Blocks DNS-rebinding,
  // where a web page points its own domain at 127.0.0.1 to read the API.
  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return reply.code(403).send({ error: "Forbidden" });
  });

  app.get("/api/health", async () => ({ ok: true }));
  jobRoutes(app, db);
  companyRoutes(app, db);
  settingsRoutes(app, db, opts.onSettingsChanged);
  pipelineRoutes(app, db, opts.pipeline);
  applicationRoutes(app, db, opts.prep);
  submissionRoutes(app, db, opts.submit);
  extensionRoutes(app, db, opts.submit, opts.prep);
  trackingRoutes(app, db);
  projectRoutes(app, db);
  checkInRoutes(app, db, opts.checkIn ?? {});
  return app;
}
