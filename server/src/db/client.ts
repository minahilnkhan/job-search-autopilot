import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import { config } from "../config";

export type DB = ReturnType<typeof createDb>;

/**
 * Opens a database. Takes a path (or ":memory:") instead of reading a global,
 * so tests get a fresh in-memory DB and the server gets the file on disk.
 */
export function createDb(file: string = config.databasePath) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export function runMigrations(db: DB) {
  migrate(db, { migrationsFolder: config.migrationsFolder });
}
