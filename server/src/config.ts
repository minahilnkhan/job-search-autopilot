import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo root, resolved from this file so paths don't depend on which
// directory npm happened to run the script from.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const config = {
  port: Number(process.env.PORT ?? 3001),
  databasePath: path.resolve(ROOT, process.env.DATABASE_PATH ?? "data/autopilot.db"),
  migrationsFolder: path.resolve(ROOT, "server/drizzle"),
  companySeedCsv: path.resolve(ROOT, "data/companies.seed.csv"),
  privateDir: path.resolve(ROOT, "data/private"),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || null,
};
