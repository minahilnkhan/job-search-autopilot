import { buildApp } from "./app";
import { createDb, runMigrations } from "./db/client";
import { seed } from "./db/seed";
import { config } from "./config";

const db = createDb();
// Migrate + seed on boot so a fresh clone works with just `npm run dev`.
// Both are idempotent.
runMigrations(db);
seed(db);

const app = buildApp(db, { logger: true });
// Bind to localhost only: this is a personal tool with no auth.
await app.listen({ port: config.port, host: "127.0.0.1" });
