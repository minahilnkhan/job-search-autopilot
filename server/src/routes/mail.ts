import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db/client";
import { idParam } from "./validation";
import { acceptSuggestion, dismissSuggestion, inboxState, runMailCheck, type MailDeps } from "../services/mail";

export function mailRoutes(app: FastifyInstance, db: DB, deps: MailDeps) {
  app.get("/api/inbox", async () => inboxState(db, deps));

  // The check runs on its own at 8pm; this is for trying the setup.
  app.post("/api/inbox/check", async () => runMailCheck(db, deps, "manual"));

  app.post("/api/inbox/:id/accept", async (req) => {
    const { applicationId } = z.object({ applicationId: z.number().int().positive().optional() }).parse(req.body ?? {});
    return acceptSuggestion(db, idParam.parse(req.params).id, applicationId);
  });

  app.post("/api/inbox/:id/dismiss", async (req) => dismissSuggestion(db, idParam.parse(req.params).id));
}
