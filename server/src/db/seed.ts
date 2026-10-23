import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { createDb, type DB } from "./client";
import { companies, settings } from "./schema";
import { DEFAULT_SETTINGS } from "../domain/settingsDefaults";
import { config } from "../config";

const csvRow = z.object({
  name: z.string().trim().min(1),
  website: z.string().trim().optional(),
  ats_type: z.enum(["greenhouse", "lever", "ashby", "other", ""]).optional(),
  ats_board_token: z.string().trim().optional(),
  tags: z.string().optional(),
  notes: z.string().optional(),
});

/**
 * Idempotent. Inserts the settings row if missing and any CSV company whose
 * name isn't already in the DB. Existing companies are never overwritten,
 * so edits made in the UI win over the CSV.
 */
export function seed(db: DB, csvPath = config.companySeedCsv) {
  const settingsInserted = db
    .insert(settings)
    .values({ id: 1, ...DEFAULT_SETTINGS })
    .onConflictDoNothing()
    .run().changes;

  let companiesInserted = 0;
  if (fs.existsSync(csvPath)) {
    const rows = parse(fs.readFileSync(csvPath, "utf8"), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as unknown[];
    for (const raw of rows) {
      const row = csvRow.parse(raw);
      const result = db
        .insert(companies)
        .values({
          name: row.name,
          website: row.website || null,
          atsType: row.ats_type || null,
          atsBoardToken: row.ats_board_token || null,
          tags: (row.tags ?? "")
            .split(/[;,]/)
            .map((t) => t.trim())
            .filter(Boolean),
          notes: row.notes || null,
        })
        // The only unique constraint besides the PK is lower(name), so this
        // skips companies that already exist under any capitalization.
        .onConflictDoNothing()
        .run();
      companiesInserted += result.changes;
    }
  }
  return { settingsInserted, companiesInserted };
}

// Run directly: `npm run db:seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = seed(createDb());
  console.log(
    `Seed done: settings row ${result.settingsInserted ? "created" : "already present"}, ` +
      `${result.companiesInserted} new companies.`
  );
}
