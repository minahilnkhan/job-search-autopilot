import type { Ats } from "../../../shared/types";

// Where the application form lives. For job-board jobs we build the ATS's own
// hosted form URL from the board token and job id we already store, instead of
// the posting's absolute_url: company careers pages often wrap the form in an
// iframe or redirect, which makes prefilling flaky.

export type ApplyTarget = { ats: Ats; url: string };

export function applyTarget(job: { source: string; externalId: string | null; url: string | null }, boardToken: string | null): ApplyTarget | null {
  const id = job.externalId;
  if (boardToken && id) {
    const t = encodeURIComponent(boardToken);
    if (job.source === "greenhouse") return { ats: "greenhouse", url: `https://job-boards.greenhouse.io/${t}/jobs/${encodeURIComponent(id)}` };
    if (job.source === "lever") return { ats: "lever", url: `https://jobs.lever.co/${t}/${encodeURIComponent(id)}/apply` };
    if (job.source === "ashby") return { ats: "ashby", url: `https://jobs.ashbyhq.com/${t}/${encodeURIComponent(id)}/application` };
  }
  if (!job.url) return null;
  return fromUrl(job.url);
}

/** A pasted job: work out the ATS from the URL, and go to its form page. */
export function fromUrl(raw: string): ApplyTarget | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);

  if (host.endsWith("greenhouse.io")) {
    // boards.greenhouse.io/{t}/jobs/{id} and job-boards.greenhouse.io/{t}/jobs/{id}
    const j = parts.indexOf("jobs");
    if (j > 0 && parts[j + 1]) return { ats: "greenhouse", url: `https://job-boards.greenhouse.io/${parts[0]}/jobs/${parts[j + 1]}` };
    const ghJid = u.searchParams.get("token") ?? u.searchParams.get("gh_jid");
    const board = u.searchParams.get("for");
    if (board && ghJid) return { ats: "greenhouse", url: `https://job-boards.greenhouse.io/${board}/jobs/${ghJid}` };
    return { ats: "greenhouse", url: u.toString() };
  }
  if (host === "jobs.lever.co" && parts.length >= 2) {
    return { ats: "lever", url: `https://jobs.lever.co/${parts[0]}/${parts[1]}/apply` };
  }
  if (host === "jobs.ashbyhq.com" && parts.length >= 2) {
    return { ats: "ashby", url: `https://jobs.ashbyhq.com/${parts[0]}/${parts[1]}/application` };
  }
  return { ats: "other", url: u.toString() };
}
