import he from "he";
import { convert } from "html-to-text";
import type { BoardRef, FetchBoard, NormalizedPosting } from "./types";

// Public, documented, unauthenticated job-board APIs. These are the feeds the
// companies publish for exactly this purpose; no scraping, no logins, no
// LinkedIn. Response shapes checked against live responses on 2026-10-23.

const TIMEOUT_MS = 20_000;
const HEADERS = { Accept: "application/json", "User-Agent": "job-search-autopilot (personal use)" };

export function htmlToPlain(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
    ],
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const toDate = (v: string | number | null | undefined): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const joinLocations = (locs: (string | null | undefined)[]): string | null => {
  const unique = [...new Set(locs.map((l) => l?.trim()).filter((l): l is string => !!l))];
  return unique.length ? unique.join(" | ") : null;
};

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    // Node's fetch says only "fetch failed"; the useful part is in `cause`.
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const why = (err as Error).name === "TimeoutError" ? "timed out" : (cause?.code ?? cause?.message ?? (err as Error).message);
    throw new Error(`Couldn't reach the job board (${why}). Check your internet connection.`);
  }
  if (res.status === 404) throw new Error("Board not found (404). Check the board token on the Companies page.");
  if (!res.ok) throw new Error(`Job board returned HTTP ${res.status}`);
  return res.json();
}

// ---- Greenhouse: https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
type GreenhouseJob = {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string } | null;
  first_published?: string | null;
  updated_at?: string | null;
  content?: string | null; // HTML, entity-escaped once more
};

export function parseGreenhouse(data: unknown): NormalizedPosting[] {
  const jobs = (data as { jobs?: GreenhouseJob[] }).jobs ?? [];
  return jobs.map((j) => {
    const location = j.location?.name?.trim() || null;
    return {
      externalId: String(j.id),
      title: j.title.trim(),
      location,
      remote: /\bremote\b/i.test(location ?? ""),
      url: j.absolute_url,
      postedAt: toDate(j.first_published ?? j.updated_at),
      // Greenhouse escapes the HTML, so decode entities once before converting.
      description: htmlToPlain(he.decode(j.content ?? "")),
      employmentType: null,
    };
  });
}

// ---- Lever: https://api.lever.co/v0/postings/{token}?mode=json
type LeverPosting = {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  workplaceType?: string; // "remote" | "hybrid" | "onsite" | "unspecified"
  categories?: { location?: string; allLocations?: string[]; commitment?: string };
  descriptionPlain?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
};

export function parseLever(data: unknown): NormalizedPosting[] {
  const postings = (Array.isArray(data) ? data : []) as LeverPosting[];
  return postings.map((p) => {
    const lists = (p.lists ?? []).map((l) => `${l.text}\n${htmlToPlain(l.content)}`).join("\n\n");
    return {
      externalId: p.id,
      title: p.text.trim(),
      location: joinLocations([p.categories?.location, ...(p.categories?.allLocations ?? [])]),
      remote: p.workplaceType === "remote",
      url: p.hostedUrl,
      postedAt: toDate(p.createdAt),
      description: [p.descriptionPlain, lists, p.additionalPlain].filter(Boolean).join("\n\n").trim(),
      employmentType: p.categories?.commitment ?? null,
    };
  });
}

// ---- Ashby: https://api.ashbyhq.com/posting-api/job-board/{token}
type AshbyJob = {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  isRemote?: boolean;
  isListed?: boolean;
  workplaceType?: string;
  employmentType?: string; // "FullTime" | "PartTime" | "Intern" | "Contract" | "Temporary"
  jobUrl: string;
  publishedAt?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
};

const ASHBY_EMPLOYMENT: Record<string, string> = {
  FullTime: "Full-time",
  PartTime: "Part-time",
  Intern: "Internship",
  Contract: "Contract",
  Temporary: "Temporary",
};

export function parseAshby(data: unknown): NormalizedPosting[] {
  const jobs = (data as { jobs?: AshbyJob[] }).jobs ?? [];
  return jobs
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      externalId: j.id,
      title: j.title.trim(),
      location: joinLocations([j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)]),
      remote: j.isRemote === true || /remote/i.test(j.workplaceType ?? ""),
      url: j.jobUrl,
      postedAt: toDate(j.publishedAt),
      description: (j.descriptionPlain ?? htmlToPlain(j.descriptionHtml ?? "")).trim(),
      employmentType: j.employmentType ? (ASHBY_EMPLOYMENT[j.employmentType] ?? j.employmentType) : null,
    }));
}

export function boardUrl(board: BoardRef): string {
  const t = encodeURIComponent(board.token);
  switch (board.atsType) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`;
    case "lever":
      return `https://api.lever.co/v0/postings/${t}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${t}`;
  }
}

const PARSERS = { greenhouse: parseGreenhouse, lever: parseLever, ashby: parseAshby };

export const fetchBoard: FetchBoard = async (board) => PARSERS[board.atsType](await getJson(boardUrl(board)));
