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
