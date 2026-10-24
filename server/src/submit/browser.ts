import type { Browser, Page } from "playwright";

// A visible Chromium window on your machine for assisted submit. One browser,
// a new tab per application. It's plain automation: navigator.webdriver stays
// true and nothing hides that it's automated (no bot-detection bypass). If a
// site shows a CAPTCHA, you solve it.

export function headedBrowser(executablePath?: string): (url: string) => Promise<Page> {
  let browser: Promise<Browser> | null = null;
  return async (url) => {
    if (!browser) {
      browser = (async () => {
        const { chromium } = await import("playwright");
        try {
          // SUBMIT_HEADLESS=1 is only for automated checks on a machine without a screen.
          const b = await chromium.launch({ headless: process.env.SUBMIT_HEADLESS === "1", executablePath });
          b.on("disconnected", () => (browser = null));
          return b;
        } catch (err) {
          browser = null;
          throw new Error(`Couldn't start Chromium. Run "npm run setup:pdf" in the repo folder. (${(err as Error).message.split("\n")[0]})`);
        }
      })();
    }
    const b = await browser;
    const context = await b.newContext({ viewport: null }); // fresh cookies per application; window-sized page
    const page = await context.newPage();
    page.on("close", () => void context.close().catch(() => {}));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return page;
  };
}
