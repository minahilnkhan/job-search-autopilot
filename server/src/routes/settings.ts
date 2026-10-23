import type { FastifyInstance } from "fastify";
import type { DB } from "../db/client";
import { settings } from "../db/schema";
import { getSettings } from "../services/settings";
import { rebuildTodaysShortlist } from "../services/pipeline";
import { settingsBody } from "./validation";

export function settingsRoutes(app: FastifyInstance, db: DB, onChange?: () => void) {
  app.get("/api/settings", async () => getSettings(db));

  app.put("/api/settings", async (req) => {
    const body = settingsBody.parse(req.body);
    db.insert(settings)
      .values({ id: 1, ...body })
      .onConflictDoUpdate({ target: settings.id, set: body })
      .run();
    onChange?.(); // e.g. reschedule the daily run if its time changed
    rebuildTodaysShortlist(db); // new score/age thresholds apply to today's picks right away
    return getSettings(db);
  });
}
