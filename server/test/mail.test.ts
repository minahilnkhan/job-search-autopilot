import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { applications, emailMessages, jobs } from "../src/db/schema";
import { classifyByRules, matchApplication, suggestStatus, worthOpening, type Envelope, type MailApp, type MailMessage } from "../src/domain/mailMatch";
import { mailCheckDue, type MailDeps } from "../src/services/mail";
import type { MailSource } from "../src/mail/imap";
import type { EmailClassifier } from "../src/llm/classifyEmail";
import type { DB } from "../src/db/client";
import { FDE_JD, FIXTURE_RESUME, OFFLINE_PIPELINE, makeTestDb, prepDeps } from "./helpers";

const msg = (over: Partial<MailMessage>): MailMessage => ({
  messageId: `<${Math.random()}@mail>`,
  fromAddress: "no-reply@us.greenhouse-mail.io",
  fromName: "Acme Robotics",
  subject: "",
  date: new Date("2026-11-02T20:00:00Z"),
  text: "",
  ...over,
});

// ---- What an email says ---------------------------------------------------------

describe("reading what an email says", () => {
  const kind = (subject: string, text = "") => classifyByRules({ subject, text })?.kind ?? null;

  it("recognises a receipt, even one that mentions next steps", () => {
    expect(kind("Thank you for applying to Acme Robotics", "We've received your application. If there's a fit we'll reach out about next steps in our hiring process.")).toBe("received");
  });

  it("reads a polite rejection as a rejection, not a receipt", () => {
    expect(kind("Your application to Acme", "Thank you for applying. Unfortunately, we will not be moving forward with your application at this time.")).toBe("rejection");
    expect(kind("Update", "After careful consideration we have decided to move forward with other candidates whose experience more closely matches.")).toBe("rejection");
    expect(kind("Update", "Thank you for taking the time to interview with us. We regret to inform you that we won't be proceeding.")).toBe("rejection");
  });

  it("tells a screen from an interview from an assessment", () => {
    expect(kind("Next steps", "Would you be open to a 30 minute phone screen? Please share your availability.")).toBe("screen");
    expect(kind("Acme: virtual onsite", "We'd like to invite you to the final round.")).toBe("interview");
    expect(kind("Acme coding challenge", "Please complete the HackerRank assessment within 5 days.")).toBe("assessment");
    expect(kind("Offer", "We're delighted to extend you an offer for the role.")).toBe("offer");
  });

  it("leaves an unclear email unlabelled for the model (or for you)", () => {
    expect(kind("Acme Robotics newsletter", "Here's what our team shipped this month.")).toBeNull();
  });
});

// ---- Which application it's about -------------------------------------------------

const APP = (over: Partial<MailApp>): MailApp => ({ id: 1, status: "submitted", companyName: "Acme Robotics", companyWebsite: "https://www.acmerobotics.com", jobTitle: "Forward Deployed Engineer", submittedAt: new Date(), ...over });

describe("matching an email to an application", () => {
  const env = (over: Partial<Envelope>): Envelope => ({ messageId: "x", fromAddress: "someone@gmail.com", fromName: null, subject: "", date: new Date(), ...over });

  it("only opens mail from an ATS, from the company, or naming it", () => {
    const apps = [APP({}), APP({ id: 2, companyName: "Ramp", companyWebsite: "https://ramp.com" })];
    expect(worthOpening(env({ fromAddress: "no-reply@us.greenhouse-mail.io" }), apps)).toBe(true);
    expect(worthOpening(env({ fromAddress: "jane@acmerobotics.com" }), apps)).toBe(true);
    expect(worthOpening(env({ subject: "Your Acme Robotics application" }), apps)).toBe(true);
    expect(worthOpening(env({ fromAddress: "deals@shop.com", subject: "A rampant sale" }), apps)).toBe(false); // "Ramp" is a whole word
  });

  it("picks the application by job title when you applied to the company twice", () => {
    const apps = [APP({ id: 1, jobTitle: "Forward Deployed Engineer" }), APP({ id: 2, jobTitle: "Solutions Engineer" })];
    expect(matchApplication(msg({ subject: "Your Solutions Engineer application at Acme Robotics" }), apps)).toEqual({ applicationId: 2, candidateIds: [] });
    expect(matchApplication(msg({ subject: "Update from Acme Robotics" }), apps)).toEqual({ applicationId: null, candidateIds: [1, 2] });
  });

  it("ignores mail that names no company you applied to", () => {
    expect(matchApplication(msg({ fromName: "Other Co", subject: "Thanks for applying to Other Co" }), [APP({})])).toEqual({ applicationId: null, candidateIds: [] });
  });
});

describe("the status an email suggests", () => {
  it("moves forward, never back, and never reopens an ended application", () => {
    expect(suggestStatus("screen", "submitted")).toBe("screen");
    expect(suggestStatus("screen", "interview")).toBeNull();
    expect(suggestStatus("assessment", "submitted")).toBe("screen");
    expect(suggestStatus("rejection", "interview")).toBe("rejected");
    expect(suggestStatus("interview", "rejected")).toBeNull();
    expect(suggestStatus("received", "approved")).toBe("submitted"); // the receipt proves you sent it
    expect(suggestStatus("received", "submitted")).toBeNull();
  });
});

describe("once a day at 8pm", () => {
  const due = (timeNow: string, lastCheck: { date: string; time: string } | null) => mailCheckDue({ today: "2026-11-02", timeNow, at: "20:00", lastCheck });
  it("is due after 8pm if today's hasn't run, and not again until tomorrow's", () => {
    expect(due("19:00", { date: "2026-11-01", time: "20:01" })).toBe(false);
    expect(due("20:01", { date: "2026-11-01", time: "20:01" })).toBe(true);
    expect(due("21:00", { date: "2026-11-02", time: "20:00" })).toBe(false);
    expect(due("09:00", { date: "2026-11-01", time: "08:00" })).toBe(true); // asleep at 8pm last night: check on start
    expect(due("09:00", null)).toBe(true);
  });
});

// ---- The whole check, against a fake inbox ----------------------------------------

let db: DB;
let app: ReturnType<typeof buildApp>;
let inbox: MailMessage[];
let opened: string[];
let classifierCalls: number;

const fakeSource: MailSource = async (_since, wanted) => {
  const picked = inbox.filter((m) => wanted(m));
  opened.push(...picked.map((m) => m.subject));
  return { scanned: inbox.length, messages: picked };
};
const fakeClassifier: EmailClassifier = async () => {
  classifierCalls++;
  return { kind: "screen", reason: "asks for a call", usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-haiku-5-5" };
};

function setup(mail: MailDeps = { getSource: () => ({ source: fakeSource, address: "me.jobs@gmail.com" }) }) {
  db = makeTestDb();
  inbox = [];
  opened = [];
  classifierCalls = 0;
  app = buildApp(db, { pipeline: OFFLINE_PIPELINE, prep: prepDeps(), mail });
}
beforeEach(() => setup());

const req = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as object });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};

async function sentApp(status: "approved" | "submitted" = "submitted", title = "Forward Deployed Engineer") {
  await req("PUT", "/api/resumes/bases/fde", { text: FIXTURE_RESUME });
  await req("PUT", "/api/resumes/bases/swe", { text: FIXTURE_RESUME });
  const { body } = await req("POST", "/api/jobs", { companyName: "Acme Robotics", title, location: "Chicago, IL", description: FDE_JD });
  db.update(jobs).set({ tier: "A", fitScore: 9 }).where(eq(jobs.id, body.job.id)).run();
  const a = (await req("POST", "/api/applications", { jobId: body.job.id })).body;
  db.update(applications).set({ status, tier: "A", submittedAt: status === "submitted" ? new Date() : null }).where(eq(applications.id, a.id)).run();
  return a.id as number;
}

const statusOf = (id: number) => db.select({ s: applications.status }).from(applications).where(eq(applications.id, id)).get()!.s;

describe("the inbox check", () => {
  it("records a receipt on its own, suggests a rejection, and never opens unrelated mail", async () => {
    const id = await sentApp();
    inbox = [
      msg({ subject: "Thank you for applying to Acme Robotics", text: "We have received your application for Forward Deployed Engineer." }),
      msg({ subject: "Your application to Acme Robotics", text: "Unfortunately, we will not be moving forward with your application." }),
      msg({ fromAddress: "deals@shop.com", fromName: "Shop", subject: "50% off", text: "Sale" }),
    ];
    const r = await req("POST", "/api/inbox/check");
    expect(r.body).toMatchObject({ scanned: 3, matched: 2, suggestions: 1, recorded: 1 });
    expect(opened).not.toContain("50% off"); // its body was never downloaded

    const state = (await req("GET", "/api/inbox")).body;
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({ kind: "rejection", suggestedStatus: "rejected", application: { id } });
    expect(state.recent[0]).toMatchObject({ kind: "received", state: "auto" });
    expect(statusOf(id)).toBe("submitted"); // nothing changes until you accept

    await req("POST", `/api/inbox/${state.pending[0].id}/accept`, {});
    expect(statusOf(id)).toBe("rejected");
  });

  it("doesn't store or suggest the same email twice", async () => {
    await sentApp();
    inbox = [msg({ messageId: "<same@x>", subject: "Acme Robotics: phone screen", text: "Can we schedule a call this week?" })];
    await req("POST", "/api/inbox/check");
    await req("POST", "/api/inbox/check");
    expect(db.select().from(emailMessages).all()).toHaveLength(1);
  });

  it("asks the model only about emails the rules can't read", async () => {
    setup({ getSource: () => ({ source: fakeSource, address: "me.jobs@gmail.com" }), getClassifier: () => ({ classify: fakeClassifier }) });
    await sentApp();
    inbox = [
      msg({ subject: "Acme Robotics: phone screen", text: "Would you be open to a recruiter call?" }),
      msg({ subject: "Acme Robotics and you", text: "Jane from our team wanted to reach out about your background." }),
    ];
    const r = (await req("POST", "/api/inbox/check")).body;
    expect(classifierCalls).toBe(1);
    expect(r.costUsd).toBeGreaterThan(0);
    const pending = (await req("GET", "/api/inbox")).body.pending;
    expect(pending.map((p: { kindSource: string }) => p.kindSource).sort()).toEqual(["model", "rule"]);
  });

  it("without the model, an unclear email waits for you with nothing to accept", async () => {
    await sentApp();
    inbox = [msg({ subject: "Acme Robotics and you", text: "Jane wanted to reach out." })];
    await req("POST", "/api/inbox/check");
    const [item] = (await req("GET", "/api/inbox")).body.pending;
    expect(item).toMatchObject({ kind: "other", suggestedStatus: null });
    expect((await req("POST", `/api/inbox/${item.id}/accept`, {})).status).toBe(409);
    expect((await req("POST", `/api/inbox/${item.id}/dismiss`)).status).toBe(200);
    expect((await req("GET", "/api/inbox")).body.pending).toHaveLength(0);
  });

  it("a receipt for something you sent but didn't mark sent suggests marking it, with a follow-up date", async () => {
    const id = await sentApp("approved");
    inbox = [msg({ subject: "Thanks for applying to Acme Robotics" })];
    await req("POST", "/api/inbox/check");
    const [item] = (await req("GET", "/api/inbox")).body.pending;
    expect(item.suggestedStatus).toBe("submitted");
    await req("POST", `/api/inbox/${item.id}/accept`, {});
    const row = db.select().from(applications).where(eq(applications.id, id)).get()!;
    expect(row.status).toBe("submitted");
    expect(row.followUpDue).not.toBeNull();
  });

  it("asks which application when it can't tell, and only accepts one of those", async () => {
    const a = await sentApp("submitted", "Forward Deployed Engineer");
    const b = await sentApp("submitted", "Solutions Engineer");
    inbox = [msg({ subject: "Acme Robotics: next steps", text: "We'd love to chat with you this week." })];
    await req("POST", "/api/inbox/check");
    const [item] = (await req("GET", "/api/inbox")).body.pending;
    expect(item.application).toBeNull();
    expect(item.candidates.map((c: { id: number }) => c.id).sort()).toEqual([a, b].sort());
    expect((await req("POST", `/api/inbox/${item.id}/accept`, {})).status).toBe(409);
    expect((await req("POST", `/api/inbox/${item.id}/accept`, { applicationId: 9999 })).status).toBe(409);
    await req("POST", `/api/inbox/${item.id}/accept`, { applicationId: b });
    expect(statusOf(b)).toBe("screen");
    expect(statusOf(a)).toBe("submitted");
  });

  it("says plainly when it isn't set up, and a failed check is recorded with its reason", async () => {
    setup({ getSource: () => ({ unavailable: "add MAIL_ADDRESS and MAIL_APP_PASSWORD to .env, then restart" }) });
    const r = await req("POST", "/api/inbox/check");
    expect(r.status).toBe(409);
    expect((await req("GET", "/api/inbox")).body).toMatchObject({ configured: false, unavailable: expect.stringContaining("MAIL_APP_PASSWORD") });

    setup({ getSource: () => ({ source: async () => Promise.reject(new Error("Gmail refused the sign-in.")), address: "me@gmail.com" }) });
    await sentApp();
    expect((await req("POST", "/api/inbox/check")).status).toBe(409);
    expect((await req("GET", "/api/inbox")).body.lastCheck).toMatchObject({ status: "failed", error: "Gmail refused the sign-in." });
  });

  it("marks a LinkedIn invite accepted from the email's subject, without opening it", async () => {
    const id = await sentApp();
    const o = (await req("POST", "/api/network/contacts", { applicationId: id, linkedinUrl: "linkedin.com/in/jane-doe", name: "Jane Doe", relationship: "team" })).body;
    await req("POST", `/api/network/outreach/${o.id}/invite`);
    inbox = [msg({ fromAddress: "invitations@linkedin.com", fromName: "LinkedIn", subject: "Jane Doe accepted your invitation", text: "body" })];
    const r = await req("POST", "/api/inbox/check");
    expect(r.body.connected).toBe(1);
    expect(opened).toEqual([]); // the body was never downloaded
    expect((await req("GET", "/api/network")).body.outreach[0].status).toBe("connected");
  });
});
