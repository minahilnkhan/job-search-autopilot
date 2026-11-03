import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db/client";
import { idParam } from "./validation";
import { CONTACT_RELATIONSHIPS } from "../../../shared/types";
import { addContact, advance, editOutreach, networkState, redraft, removeOutreach, type NetworkDeps } from "../services/network";

const text = (max: number) => z.string().max(max);

export function networkRoutes(app: FastifyInstance, db: DB, deps: NetworkDeps) {
  app.get("/api/network", async () => networkState(db, deps));

  // Add a person you picked (for a role, or with no role for plain networking).
  app.post("/api/network/contacts", async (req) => {
    const body = z
      .object({
        applicationId: z.number().int().positive().nullable().optional(),
        linkedinUrl: text(500).min(1),
        name: text(120).trim().min(1),
        headline: text(300).nullable().optional(),
        relationship: z.enum(CONTACT_RELATIONSHIPS),
        about: text(4000).nullable().optional(),
      })
      .parse(req.body);
    return addContact(db, deps, body);
  });

  app.post("/api/network/outreach/:id/draft", async (req) => redraft(db, deps, idParam.parse(req.params).id));

  app.patch("/api/network/outreach/:id", async (req) => {
    const body = z
      .object({ note: text(1000).optional(), ask: text(3000).optional(), followUp: text(2000).optional(), about: text(4000).nullable().optional(), headline: text(300).nullable().optional() })
      .parse(req.body);
    return editOutreach(db, deps, idParam.parse(req.params).id, body);
  });

  // Something happened on LinkedIn: you sent a message, they accepted, they replied.
  app.post("/api/network/outreach/:id/:action", async (req) => {
    const { id, action } = z
      .object({ id: z.coerce.number().int().positive(), action: z.enum(["invite", "accepted", "message", "follow_up", "replied", "referred", "declined", "no_reply"]) })
      .parse(req.params);
    return advance(db, id, action);
  });

  app.delete("/api/network/outreach/:id", async (req) => removeOutreach(db, idParam.parse(req.params).id));
}
