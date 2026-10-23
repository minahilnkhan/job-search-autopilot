import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeRenderer } from "../src/render/renderer";
import { parseResume } from "../src/domain/resumeFormat";
import { FIXTURE_RESUME } from "./helpers";

// Real Chromium render. Runs where Chromium is available (CHROMIUM_PATH, or the
// Playwright-managed browser); skipped otherwise so CI without it stays green.
const chromium = process.env.CHROMIUM_PATH ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

describe.skipIf(!chromium)("real PDF + DOCX rendering", () => {
  it("renders a one-page PDF and a DOCX from the same content", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
    const r = await makeRenderer({ chromiumPath: chromium })(parseResume(FIXTURE_RESUME), out);
    expect(r.pdfError).toBeNull();
    expect(r.pages).toBe(1);
    expect(fs.readFileSync(r.pdfPath!).subarray(0, 5).toString()).toBe("%PDF-");
    expect(fs.readFileSync(r.docxPath).subarray(0, 2).toString()).toBe("PK"); // DOCX is a zip
  }, 30_000);

  it("reports a long resume as more than one page", async () => {
    const long = FIXTURE_RESUME + "\n## Extra\n" + Array.from({ length: 80 }, (_, i) => `Line about something true ${i % 2 ? "" : "and long enough to wrap"}`).join("\n");
    const r = await makeRenderer({ chromiumPath: chromium })(parseResume(long), fs.mkdtempSync(path.join(os.tmpdir(), "render-")));
    expect(r.pages).toBeGreaterThan(1);
  }, 30_000);

  it("explains how to fix a missing Chromium", async () => {
    const r = await makeRenderer({ chromiumPath: "/nope/chromium" })(parseResume(FIXTURE_RESUME), fs.mkdtempSync(path.join(os.tmpdir(), "render-")));
    expect(r.pdfPath).toBeNull();
    expect(r.pdfError).toContain("npx playwright install chromium");
  }, 30_000);
});
