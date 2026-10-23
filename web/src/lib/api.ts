import type {
  Company,
  CreateJobRequest,
  CreateJobResponse,
  ExtractRequest,
  ExtractedFields,
  FilterReason,
  Job,
  Settings,
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
  listJobs: () => request<Job[]>("GET", "/api/jobs"),
  updateJob: (id: number, body: Partial<Pick<Job, "title" | "location" | "url" | "status">> & { fields?: ExtractedFields }) =>
    request<Job>("PATCH", `/api/jobs/${id}`, body),
  listCompanies: () => request<Company[]>("GET", "/api/companies"),
  createCompany: (body: Partial<Company> & { name: string }) => request<Company>("POST", "/api/companies", body),
  updateCompany: (id: number, body: Partial<Company>) =>
    request<{ company: Company; refilteredJobs: number }>("PATCH", `/api/companies/${id}`, body),
  getSettings: () => request<Settings>("GET", "/api/settings"),
  saveSettings: (body: Settings) => request<Settings>("PUT", "/api/settings", body),
};

export const E_VERIFY_SEARCH_URL = "https://www.e-verify.gov/e-verify-employer-search";
