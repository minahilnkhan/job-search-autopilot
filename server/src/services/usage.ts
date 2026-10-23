import { and, gte, lt, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { apiUsage } from "../db/schema";
import { costUsd, type TokenUsage } from "../llm/pricing";

export function recordUsage(
  db: DB,
  args: { purpose: string; model: string; usage: TokenUsage; jobId?: number; now: Date }
): number | null {
  const cost = costUsd(args.model, args.usage);
  db.insert(apiUsage)
    .values({
      at: args.now,
      purpose: args.purpose,
      model: args.model,
      ...args.usage,
      costUsd: cost,
      jobId: args.jobId ?? null,
    })
    .run();
  return cost;
}

/** Spend for the calendar month containing `now` (server local time). */
export function monthSpend(db: DB, now: Date) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const row = db
    .select({
      calls: sql<number>`count(*)`,
      costUsd: sql<number>`coalesce(sum(${apiUsage.costUsd}), 0)`,
      unpriced: sql<number>`sum(case when ${apiUsage.costUsd} is null then 1 else 0 end)`,
    })
    .from(apiUsage)
    .where(and(gte(apiUsage.at, start), lt(apiUsage.at, end)))
    .get();
  return { month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`, calls: row?.calls ?? 0, costUsd: row?.costUsd ?? 0, unpricedCalls: row?.unpriced ?? 0 };
}
