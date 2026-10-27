import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app";
import { jobs, settings } from "../src/db/schema";
import { parseInventory } from "../src/domain/inventory";
import { parseResume } from "../src/domain/resumeFormat";
import { findPinnedLine, pendingQuestions } from "../src/domain/tailorPlan";
import { fillMentorPrompt, mentorPromptFor, withConfirmedAdditions } from "../src/llm/context";
import type { DB } from "../src/db/client";
import { FDE_JD, FIXTURE_RESUME, OFFLINE_PIPELINE, fakeTailor, makeTestDb, prepDeps } from "./helpers";

// Mentor prompt v2: per-call modules, and the assumption protocol (ask, draft
// a [CONFIRM] line, apply only once she confirms, remember her answer).

const PROMPT = `# ACT AS
Mentor.

# TERMS
<candidate_inventory> verified facts </candidate_inventory>
<networking_summary/>
Hard rules here.

---
# MODULE: SCORING (load for scoring calls only)
Score 1-10.

# MODULE: RESUME / TAILOR
Tailor rules.

# MODULE: PORTFOLIO
Projects.

# OUTPUT FORMAT: DAILY CHECK-IN
- Yesterday`;

describe("mentor prompt modules", () => {
  it("sends the shared rules plus only the module the call needs", () => {
    const scoring = mentorPromptFor(PROMPT, "scoring");
    expect(scoring).toContain("Hard rules here.");
    expect(scoring).toContain("Score 1-10.");
    expect(scoring).not.toContain("Tailor rules.");
    expect(scoring).not.toContain("Projects.");
    expect(scoring).not.toContain("Yesterday");
    expect(scoring).not.toMatch(/---\s*\n# MODULE/); // the divider before the modules goes

    const resume = mentorPromptFor(PROMPT, "resume");
    expect(resume).toContain("Tailor rules.");
    expect(resume).not.toContain("Score 1-10.");
    expect(mentorPromptFor(PROMPT, "checkin")).toContain("Yesterday");
  });

  it("returns a prompt without modules whole", () => {
    expect(mentorPromptFor("# Old prompt\nEverything.", "scoring")).toBe("# Old prompt\nEverything.");
  });

  it("fills v2 slots (description kept as a note) and self-closing ones", () => {
    const out = fillMentorPrompt(PROMPT, { candidate_inventory: "INV", networking_summary: "NS" });
    expect(out).toContain("<candidate_inventory>\n(verified facts)\nINV\n</candidate_inventory>");
    expect(out).toContain("<networking_summary>\nNS\n</networking_summary>");
    // v1 shape still works, and drops the [inject …] instruction.
    expect(fillMentorPrompt("<current_resume>[inject the resume]</current_resume>", { current_resume: "R" })).toBe("<current_resume>\nR\n</current_resume>");
  });
});

describe("pinning questions to lines", () => {
  const base = parseResume(FIXTURE_RESUME);
  it("keeps valid questions, drops ones for removed or missing lines, and skills already on the page", () => {
    const { assumptions, skillsAdded } = pendingQuestions(base, {
      lineEdits: [{ id: "0.0.1", after: "Built the Claude pipeline (prompts, structured output, validation)", reason: "LLM" }],
      removeBullets: [{ id: "0.0.2", reason: "space" }],
      assumptionQuestions: [
        { question: "Did you test the Claude pipeline?", draft: "Built and tested the Claude pipeline [CONFIRM]", needs: "yes/no", lineId: "0.0.1" },
        { question: "Gone?", draft: "x", needs: "", lineId: "0.0.2" }, // removed by the plan
        { question: "Nowhere?", draft: "x", needs: "", lineId: "9.9.9" },
      ],
      skillsAdded: [
        { skill: "GitHub Actions", lineId: "2.L0", reason: "CI/CD" },
        { skill: "python", lineId: "2.L0", reason: "already there" },
        { skill: "React", lineId: "0.0.0", reason: "not a Skills line" },
      ],
    });
    expect(assumptions).toEqual([
      expect.objectContaining({ draft: "Built and tested the Claude pipeline", targetText: "Built the Claude pipeline (prompts, structured output, validation)", status: "open" }),
    ]);
    expect(skillsAdded.map((s) => s.skill)).toEqual(["GitHub Actions"]);
  });

  it("finds a Skills line by its label after it changed", () => {
    const changed = parseResume(FIXTURE_RESUME.replace("Languages: TypeScript, Python, PHP", "Languages: TypeScript, Python, PHP, Java"));
    expect(findPinnedLine(changed, "Languages: TypeScript, Python, PHP", "line")?.id).toBe("2.L0");
  });
});

describe("assumption protocol, end to end", () => {
  let db: DB;
  let app: ReturnType<typeof buildApp>;
  let dir: string;
  const inventory = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "inventory.md"), "utf8");
  const req = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as object });
    return { status: res.statusCode, body: res.json() };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-private-"));
    db = makeTestDb();
    db.update(settings).set({ standardAnswers: [{ question: "When can you start?", answer: "Two weeks after an offer." }] }).run();
    const { tailor } = fakeTailor({
      assumptionQuestions: [
        { question: "Did you write tests for the Claude pipeline? What did they cover?", draft: "Built and tested the Claude pipeline's prompts, structured output and validation", needs: "yes/no, and the tool", lineId: "0.0.1" },
        { question: "How many teachers did you work with?", draft: "Checked dictionary output with 6 Chinese teachers", needs: "the number", lineId: "0.0.0" },
        { question: "Did you design the caching?", draft: "Designed the caching layer behind search", needs: "yes/no", lineId: "0.0.2" },
      ],
      skillsAdded: [
        { skill: "GitHub Actions", lineId: "2.L0", reason: "CI/CD in the posting" },
        { skill: "React", lineId: "2.L0", reason: "frontend" },
      ],
    });
    // Facts re-read from the inventory plus confirmed additions, as in production.
    const deps = prepDeps({ getTailor: () => ({ tailor }), privateDir: dir, facts: () => parseInventory(withConfirmedAdditions(inventory, dir)) });
    app = buildApp(db, { pipeline: OFFLINE_PIPELINE, prep: deps });
  });

  async function tailored() {
    await req("PUT", "/api/resumes/bases/fde", { text: FIXTURE_RESUME });
    await req("PUT", "/api/resumes/bases/swe", { text: FIXTURE_RESUME });
    const { body: job } = await req("POST", "/api/jobs", { companyName: "Acme AI", title: "Forward Deployed Engineer", location: "Chicago, IL", description: FDE_JD });
    db.update(jobs).set({ tier: "A", fitScore: 9 }).where(eq(jobs.id, job.job.id)).run();
    const { body } = await req("POST", "/api/applications", { jobId: job.job.id });
    return body;
  }

  it("drafts never reach the resume until confirmed; a yes saves the answer and applies the line", async () => {
    const a = await tailored();
    expect(a.tailoring.assumptions).toHaveLength(3);
    expect(a.resumeText).not.toContain("tested");

    const r = await req("POST", `/api/applications/${a.id}/tailoring/answer`, { kind: "assumption", index: 0, confirmed: true, answer: "Yes, unit tests for validation and language checks" });
    expect(r.status).toBe(200);
    expect(r.body.resumeText).toContain("Built and tested the Claude pipeline's prompts, structured output and validation");
    expect(r.body.tailoring.assumptions[0]).toMatchObject({ status: "confirmed", answer: "Yes, unit tests for validation and language checks" });
    const saved = fs.readFileSync(path.join(dir, "confirmed_additions.md"), "utf8");
    expect(saved).toContain("Did you write tests for the Claude pipeline?");
    expect(saved).toContain("unit tests for validation");

    // Answered once is answered.
    expect((await req("POST", `/api/applications/${a.id}/tailoring/answer`, { kind: "assumption", index: 0, confirmed: true })).status).toBe(409);
  });

  it("a number must come from her answer, and is saved as [HER ESTIMATE]", async () => {
    const a = await tailored();
    const noNumber = await req("POST", `/api/applications/${a.id}/tailoring/answer`, { kind: "assumption", index: 1, confirmed: true, answer: "Yes" });
    expect(noNumber.status).toBe(409);
    expect(noNumber.body.error).toContain("6");

    const ok = await req("POST", `/api/applications/${a.id}/tailoring/answer`, { kind: "assumption", index: 1, confirmed: true, answer: "About 6" });
    expect(ok.status).toBe(200);
    expect(ok.body.truth.issues.filter((i: { kind: string }) => i.kind === "unverified_number")).toEqual([]); // now inventory
    expect(fs.readFileSync(path.join(dir, "confirmed_additions.md"), "utf8")).toContain("[HER ESTIMATE]");
  });

  it("can't confirm something ownership rules or DO NOT CLAIM forbid", async () => {
    const a = await tailored();
    const r = await req("POST", `/api/applications/${a.id}/tailoring/answer`, { kind: "assumption", index: 2, confirmed: true, answer: "Yes" });
    expect(r.status).toBe(409);
    expect(fs.existsSync(path.join(dir, "confirmed_additions.md"))).toBe(false);
  });

  it("declining leaves the resume alone", async () => {
    const a = await tailored();
    const r = await req("POST", `/api/applications/${a.id}/tailoring/answer`, { kind: "assumption", index: 0, confirmed: false });
    expect(r.body.tailoring.assumptions[0].status).toBe("declined");
    expect(r.body.resumeText).toEqual(a.resumeText);
  });

  it("skills: confirmed ones are listed, and every suggestion feeds Skills to build", async () => {
    const a = await tailored();
    const r = await req("POST", `/api/applications/${a.id}/tailoring/answer`, { kind: "skill", index: 0, confirmed: true });
    expect(r.body.resumeText).toContain("Languages: TypeScript, Python, PHP, GitHub Actions");
    await req("POST", `/api/applications/${a.id}/tailoring/answer`, { kind: "skill", index: 1, confirmed: false });
    const { body } = await req("GET", "/api/skills-to-build");
    expect(body).toEqual([
      { skill: "GitHub Actions", count: 1, companies: ["Acme AI"], listed: true },
      { skill: "React", count: 1, companies: ["Acme AI"], listed: false },
    ]);
  });
});
