import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { settings } from "../db/schema";
import { DEFAULT_SETTINGS } from "../domain/settingsDefaults";

// The Chrome extension proves it's yours with a pairing code you copy from
// Settings. Every extension request carries it; nothing else gets your
// details out of the app.

function ensureRow(db: DB) {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (!row) db.insert(settings).values({ id: 1, ...DEFAULT_SETTINGS }).run();
}

export function getPairingCode(db: DB): string {
  ensureRow(db);
  const row = db.select({ t: settings.extensionToken }).from(settings).where(eq(settings.id, 1)).get();
  if (row?.t) return row.t;
  return newPairingCode(db);
}

export function newPairingCode(db: DB): string {
  ensureRow(db);
  const code = crypto.randomBytes(18).toString("base64url");
  db.update(settings).set({ extensionToken: code }).where(eq(settings.id, 1)).run();
  return code;
}

export function checkPairingCode(db: DB, given: string | undefined): boolean {
  const row = db.select({ t: settings.extensionToken }).from(settings).where(eq(settings.id, 1)).get();
  if (!row?.t || !given) return false;
  const a = Buffer.from(row.t);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
