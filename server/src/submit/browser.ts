import type { Browser, Page } from "playwright";

// A visible Chromium window on your machine for assisted submit. One browser,
// a new tab per application. It's plain automation: navigator.webdriver stays
// true and nothing hides that it's automated (no bot-detection bypass). If a
// site shows a CAPTCHA, you solve it.

export type OpenPage = (url: string, opts?: { headless?: boolean }) => Promise<Page>;

/**
 * The visible window is for prefilling; a hidden one is used only to read a
 * form's questions on sites where you'll apply in your own browser.
 */
export function headedBrowser(executablePath?: string): OpenPage {
  const browsers: Record<"visible" | "hidden", Promise<Browser> | null> = { visible: null, hidden: null };
  const launch = (kind: "visible" | "hidden") => {
    browsers[kind] ??= (async () => {
      const { chromium } = await import("playwright");
      try {
        // SUBMIT_HEADLESS=1 is only for automated checks on a machine without a screen.
        const b = await chromium.launch({ headless: kind === "hidden" || process.env.SUBMIT_HEADLESS === "1", executablePath });
        b.on("disconnected", () => (browsers[kind] = null));
        return b;
      } catch (err) {
        browsers[kind] = null;
        throw new Error(`Couldn't start Chromium. Run "npm run setup:pdf" in the repo folder. (${(err as Error).message.split("\n")[0]})`);
      }
    })();
    return browsers[kind]!;
  };
  return async (url, opts = {}) => {
    const b = await launch(opts.headless ? "hidden" : "visible");
    const context = await b.newContext({ viewport: null }); // fresh cookies per application; window-sized page
    const page = await context.newPage();
    page.on("close", () => void context.close().catch(() => {}));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return page;
  };
}
