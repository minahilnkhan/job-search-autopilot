import type {
  ApplicationDetail,
  ApplicationSummary,
  BaseResume,
  BaseType,
  Company,
  CreateJobRequest,
  CreateJobResponse,
  ExtractRequest,
  ExtractedFields,
  FilterReason,
  Job,
  JobListItem,
  PipelineProgress,
  PipelineRun,
  Settings,
  Shortlist,
  SubmitSession,
  TrackedApplication,
} from "../../../shared/types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public issues: { path: string; message: string }[] = []
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issues = data.issues ?? [];
    const detail = issues.length ? issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join("; ") : "";
    throw new ApiError(detail || data.error || `Request failed (${res.status})`, res.status, issues);
  }
  return data as T;
}

export type FilterResult = { pass: boolean; reasons: FilterReason[] };

export const api = {
  extract: (body: ExtractRequest) => request<{ fields: ExtractedFields }>("POST", "/api/jobs/extract", body),
  preview: (body: { companyName: string; title: string; location?: string; fields: ExtractedFields }) =>
    request<FilterResult>("POST", "/api/jobs/preview", body),
  createJob: (body: CreateJobRequest) => request<CreateJobResponse>("POST", "/api/jobs", body),
  listJobs: (includeOffTarget = false) => request<JobListItem[]>("GET", `/api/jobs${includeOffTarget ? "?includeOffTarget=1" : ""}`),
  getJob: (id: number) => request<Job>("GET", `/api/jobs/${id}`),
  scoreJob: (id: number) => request<Job>("POST", `/api/jobs/${id}/score`, {}),
  updateJob: (id: number, body: Partial<Pick<Job, "title" | "location" | "url" | "status">> & { fields?: ExtractedFields }) =>
    request<Job>("PATCH", `/api/jobs/${id}`, body),
  listCompanies: () => request<Company[]>("GET", "/api/companies"),
  createCompany: (body: Partial<Company> & { name: string }) => request<Company>("POST", "/api/companies", body),
  updateCompany: (id: number, body: Partial<Company>) =>
    request<{ company: Company; refilteredJobs: number }>("PATCH", `/api/companies/${id}`, body),
  continueAnyway: (id: number, on: boolean) => request<Job>("POST", `/api/jobs/${id}/continue`, { on }),
  deleteJobs: (ids: number[]) => request<{ deleted: number; kept: { id: number; title: string; reason: string }[] }>("POST", "/api/jobs/delete", { ids }),
  pairingCode: () => request<{ code: string }>("GET", "/api/extension-pairing"),
  newPairingCode: () => request<{ code: string }>("POST", "/api/extension-pairing/new", {}),
  getSettings: () => request<Settings>("GET", "/api/settings"),
  saveSettings: (body: Settings) => request<Settings>("PUT", "/api/settings", body),
  runPipeline: () => request<{ started: boolean }>("POST", "/api/pipeline/run", {}),
  listRuns: () => request<{ running: boolean; progress: PipelineProgress | null; runs: PipelineRun[] }>("GET", "/api/pipeline/runs"),
  stopPipeline: () => request<{ stopping: boolean }>("POST", "/api/pipeline/stop", {}),
  getShortlist: () => request<Shortlist | null>("GET", "/api/shortlist"),
  // Phase 3
  bases: () => request<BaseResume[]>("GET", "/api/resumes/bases"),
  saveBase: (type: BaseType, text: string) => request<BaseResume>("PUT", `/api/resumes/bases/${type}`, { text }),
  prepare: (jobId: number) => request<ApplicationDetail>("POST", "/api/applications", { jobId }),
  /** Accept from the deck: returns at once; the application appears in Review when ready. */
  prepareInBackground: (jobId: number) => request<{ jobId: number; preparing: boolean }>("POST", "/api/applications", { jobId, background: true }),
  preparing: () =>
    request<{ jobId: number; jobTitle: string; companyName: string; startedAt: number; error: string | null }[]>("GET", "/api/applications/preparing"),
  dismissPreparing: (jobId: number) => request<{ ok: boolean }>("DELETE", `/api/applications/preparing/${jobId}`),
  refillShortlist: () => request<Shortlist | null>("POST", "/api/shortlist/refill", {}),
  answerTailoring: (id: number, body: { kind: "assumption" | "skill"; index: number; confirmed: boolean; answer?: string; text?: string }) =>
    request<ApplicationDetail>("POST", `/api/applications/${id}/tailoring/answer`, body),
  skillsToBuild: () => request<{ skill: string; count: number; companies: string[]; listed: boolean }[]>("GET", "/api/skills-to-build"),
  restart: (id: number) => request<ApplicationDetail>("POST", `/api/applications/${id}/restart`, {}),
  applications: (view: "review" | "blocked" | "snoozed" | "approved" | "closed") =>
    request<ApplicationSummary[]>("GET", `/api/applications?view=${view}`),
  application: (id: number) => request<ApplicationDetail>("GET", `/api/applications/${id}`),
  editApplication: (
    id: number,
    body: { contact?: string; answers?: { index: number; answer: string }[]; lines?: { id: string; text: string }[] }
  ) => request<ApplicationDetail>("PATCH", `/api/applications/${id}`, body),
  regenerate: (id: number) => request<ApplicationDetail>("POST", `/api/applications/${id}/regenerate`, {}),
  override: (id: number, reason: string) => request<ApplicationDetail>("POST", `/api/applications/${id}/override`, { reason }),
  approve: (id: number) => request<ApplicationDetail>("POST", `/api/applications/${id}/approve`, {}),
  unapprove: (id: number) => request<ApplicationDetail>("POST", `/api/applications/${id}/unapprove`, {}),
  reject: (id: number, reason: string) => request<ApplicationDetail>("POST", `/api/applications/${id}/reject`, { reason }),
  snooze: (id: number, until: string | null) => request<ApplicationDetail>("POST", `/api/applications/${id}/snooze`, { until }),
  // Phase 4
  openToSubmit: (id: number) => request<SubmitSession>("POST", `/api/applications/${id}/submit/open`, {}),
  answerAsk: (id: number, askId: string, answer: string, remember: boolean) =>
    request<SubmitSession>("POST", `/api/applications/${id}/submit/answer`, { askId, answer, remember }),
  submitSession: (id: number) => request<SubmitSession>("GET", `/api/applications/${id}/submit`),
  markSubmitted: (id: number) => request<ApplicationDetail>("POST", `/api/applications/${id}/submitted`, {}),
  unmarkSubmitted: (id: number) => request<ApplicationDetail>("POST", `/api/applications/${id}/unsubmit`, {}),
  tracker: () => request<TrackedApplication[]>("GET", "/api/tracker"),
  setStatus: (id: number, status: TrackStatus) => request<ApplicationDetail>("POST", `/api/applications/${id}/status`, { status }),
  followUp: (id: number, action: "done" | "later") => request<ApplicationDetail>("POST", `/api/applications/${id}/follow-up`, { action }),
  summary: () => request<DaySummary>("GET", "/api/summary"),
  draftFollowUp: (id: number) => request<{ text: string; warning: string | null }>("POST", `/api/applications/${id}/follow-up/draft`, {}),
  monthSpend: () => request<{ month: string; calls: number; costUsd: number; unpricedCalls: number }>("GET", "/api/usage/month"),
};

export type DaySummary = {
  date: string;
  today: { submitted: number; target: number };
  week: { submitted: number; target: number };
  review: number;
  blocked: number;
  snoozed: number;
  approved: number;
  followUps: { due: number; next: { id: number; companyName: string; jobTitle: string } | null };
  pipeline: { submitted: number; screen: number; interview: number; offer: number };
};

export type TrackStatus = "screen" | "interview" | "offer" | "rejected" | "ghosted" | "withdrawn";

export const usd = (n: number) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);

export const E_VERIFY_SEARCH_URL = "https://www.e-verify.gov/e-verify-employer-search";
