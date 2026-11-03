import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { applications, jobs, outreach } from "../src/db/schema";
import {
  acceptanceName,
  inviteBudget,
  lintOutreach,
  matchAcceptance,
  nextStatus,
  normalizeProfileUrl,
  roleKeywords,
  searchLinks,
} from "../src/domain/outreach";
import { recordAcceptances, type NetworkDeps } from "../src/services/network";
import type { OutreachDrafter, OutreachInput } from "../src/llm/outreach";
import type { DB } from "../src/db/client";
import { FDE_JD, FIXTURE_FACTS, FIXTURE_RESUME, OFFLINE_PIPELINE, makeTestDb, prepDeps } from "./helpers";

// ---- Pure rules ----------------------------------------------------------------

describe("outreach rules", () => {
  it("normalizes profile links and rejects anything else", () => {
    expect(normalizeProfileUrl("linkedin.com/in/Jane-Doe-123/?trk=public")).toBe("https://www.linkedin.com/in/jane-doe-123");
    expect(normalizeProfileUrl("https://www.linkedin.com/in/jane-doe-123/details/")).toBe("https://www.linkedin.com/in/jane-doe-123");
    expect(normalizeProfileUrl("https://www.linkedin.com/company/acme")).toBeNull();
    expect(normalizeProfileUrl("https://evil.com/in/jane")).toBeNull();
  });

  it("keeps the referral ask behind the connection", () => {
    expect(nextStatus("planned", "invite", "team")).toBe("invited");
    expect(() => nextStatus("planned", "message", "team")).toThrow(/Connect first/);
    expect(nextStatus("planned", "message", "first_degree")).toBe("asked"); // already connected
    expect(() => nextStatus("planned", "invite", "first_degree")).toThrow(/already connected/);
    expect(nextStatus("invited", "accepted", "team")).toBe("connected");
    expect(nextStatus("connected", "message", "team")).toBe("asked");
    expect(nextStatus("asked", "follow_up", "team")).toBe("followed_up");
  });

  it("allows one follow-up, never two", () => {
    expect(() => nextStatus("followed_up", "follow_up", "team")).toThrow();
    expect(nextStatus("followed_up", "no_reply", "team")).toBe("no_reply");
  });

  it("never moves a closed conversation", () => {
    for (const a of ["invite", "accepted", "message", "follow_up", "replied"] as const) {
      expect(() => nextStatus("referred", a, "team")).toThrow();
      expect(() => nextStatus("declined", a, "team")).toThrow();
    }
  });

  it("counts invites against the daily and weekly caps", () => {
    const now = new Date("2026-11-02T18:00:00Z");
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const today = Array.from({ length: 20 }, () => new Date("2026-11-02T15:00:00Z"));
    expect(inviteBudget(today, now, "2026-11-02", day).left).toBe(0);
    const week = Array.from({ length: 80 }, (_, i) => new Date(now.getTime() - (1 + (i % 5)) * 86_400_000));
    const b = inviteBudget(week, now, "2026-11-02", day);
    expect(b.today).toBe(0);
    expect(b.week).toBe(80);
    expect(b.left).toBe(0);
    expect(inviteBudget([], now, "2026-11-02", day).left).toBe(20);
  });

  it("flags template phrases, long notes and a referral ask in the note", () => {
    const issues = lintOutreach(
      {
        note: "Hi Jane, I hope this finds you well! Would you refer me? " + "x".repeat(300),
        ask: "Hey, saw you're on the FDE team. I applied to the role, would you be open to referring me?",
        followUp: "No worries if now's not a good time.",
      },
      { needsNote: true }
    );
    const notes = issues.filter((i) => i.field === "note").map((i) => i.message).join(" | ");
    expect(notes).toMatch(/hope this finds you well/);
    expect(notes).toMatch(/LinkedIn notes stop at 300/);
    expect(notes).toMatch(/referral ask out of the connection note/);
    expect(issues.filter((i) => i.field === "ask" && i.severity === "fail")).toEqual([]);
  });

  it("doesn't ask for a note from a 1st-degree connection", () => {
    expect(lintOutreach({ note: "", ask: "Hey Sam, quick one.", followUp: "No rush." }, { needsNote: false })).toEqual([]);
  });

  it("builds people searches for the company and role", () => {
    expect(roleKeywords("Senior Forward Deployed Engineer, Public Sector")).toBe("forward deployed engineer");
    expect(roleKeywords("Forward-Deployed Engineer")).toBe("forward-deployed engineer");
    const links = searchLinks("Acme Robotics", "Software Engineer II");
    expect(links).toHaveLength(4);
    expect(decodeURIComponent(links[0]!.url)).toContain('network=["F"]');
    expect(decodeURIComponent(links[1]!.url)).toContain('"Acme Robotics" DePauw');
    expect(links.every((l) => l.url.startsWith("https://www.linkedin.com/search/results/people/"))).toBe(true);
  });

  it("reads LinkedIn acceptance emails by subject, and only from LinkedIn", () => {
    expect(acceptanceName({ fromAddress: "invitations@linkedin.com", subject: "Jane Doe accepted your invitation" })).toBe("Jane Doe");
    expect(acceptanceName({ fromAddress: "invitations@linkedin.com", subject: "Jane Doe has accepted your invitation. Let's start a conversation." })).toBe("Jane Doe");
    expect(acceptanceName({ fromAddress: "messages-noreply@linkedin.com", subject: "You and Sam are now connected" })).toBe("Sam");
    expect(acceptanceName({ fromAddress: "spoof@linkedin.com.evil.io", subject: "Jane Doe accepted your invitation" })).toBeNull();
    expect(acceptanceName({ fromAddress: "jobs-noreply@linkedin.com", subject: "New jobs for you" })).toBeNull();
  });

  it("matches an acceptance to exactly one invite, or none", () => {
    const invited = [{ name: "Jane Doe" }, { name: "Sam Lee" }, { name: "Sam Park" }];
    expect(matchAcceptance("jane doe", invited)).toEqual({ name: "Jane Doe" });
    expect(matchAcceptance("Jane", invited)).toEqual({ name: "Jane Doe" }); // only one Jane
    expect(matchAcceptance("Sam", invited)).toBeNull(); // two Sams: don't guess
    expect(matchAcceptance("Priya Shah", invited)).toBeNull();
  });
});

// ---- Through the API ------------------------------------------------------------

let db: DB;
let app: ReturnType<typeof buildApp>;
let calls: OutreachInput[];
let nextDraft: { note: string; ask: string; followUp: string }[];

const good = {
  note: "Hi Jane, fellow DePauw grad here. I'm an engineer working on LLM features and I'm curious how your team scopes customer deployments.",
  ask: "Thanks for connecting! I'm applying for the Forward Deployed Engineer role (https://jobs.example.com/1). I've been shipping a Claude pipeline at my current job, which is close to what the posting describes. Would you be open to referring me, or is there someone better to ask? Happy to send a short blurb.",
  followUp: "Hey Jane, bumping this in case it got buried. No worries if now's not a good time.",
};

const drafter: OutreachDrafter = async (input) => {
  calls.push(input);
  const d = nextDraft.shift() ?? good;
  return { ...d, usage: { inputTokens: 500, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5-5" };
};

function setup(deps: NetworkDeps = { getDrafter: () => ({ draft: drafter }), facts: () => FIXTURE_FACTS }) {
  db = makeTestDb();
  calls = [];
  nextDraft = [];
  app = buildApp(db, { pipeline: OFFLINE_PIPELINE, prep: prepDeps(), network: deps });
}
beforeEach(() => setup());

const req = async (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as object });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};

async function tierAApp() {
  await req("PUT", "/api/resumes/bases/fde", { text: FIXTURE_RESUME });
  await req("PUT", "/api/resumes/bases/swe", { text: FIXTURE_RESUME });
  const { body } = await req("POST", "/api/jobs", { companyName: "Acme Robotics", title: "Forward Deployed Engineer", location: "Chicago, IL", description: FDE_JD });
  db.update(jobs).set({ tier: "A", fitScore: 9 }).where(eq(jobs.id, body.job.id)).run();
  const a = (await req("POST", "/api/applications", { jobId: body.job.id })).body;
  db.update(applications).set({ status: "submitted", tier: "A", submittedAt: new Date() }).where(eq(applications.id, a.id)).run();
  return a.id as number;
}

const jane = (applicationId: number | null, over: object = {}) => ({
  applicationId,
  linkedinUrl: "https://www.linkedin.com/in/jane-doe/",
  name: "Jane Doe",
  headline: "Forward Deployed Engineer at Acme Robotics",
  relationship: "alum",
  about: "DePauw 2019. Posted about how her team scopes pilots.",
  ...over,
});

describe("the Network tab", () => {
  it("lists live roles with how many people each needs", async () => {
    const id = await tierAApp();
    const { body } = await req("GET", "/api/network");
    const role = body.roles.find((r: { applicationId: number }) => r.applicationId === id);
    expect(role).toMatchObject({ companyName: "Acme Robotics", wanted: 3, found: 0 });
    expect(role.searches).toHaveLength(4);
    expect(body.invites).toMatchObject({ today: 0, dailyCap: 20, weeklyCap: 80 });
  });

  it("adds a person and drafts their messages from the role and what you know", async () => {
    const id = await tierAApp();
    const { status, body } = await req("POST", "/api/network/contacts", jane(id));
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "planned", note: good.note, ask: good.ask, next: { action: "invite", text: "note" } });
    expect(body.contact.linkedinUrl).toBe("https://www.linkedin.com/in/jane-doe");
    expect(calls[0]!.application?.companyName).toBe("Acme Robotics");
    expect(calls[0]!.contact.about).toContain("DePauw");
    expect(calls[0]!.noteLimit).toBe(300);
  });

  it("redrafts once when the first draft breaks a rule, then shows what's left", async () => {
    const id = await tierAApp();
    nextDraft = [{ ...good, note: "I came across your profile and would love a referral!" }, good];
    const { body } = await req("POST", "/api/network/contacts", jane(id));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.fix?.join(" ")).toMatch(/came across your profile/);
    expect(body.note).toBe(good.note);
    expect(body.issues.filter((i: { severity: string }) => i.severity === "fail")).toEqual([]);
  });

  it("Truth-Checks the messages against your inventory", async () => {
    const id = await tierAApp();
    const bad = { ...good, ask: "I cut latency by 73% at my last job. Would you be open to referring me?" };
    nextDraft = [bad, bad];
    const { body } = await req("POST", "/api/network/contacts", jane(id));
    expect(body.issues.some((i: { field: string; message: string }) => i.field === "ask" && /73%/.test(i.message))).toBe(true);
  });

  it("keeps the person when drafting isn't available", async () => {
    setup({ getDrafter: () => ({ unavailable: "no ANTHROPIC_API_KEY in .env" }) });
    const id = await tierAApp();
    const { body } = await req("POST", "/api/network/contacts", jane(id));
    expect(body.status).toBe("planned");
    expect(body.issues[0].message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("refuses a link that isn't a profile", async () => {
    const id = await tierAApp();
    const { status, body } = await req("POST", "/api/network/contacts", jane(id, { linkedinUrl: "https://www.linkedin.com/company/acme" }));
    expect(status).toBe(409);
    expect(body.error).toMatch(/profile link/);
  });

  it("walks a conversation from invite to referral, with the follow-up due a week after the ask", async () => {
    const id = await tierAApp();
    const o = (await req("POST", "/api/network/contacts", jane(id))).body;
    expect((await req("POST", `/api/network/outreach/${o.id}/message`)).status).toBe(409); // not connected yet
    expect((await req("POST", `/api/network/outreach/${o.id}/invite`)).body.status).toBe("invited");
    expect((await req("POST", `/api/network/outreach/${o.id}/accepted`)).body.next).toMatchObject({ action: "message", text: "ask" });
    const asked = (await req("POST", `/api/network/outreach/${o.id}/message`)).body;
    expect(asked.status).toBe("asked");
    expect(asked.followUpDue).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(asked.next).toBeNull(); // waiting on them
    expect((await req("POST", `/api/network/outreach/${o.id}/referred`)).body.status).toBe("referred");
  });

  it("shows the follow-up on the day it's due", async () => {
    const id = await tierAApp();
    const o = (await req("POST", "/api/network/contacts", jane(id, { relationship: "first_degree" }))).body;
    expect(o.note).toBe(""); // already connected: no note
    await req("POST", `/api/network/outreach/${o.id}/message`);
    db.update(outreach).set({ followUpDue: "2020-01-01" }).where(eq(outreach.id, o.id)).run();
    const { body } = await req("GET", "/api/network");
    expect(body.due.map((d: { id: number; next: { action: string } }) => [d.id, d.next.action])).toEqual([[o.id, "follow_up"]]);
  });

  it("won't talk to the same person about two roles at once, or again within 30 days", async () => {
    const id = await tierAApp();
    const o = (await req("POST", "/api/network/contacts", jane(id))).body;
    const again = await req("POST", "/api/network/contacts", jane(null));
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already talking to Jane Doe about Forward Deployed Engineer at Acme Robotics/);
    await req("POST", `/api/network/outreach/${o.id}/invite`);
    await req("POST", `/api/network/outreach/${o.id}/declined`);
    expect((await req("POST", "/api/network/contacts", jane(null))).body.error).toMatch(/less than 30 days ago/);
  });

  it("stops offering invites at the daily cap", async () => {
    const id = await tierAApp();
    const o = (await req("POST", "/api/network/contacts", jane(id))).body;
    const other = (await req("POST", "/api/network/contacts", jane(id, { linkedinUrl: "linkedin.com/in/sam-lee", name: "Sam Lee" }))).body;
    db.update(outreach).set({ invitedAt: new Date() }).where(eq(outreach.id, other.id)).run();
    for (let i = 0; i < 19; i++) {
      const c = (await req("POST", "/api/network/contacts", jane(null, { linkedinUrl: `linkedin.com/in/p-${i}`, name: `Person ${i}` }))).body;
      db.update(outreach).set({ status: "invited", invitedAt: new Date() }).where(eq(outreach.id, c.id)).run();
    }
    const r = await req("POST", `/api/network/outreach/${o.id}/invite`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/20 invites today/);
  });

  it("re-checks your edits", async () => {
    const id = await tierAApp();
    const o = (await req("POST", "/api/network/contacts", jane(id))).body;
    const { body } = await req("PATCH", `/api/network/outreach/${o.id}`, { note: "Hope you're doing well, would you refer me?" });
    expect(body.note).toMatch(/^Hope/);
    expect(body.issues.filter((i: { field: string }) => i.field === "note").length).toBeGreaterThanOrEqual(2);
  });

  it("moves an invite to connected when LinkedIn's acceptance email arrives", async () => {
    const id = await tierAApp();
    const o = (await req("POST", "/api/network/contacts", jane(id))).body;
    expect(recordAcceptances(db, ["Jane Doe"])).toBe(0); // not invited yet
    await req("POST", `/api/network/outreach/${o.id}/invite`);
    expect(recordAcceptances(db, ["Jane Doe", "Someone Else"])).toBe(1);
    const { body } = await req("GET", "/api/network");
    expect(body.outreach[0]).toMatchObject({ status: "connected", connectedVia: "inbox" });
  });
});
