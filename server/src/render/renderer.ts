import fs from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import type { ResumeContent } from "../../../shared/types";
import { resumeHtml } from "./resumeHtml";
import { resumeDocx } from "./resumeDocx";

export type RenderResult = { pdfPath: string | null; docxPath: string; pages: number | null; pdfError: string | null };
export type Renderer = (content: ResumeContent, outDir: string) => Promise<RenderResult>;

export class RenderUnavailableError extends Error {}

export async function countPdfPages(pdf: Uint8Array): Promise<number> {
  return (await PDFDocument.load(pdf)).getPageCount();
}

/**
 * Chromium (via Playwright) prints the HTML to PDF. One-time setup on your
 * machine: `npx playwright install chromium`. If it's missing, the DOCX is
 * still written and the PDF error says how to fix it.
 */
async function htmlToPdf(html: string, executablePath?: string): Promise<Uint8Array> {
  const { chromium } = await import("playwright");
  let browser;
  try {
    browser = await chromium.launch({ executablePath });
  } catch (err) {
    throw new RenderUnavailableError(
      `Couldn't start Chromium to make the PDF. Run "npx playwright install chromium" in the repo folder, then press Regenerate. (${(err as Error).message.split("\n")[0]})`
    );
  }
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

export function makeRenderer(opts: { chromiumPath?: string } = {}): Renderer {
  return async (content, outDir) => {
    fs.mkdirSync(outDir, { recursive: true });
    const docxPath = path.join(outDir, "resume.docx");
    fs.writeFileSync(docxPath, await resumeDocx(content));
    const pdfPath = path.join(outDir, "resume.pdf");
    try {
      const pdf = await htmlToPdf(resumeHtml(content), opts.chromiumPath);
      fs.writeFileSync(pdfPath, pdf);
      return { pdfPath, docxPath, pages: await countPdfPages(pdf), pdfError: null };
    } catch (err) {
      fs.rmSync(pdfPath, { force: true });
      return { pdfPath: null, docxPath, pages: null, pdfError: (err as Error).message };
    }
  };
}
