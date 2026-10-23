import Fastify from "fastify";
import { ZodError } from "zod";
import type { DB } from "./db/client";
import { jobRoutes } from "./routes/jobs";
import { companyRoutes } from "./routes/companies";
import { settingsRoutes } from "./routes/settings";
import { ConflictError, NotFoundError } from "./services/jobs";

/**
 * Builds the app around a given DB. Tests pass an in-memory DB and call
 * app.inject(), so route tests run without a port or a file on disk.
 */
export function buildApp(db: DB, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid input",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof ConflictError) return reply.code(409).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "Internal error" });
  });

  app.get("/api/health", async () => ({ ok: true }));
  jobRoutes(app, db);
  companyRoutes(app, db);
  settingsRoutes(app, db);
  return app;
}
