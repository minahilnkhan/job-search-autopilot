// Did the page you submitted turn into a "thanks, we got it" page? Checked
// every couple of seconds while the form is open; you can always mark it
// submitted by hand instead.

const URL_SIGNS = /\/(confirmation|thanks|thank-you|thankyou|application[_-]?confirmation|submitted)(\/|$|\?)/i;
const TEXT_SIGNS =
  /thank(s| you) for (applying|your application|submitting)|application (has been |was )?(submitted|received)|we('ve| have) received your application|your application (is|was) (in|complete)/i;

export function looksSubmitted(url: string, pageText: string): boolean {
  if (URL_SIGNS.test(url)) return true;
  // Only the first part of the page: a job description's footer can say
  // "thank you for your interest", which shouldn't count.
  return TEXT_SIGNS.test(pageText.slice(0, 4000));
}

// The site refused the submission as automated or spam (Ashby: "flagged as
// possible spam"). The app doesn't try to get around this; it switches that
// site to the copy panel in your own browser.
const BLOCK_SIGNS =
  /flagged as (possible |potential )?spam|suspicious (activity|submission)|automated (submission|traffic|browser)|couldn'?t submit your application|unusual traffic|verify (that )?you are (a )?human/i;

export function looksBlocked(pageText: string): boolean {
  return BLOCK_SIGNS.test(pageText.slice(0, 6000));
}

/** The key used in Settings → "apply in your own browser for": the ATS name, or the site's hostname. */
export function siteKey(ats: string, url: string): string {
  if (ats !== "other") return ats;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
