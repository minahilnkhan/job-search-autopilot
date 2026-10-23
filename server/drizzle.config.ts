import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // Used by `npm run db:studio` to browse the local database.
  dbCredentials: { url: process.env.DATABASE_PATH ? `../${process.env.DATABASE_PATH}` : "../data/autopilot.db" },
});
