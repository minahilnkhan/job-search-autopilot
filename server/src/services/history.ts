import { and, eq, inArray, ne } from "drizzle-orm";
import type { DB } from "../db/client";
import { applications, jobs } from "../db/schema";
import { normalizeTitle } from "../domain/normalize";

// "Applied" means you approved it or it went further. Drafts and items still
// in the review queue don't count against the per-company cap.
export const COUNTS_AS_APPLIED = [
  "approved",
  "submitted",
  "screen",
  "interview",
  "offer",
  "rejected",
  "ghosted",
  "withdrawn",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function applicationHistory(
  db: DB,
  args: { companyId: number; title: string; excludeJobId?: number; now: Date }
) {
  const rows = db
    .select({
      jobId: jobs.id,
      title: jobs.title,
      approvedAt: applications.approvedAt,
      submittedAt: applications.submittedAt,
    })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(
      and(
        eq(jobs.companyId, args.companyId),
        inArray(applications.status, [...COUNTS_AS_APPLIED]),
        args.excludeJobId !== undefined ? ne(jobs.id, args.excludeJobId) : undefined
      )
    )
    .all();

  const cutoff = args.now.getTime() - 30 * DAY_MS;
  const title = normalizeTitle(args.title);
  return {
    // Same company + same normalized title, any location: a re-post of a role
    // you already applied to.
    alreadyApplied: rows.some((r) => normalizeTitle(r.title) === title),
    // Window is inclusive: an application exactly 30 days ago still counts.
    companyAppsLast30Days: rows.filter((r) => {
      const at = r.submittedAt ?? r.approvedAt;
      return at !== null && at.getTime() >= cutoff;
    }).length,
  };
}
