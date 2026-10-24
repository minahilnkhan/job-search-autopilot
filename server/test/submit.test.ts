import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { applyTarget, fromUrl } from "../src/submit/applyUrl";
import { looksSubmitted } from "../src/submit/confirm";
import { planFill, questionSimilarity, type FormControl, type PrefillValues } from "../src/submit/plan";
import { prefillPage } from "../src/submit/prefill";
import type { Answer } from "../../shared/types";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { jobs, settings } from "../src/db/schema";
import { resetSubmitSessions } from "../src/services/submissions";
import { FDE_JD, FIXTURE_RESUME, OFFLINE_PIPELINE, makeTestDb, prepDeps } from "./helpers";

const PROFILE = {
  firstName: "Minahil",
  lastName: "Khan",
  email: "me@example.com",
  phone: "312-555-0100",
  location: "Chicago, IL",
  linkedin: "linkedin.com/in/me",
  github: "github.com/me",
  website: "",
  currentCompany: "Yabla",
};
const ANSWERS: Answer[] = [
  { question: "How did you hear about this role?", answer: "Their careers page.", source: "standard" },
  { question: "Are you willing to relocate?", answer: "Yes, anywhere in the US.", source: "standard" },
  { question: "When can you start?", answer: "Two weeks after an offer.", source: "standard" },
  { question: "Why do you want to work at Acme?", answer: "I want to build customer-facing LLM features.", source: "generated" },
  { question: "Are you legally authorized to work in the United States?", answer: "Yes", source: "fixed" },
  { question: "Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)?", answer: "Yes", source: "fixed" },
];
const VALUES: PrefillValues = { profile: PROFILE, answers: ANSWERS, recruiterNote: "I ship production Claude features.", resumeFileName: "Minahil_Khan_Resume.pdf" };

const control = (over: Partial<FormControl>): FormControl => ({ id: "x", kind: "text", label: "", hints: "", required: false, value: "", options: [], ...over });

describe("apply URLs", () => {
  it("builds the ATS's own form URL from the board token and job id", () => {
    expect(applyTarget({ source: "greenhouse", externalId: "4012", url: "https://acme.com/careers?gh_jid=4012" }, "acme")).toEqual({ ats: "greenhouse", url: "https://job-boards.greenhouse.io/acme/jobs/4012" });
    expect(applyTarget({ source: "lever", externalId: "ab-12", url: null }, "acme")).toEqual({ ats: "lever", url: "https://jobs.lever.co/acme/ab-12/apply" });
    expect(applyTarget({ source: "ashby", externalId: "uuid", url: null }, "acme")).toEqual({ ats: "ashby", url: "https://jobs.ashbyhq.com/acme/uuid/application" });
  });

  it("works out the ATS from a pasted URL", () => {
    expect(fromUrl("https://boards.greenhouse.io/acme/jobs/123?t=x")).toEqual({ ats: "greenhouse", url: "https://job-boards.greenhouse.io/acme/jobs/123" });
    expect(fromUrl("https://jobs.lever.co/acme/ab-12")!.url).toBe("https://jobs.lever.co/acme/ab-12/apply");
    expect(fromUrl("https://jobs.ashbyhq.com/acme/uuid")!.url).toBe("https://jobs.ashbyhq.com/acme/uuid/application");
    expect(fromUrl("https://acme.com/jobs/1")).toEqual({ ats: "other", url: "https://acme.com/jobs/1" });
    expect(fromUrl("javascript:alert(1)")).toBeNull();
    expect(applyTarget({ source: "manual", externalId: null, url: null }, null)).toBeNull();
  });
});

describe("confirmation page", () => {
  it("recognizes thank-you pages and URLs", () => {
    expect(looksSubmitted("https://job-boards.greenhouse.io/acme/jobs/1/confirmation", "")).toBe(true);
    expect(looksSubmitted("https://jobs.lever.co/acme/1/thanks", "")).toBe(true);
    expect(looksSubmitted("https://x.com/apply", "Thank you for applying to Acme!")).toBe(true);
    expect(looksSubmitted("https://x.com/apply", "Your application has been submitted.")).toBe(true);
  });
  it("doesn't fire on the form or a job description's sign-off", () => {
    expect(looksSubmitted("https://job-boards.greenhouse.io/acme/jobs/1", "Apply for this job. First name. Thank you for your interest in Acme.")).toBe(false);
  });
});

describe("planning the fill", () => {
  it("matches similar questions but not unrelated ones", () => {
    expect(questionSimilarity("How did you hear about us?", "How did you hear about this role?")).toBeGreaterThanOrEqual(0.6);
    expect(questionSimilarity("When is the earliest you could start?", "When can you start?")).toBeGreaterThanOrEqual(0.6);
    expect(questionSimilarity("What is your desired compensation?", "When can you start?")).toBeLessThan(0.6);
  });

  it("fills contact fields by label or by name, and the fixed work-auth answers", () => {
    const plan = planFill(
      [
        control({ id: "1", label: "First Name*" }),
        control({ id: "2", label: "", hints: "name type text" }), // Lever's full-name input
        control({ id: "3", label: "Email", hints: "type email" }),
        control({ id: "4", kind: "combobox", label: "Will you now or in the future require sponsorship?" }),
        control({ id: "5", kind: "select", label: "Are you legally authorized to work in the US?", options: [{ text: "Yes" }, { text: "No" }] }),
      ],
      VALUES
    );
    expect(plan.actions).toEqual([
      { op: "fill", id: "1", label: "First Name", value: "Minahil" },
      { op: "fill", id: "2", label: "(unlabeled field)", value: "Minahil Khan" },
      { op: "fill", id: "3", label: "Email", value: "me@example.com" },
      { op: "combobox", id: "4", label: "Will you now or in the future require sponsorship?", value: "Yes" },
      { op: "select", id: "5", label: "Are you legally authorized to work in the US?", value: "Yes" },
    ]);
  });

  it("leaves demographic questions, unknown questions and empty profile fields for you, and never overwrites", () => {
    const plan = planFill(
      [
        control({ id: "1", kind: "select", label: "Gender", options: [{ text: "Female" }] }),
        control({ id: "2", label: "What is your desired compensation?*", required: true }),
        control({ id: "3", label: "Website" }),
        control({ id: "4", label: "Email", value: "parsed@from.resume" }),
      ],
      VALUES
    );
    expect(plan.actions).toEqual([]);
    expect(plan.leftForYou).toEqual([
      { label: "Gender", reason: "Voluntary self-identification: your call", required: false },
      { label: "What is your desired compensation?", reason: "No prepared answer", required: true },
      { label: "Website", reason: "Not in Settings → Profile yet", required: false },
    ]);
  });
});

// ---- Real browser against copies of each ATS's form layout --------------------

const chromiumPath = process.env.CHROMIUM_PATH ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const FORMS = path.join(__dirname, "fixtures", "forms");

describe.skipIf(!chromiumPath)("prefill on form layouts like Greenhouse, Lever and Ashby", () => {
  let browser: Browser;
  let resume: string;
  beforeAll(async () => {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ executablePath: chromiumPath });
    resume = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prefill-")), "Minahil_Khan_Resume.pdf");
    fs.writeFileSync(resume, "%PDF-1.4 test");
  });
  afterAll(async () => browser?.close());

  const open = async (name: string): Promise<Page> => {
    const page = await browser.newPage();
    await page.goto(`file://${path.join(FORMS, name)}`);
    return page;
  };
  const val = (page: Page, sel: string) => page.locator(sel).inputValue();

  it("Greenhouse: contact fields, resume, react-select work-auth answers, matched questions; EEO and submit untouched", async () => {
    const page = await open("greenhouse.html");
    const r = await prefillPage(page, VALUES, resume);
    expect(await val(page, "#first_name")).toBe("Minahil");
    expect(await val(page, "#last_name")).toBe("Khan");
    expect(await val(page, "#email")).toBe("me@example.com");
    expect(await val(page, "#phone")).toBe("312-555-0100");
    expect(await val(page, "#question_1")).toBe("linkedin.com/in/me");
    expect(await val(page, "#question_5")).toBe("Their careers page.");
    expect(await val(page, "#question_6")).toBe("I want to build customer-facing LLM features.");
    expect(await val(page, "#question_7")).toBe("Two weeks after an offer.");
    expect(await page.locator("#question_3").getAttribute("data-chosen")).toBe("Yes");
    expect(await page.locator("#question_4").getAttribute("data-chosen")).toBe("Yes");
    expect(await page.locator("#gender").getAttribute("data-chosen")).toBeNull();
    expect(await page.locator("#resume").evaluate((el) => (el as HTMLInputElement).files?.[0]?.name)).toBe("Minahil_Khan_Resume.pdf");
    expect(await page.locator("#cover_letter").evaluate((el) => (el as HTMLInputElement).files?.length)).toBe(0);
    expect(r.resumeUploaded).toBe(true);
    expect(r.leftForYou.map((l) => l.label)).toEqual(expect.arrayContaining(["Gender", "Veteran Status", "Website"]));
    expect(await page.evaluate(() => ({ s: (window as { __submitted?: boolean }).__submitted ?? false, c: (window as { __clicked?: number }).__clicked ?? 0 }))).toEqual({ s: false, c: 0 });
  });

  it("Lever: full name, URLs, radio and select answers, note in Additional information; checkbox and EEO left", async () => {
    const page = await open("lever.html");
    const r = await prefillPage(page, VALUES, resume);
    expect(await val(page, "input[name=name]")).toBe("Minahil Khan");
    expect(await val(page, "input[name=email]")).toBe("me@example.com");
    expect(await val(page, "input[name=location]")).toBe("Chicago, IL");
    expect(await val(page, "input[name=org]")).toBe("Yabla");
    expect(await val(page, "input[name='urls[LinkedIn]']")).toBe("linkedin.com/in/me");
    expect(await val(page, "input[name='urls[GitHub]']")).toBe("github.com/me");
    expect(await page.locator("input[name='cards[a][field0]'][value=Yes]").isChecked()).toBe(true);
    expect(await val(page, "select[name='cards[a][field1]']")).toBe("Yes");
    expect(await page.locator("input[name='cards[a][field2]'][value=Yes]").isChecked()).toBe(true); // "Yes, anywhere in the US."
    expect(await val(page, "textarea[name=comments]")).toBe("I ship production Claude features.");
    expect(await page.locator("input[name='cards[a][field3]']").isChecked()).toBe(false);
    expect(await val(page, "select[name='eeo[gender]']")).toBe("");
    expect(r.leftForYou).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "Checkbox: read it and tick it yourself", required: true })]));
    expect(await page.evaluate(() => (window as { __submitted?: boolean }).__submitted ?? false)).toBe(false);
  });

  it("Ashby: waits for the form to render, then fills it", async () => {
    const page = await open("ashby.html");
    const r = await prefillPage(page, VALUES, resume);
    expect(await val(page, "#_systemfield_name")).toBe("Minahil Khan");
    expect(await val(page, "#_systemfield_email")).toBe("me@example.com");
    expect(await val(page, "#q-li")).toBe("linkedin.com/in/me");
    expect(await val(page, "#q-phone")).toBe("312-555-0100");
    expect(r.resumeUploaded).toBe(true);
    expect(r.leftForYou).toEqual(expect.arrayContaining([expect.objectContaining({ label: "What excites you about this role?" })]));
  });
});

// ---- The whole flow through the API -------------------------------------------

describe.skipIf(!chromiumPath)("assisted submit through the API", () => {
  let browser: Browser;
  beforeAll(async () => {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ executablePath: chromiumPath });
  });
  afterAll(async () => {
    resetSubmitSessions();
    await browser?.close();
  });

  it("opens the form, prefills, notices the thank-you page, tracks status and the Tier A follow-up", async () => {
    const db = makeTestDb();
    db.update(settings).set({ standardAnswers: [{ question: "When can you start?", answer: "Two weeks after an offer." }], profile: PROFILE }).run();
    let page: Page | null = null;
    const app = buildApp(db, {
      pipeline: OFFLINE_PIPELINE,
      prep: prepDeps(),
      submit: {
        watchEveryMs: 100,
        openPage: async (url) => {
          page = await browser.newPage();
          await page.route("**/*", (route) => {
            const u = route.request().url();
            if (u.endsWith("/thanks")) return route.fulfill({ contentType: "text/html", body: "<h2>Application submitted!</h2>" });
            if (u.endsWith("combobox.js")) return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.join(FORMS, "combobox.js"), "utf8") });
            return route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(FORMS, "lever.html"), "utf8") });
          });
          await page.goto(url);
          return page;
        },
      },
    });
    const req = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, payload: payload as object });
      return { status: res.statusCode, body: res.json() };
    };
    await req("PUT", "/api/resumes/bases/fde", { text: FIXTURE_RESUME });
    await req("PUT", "/api/resumes/bases/swe", { text: FIXTURE_RESUME });
    const job = (await req("POST", "/api/jobs", { companyName: "Acme AI", title: "Forward Deployed Engineer", url: "https://jobs.lever.co/acme/ab-12", location: "Chicago, IL", description: FDE_JD })).body.job;
    db.update(jobs).set({ tier: "A", fitScore: 9 }).where(eq(jobs.id, job.id)).run();
    const a = (await req("POST", "/api/applications", { jobId: job.id })).body;
    expect(a.status).toBe("ready_for_review");

    // Not approved yet: refused.
    expect((await req("POST", `/api/applications/${a.id}/submit/open`)).status).toBe(409);
    await req("POST", `/api/applications/${a.id}/approve`);

    const opened = await req("POST", `/api/applications/${a.id}/submit/open`);
    expect(opened.status).toBe(202);
    let s = opened.body;
    for (let i = 0; i < 100 && !s.report; i++) {
      await new Promise((r) => setTimeout(r, 100));
      s = (await req("GET", `/api/applications/${a.id}/submit`)).body;
    }
    expect(s).toMatchObject({ state: "open", report: { ats: "lever", url: "https://jobs.lever.co/acme/ab-12/apply", resumeUploaded: true, error: null } });
    expect(s.report.filled).toEqual(expect.arrayContaining([{ label: "Full name", value: "Minahil Khan" }]));
    expect(await page!.locator("input[type=file]").evaluate((el) => (el as HTMLInputElement).files?.[0]?.name)).toBe("Test_Person_Resume.pdf");

    // You press Submit; the site shows its thank-you page.
    await page!.goto("https://jobs.lever.co/acme/ab-12/thanks");
    for (let i = 0; i < 50 && s.state !== "submitted"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      s = (await req("GET", `/api/applications/${a.id}/submit`)).body;
    }
    expect(s.state).toBe("submitted");
    const detail = (await req("GET", `/api/applications/${a.id}`)).body;
    expect(detail.status).toBe("submitted");
    expect(detail.followUpDue).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(detail.prefillReport.filled.length).toBeGreaterThan(3);

    const tracker = (await req("GET", "/api/tracker")).body;
    expect(tracker).toEqual([expect.objectContaining({ id: a.id, status: "submitted", tier: "A" })]);

    expect((await req("POST", `/api/applications/${a.id}/follow-up`, { action: "later" })).body.followUpDue).not.toBe(detail.followUpDue);
    expect((await req("POST", `/api/applications/${a.id}/status`, { status: "screen" })).body).toMatchObject({ status: "screen", followUpDue: null });
    expect((await req("POST", `/api/applications/${a.id}/status`, { status: "submitted" })).status).toBe(400);
    expect((await req("POST", `/api/applications/${a.id}/status`, { status: "offer" })).body.status).toBe("offer");
    expect((await req("POST", `/api/applications/${a.id}/status`, { status: "rejected" })).status).toBe(409); // offer → rejected isn't a move
  }, 30000);

  it("marking submitted by hand works, can be undone, and Tier B gets no follow-up date", async () => {
    const db = makeTestDb();
    db.update(settings).set({ standardAnswers: [{ question: "When can you start?", answer: "Two weeks." }] }).run();
    const app = buildApp(db, { pipeline: OFFLINE_PIPELINE, prep: prepDeps() });
    const req = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, payload: payload as object });
      return { status: res.statusCode, body: res.json() };
    };
    await req("PUT", "/api/resumes/bases/fde", { text: FIXTURE_RESUME });
    await req("PUT", "/api/resumes/bases/swe", { text: FIXTURE_RESUME });
    const job = (await req("POST", "/api/jobs", { companyName: "Acme AI", title: "Software Engineer", location: "Chicago, IL", description: FDE_JD })).body.job;
    db.update(jobs).set({ tier: "B", fitScore: 6 }).where(eq(jobs.id, job.id)).run();
    const a = (await req("POST", "/api/applications", { jobId: job.id })).body;
    await req("POST", `/api/applications/${a.id}/approve`);
    expect((await req("POST", `/api/applications/${a.id}/submit/open`)).status).toBe(409); // no browser in this setup
    const done = (await req("POST", `/api/applications/${a.id}/submitted`)).body;
    expect(done).toMatchObject({ status: "submitted", followUpDue: null });
    expect(done.submittedAt).toBeGreaterThan(0);
    expect((await req("POST", `/api/applications/${a.id}/unsubmit`)).body).toMatchObject({ status: "approved", submittedAt: null });
    expect((await req("GET", "/api/tracker")).body).toEqual([]);
  });
});
