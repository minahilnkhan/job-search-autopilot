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

type Browser = Awaited<ReturnType<typeof import("playwright")["chromium"]["launch"]>>;

/**
 * Chromium (via Playwright) prints the HTML to PDF; one-time setup on your
 * machine is `npm run setup:pdf`. One browser is kept open and reused for
 * every PDF (launching one per resume was most of the render time) and is
 * relaunched if it dies. If it can't start, the DOCX is still written and the
 * PDF error says how to fix it.
 */
function browserPool(executablePath?: string) {
  let browser: Promise<Browser> | null = null;
  const get = async () => {
    if (!browser) {
      browser = (async () => {
        const { chromium } = await import("playwright");
        try {
          const b = await chromium.launch({ executablePath });
          b.on("disconnected", () => (browser = null));
          return b;
        } catch (err) {
          browser = null;
          throw new RenderUnavailableError(
            `Couldn't start Chromium to make the PDF. Run "npm run setup:pdf" in the repo folder, then press Regenerate. (${(err as Error).message.split("\n")[0]})`
          );
        }
      })();
    }
    return browser;
  };
  return async (html: string): Promise<Uint8Array> => {
    const b = await get();
    const page = await b.newPage();
    try {
      await page.setContent(html, { waitUntil: "load" });
      return await page.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true });
    } finally {
      await page.close();
    }
  };
}

export function makeRenderer(opts: { chromiumPath?: string } = {}): Renderer {
  const htmlToPdf = browserPool(opts.chromiumPath);
  return async (content, outDir) => {
    fs.mkdirSync(outDir, { recursive: true });
    const docxPath = path.join(outDir, "resume.docx");
    fs.writeFileSync(docxPath, await resumeDocx(content));
    const pdfPath = path.join(outDir, "resume.pdf");
    try {
      const pdf = await htmlToPdf(resumeHtml(content));
      fs.writeFileSync(pdfPath, pdf);
      return { pdfPath, docxPath, pages: await countPdfPages(pdf), pdfError: null };
    } catch (err) {
      fs.rmSync(pdfPath, { force: true });
      return { pdfPath: null, docxPath, pages: null, pdfError: (err as Error).message };
    }
  };
}
