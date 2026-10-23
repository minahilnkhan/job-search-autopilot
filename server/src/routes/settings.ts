import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { settings } from "../db/schema";
import { DEFAULT_SETTINGS } from "../domain/settingsDefaults";
import { settingsBody } from "./validation";
import type { Settings } from "../../../shared/types";

export function getSettings(db: DB): Settings {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (!row) return DEFAULT_SETTINGS;
  const { id: _id, ...rest } = row;
  return rest;
}

export function settingsRoutes(app: FastifyInstance, db: DB) {
  app.get("/api/settings", async () => getSettings(db));

  app.put("/api/settings", async (req) => {
    const body = settingsBody.parse(req.body);
    db.insert(settings)
      .values({ id: 1, ...body })
      .onConflictDoUpdate({ target: settings.id, set: body })
      .run();
    return getSettings(db);
  });
}
