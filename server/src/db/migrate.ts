import { createDb, runMigrations } from "./client";
import { config } from "../config";

runMigrations(createDb());
console.log(`Migrations applied to ${config.databasePath}`);
