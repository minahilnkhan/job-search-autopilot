import type { EmploymentFlags, ExtractedFields, SponsorshipStated } from "../../../shared/types";

// Regex extraction. Its job is to PREFILL fields the user then confirms, not
// to be the final word: the hard filters run on the reviewed fields. Every
// detection keeps the JD snippet that triggered it, so a wrong guess is easy
// to spot and fix.

const SNIPPET_RADIUS = 40;

/**
 * The matched phrase plus a little context, with the match wrapped in «»
 * so the UI can highlight exactly the words that triggered the rule.
 */
function snippet(text: string, index: number, length: number): string {
  const clean = (t: string) => t.replace(/\s+/g, " ");
  let before = text.slice(Math.max(0, index - SNIPPET_RADIUS), index);
  let after = text.slice(index + length, index + length + SNIPPET_RADIUS);
  const cutBefore = index - SNIPPET_RADIUS > 0;
  const cutAfter = index + length + SNIPPET_RADIUS < text.length;
  // Don't start or end mid-word.
  if (cutBefore) before = before.replace(/^\S*\s/, "");
  if (cutAfter) after = after.replace(/\s\S*$/, "");
  return (
    (cutBefore ? "…" : "") +
    clean(before).trimStart() +
    "«" + clean(text.slice(index, index + length)) + "»" +
    clean(after).trimEnd() +
    (cutAfter ? "…" : "")
  );
}

/** First match across patterns, with a snippet for evidence. */
function findFirst(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return snippet(text, m.index, m[0].length);
  }
  return null;
}

/**
 * EEO and legal boilerplate mentions "citizenship", "national origin", and
 * "veteran status" in a non-requirement sense ("without regard to …
 * citizenship"). We drop those sentences before looking for real requirements.
 */
const BOILERPLATE =
  /equal (employment )?opportunity|without regard to|regardless of|protected (veteran|class|characteristic)|discriminat|affirmative action|e-?verify participation|pay transparency/i;

export function stripBoilerplate(text: string): string {
  return text
    // Split after a period only when a lowercase letter, digit or ")" precedes
    // it, so abbreviations like "U.S." don't break a sentence in two.
    .split(/(?<=[a-z0-9)][.!?])\s+|\n+/)
    .filter((sentence) => !BOILERPLATE.test(sentence))
    .join("\n");
}

// ---- Years of experience -------------------------------------------------

// "3+ years of experience", "3-5 years' professional experience",
// "minimum of 4 years in software engineering", "5 yrs exp".
const YEARS_PATTERN =
  /\b(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs?)['’]?(?:\s+of)?[^.\n;]{0,60}?\b(?:experience|exp\b|industry|professional|engineering|development|software)/gi;

function extractYears(text: string): { years: number | null; evidence?: string } {
  let best: { years: number; evidence: string } | null = null;
  for (const m of text.matchAll(YEARS_PATTERN)) {
    const years = Number(m[1]);
    if (years > 20) continue; // "founded 25 years ago" and similar noise
    // Use the LOWER bound of a range ("3-5 years" → 3) and the HIGHEST such
    // requirement in the JD. Conservative: if any line asks for 5+, we see 5.
    if (!best || years > best.years) {
      best = { years, evidence: snippet(text, m.index ?? 0, m[0].length) };
    }
  }
  return best ? { years: best.years, evidence: best.evidence } : { years: null };
}

// ---- Remote ----------------------------------------------------------------

const NOT_REMOTE = /\b(?:not|no|non)[- ]remote\b|\bremote work is not\b|\bfully on-?site\b/i;
const REMOTE = /\bremote\b|\bwork from home\b|\bwfh\b/i;
const REMOTE_US =
  /\bremote\s*(?:[-–—(,:]|\bin\b|\bwithin\b|\bacross\b)?\s*(?:the\s+)?(?:us|u\.s\.?|usa|united states)\b|\b(?:us|u\.s\.?|usa|united states)[- ](?:based\s+)?remote\b/i;

// ---- Sponsorship -----------------------------------------------------------

// Checked before the "yes" patterns: "we will not sponsor" contains "sponsor".
const SPONSORSHIP_NO = [
  /\b(?:not|unable to|cannot|can['’]?t|won['’]?t|will not|do not|does not|don['’]?t|doesn['’]?t)\s+(?:be\s+able\s+to\s+)?(?:offer|provide|support|consider)?\s*(?:visa\s+|immigration\s+|employment\s+)?sponsor(?:ship|ing)?\b/i,
  /\bno\s+(?:visa\s+|immigration\s+|h-?1b\s+)?sponsorship\b/i,
  /\bsponsorship\s+(?:is\s+)?not\s+(?:available|offered|provided|possible)\b/i,
  /\bwithout\s+(?:the\s+)?(?:need\s+for\s+)?(?:current\s+or\s+future\s+|now\s+or\s+in\s+the\s+future\s+)?(?:visa\s+|employer\s+|employment\s+)?sponsorship\b/i,
  /\bnot\s+eligible\s+for\s+(?:visa\s+)?sponsorship\b/i,
];
const SPONSORSHIP_YES = [
  /\b(?:visa|h-?1b|immigration)\s+sponsorship\s+(?:is\s+)?(?:available|offered|provided)\b/i,
  /\bsponsorship\s+(?:is\s+)?available\b/i,
  /\b(?:we|will|can|able to)\s+(?:offer\s+|provide\s+)?(?:visa\s+)?sponsor(?:ship)?\b/i,
  /\bopen to sponsoring\b/i,
];

function extractSponsorship(text: string): { value: SponsorshipStated; evidence?: string } {
  const no = findFirst(text, SPONSORSHIP_NO);
  if (no) return { value: "no", evidence: no };
  const yes = findFirst(text, SPONSORSHIP_YES);
  if (yes) return { value: "yes", evidence: yes };
  return { value: "unstated" };
}

// ---- Employment type -------------------------------------------------------

const EMPLOYMENT_PATTERNS: Record<keyof EmploymentFlags, RegExp[]> = {
  w1099: [/\b1099\b/],
  c2c: [/\bc2c\b|\bcorp[- ]to[- ]corp\b/i],
  freelance: [/\bfreelanc(?:e|er|ing)\b/i],
  unpaid: [/\bunpaid\b/i],
  commissionOnly: [/\bcommission[- ]only\b|\b100%\s+commission\b|\bcommission[- ]based\s+(?:only|compensation)\b/i],
  contractToHire: [/\bcontract[- ]to[- ](?:hire|perm(?:anent)?)\b|\bc2h\b/i],
  contract: [
    /\bcontract(?:or)?\s+(?:role|position|basis|assignment|opportunity|engagement)\b/i,
    /\b\d+\s*[- ]?\s*months?\s+(?:w2\s+)?contract\b/i,
    /\bemployment type:?\s*contract\b/i,
    /\btemporary\s+(?:role|position)\b/i,
  ],
  staffingAgency: [
    /\b(?:our|a)\s+client\b[^.]{0,40}\b(?:is\s+)?(?:seeking|looking|hiring)\b/i,
    /\bon behalf of (?:our|a|one of our) clients?\b/i,
    /\bstaffing (?:agency|firm|company)\b/i,
    /\bimplementation partner\b/i,
  ],
  partTime: [/\bpart[- ]time\b/i],
};

// ---- Clearance / citizenship -----------------------------------------------

const CLEARANCE = [
  /\b(?:security|secret|top secret|ts\/sci|public trust|dod)\s+clearance\b/i,
  /\bclearance\s+(?:is\s+)?required\b/i,
  /\bactive\s+(?:secret|top secret|ts\/sci|ts)\b/i,
  /\bTS\/SCI\b/,
  /\b(?:obtain|maintain|hold)\s+(?:a|an)\s+(?:active\s+)?(?:government|federal)?\s*clearance\b/i,
];

const CITIZENSHIP = [
  /\bmust\s+be\s+(?:a\s+)?(?:u\.?s\.?|united states)\s+citizen\b/i,
  /\b(?:u\.?s\.?|united states)\s+citizen(?:ship)?\s+(?:is\s+)?(?:required|only)\b/i,
  /\b(?:u\.?s\.?|united states)\s+citizens\s+only\b/i,
  /\brequires?\s+(?:u\.?s\.?|united states)\s+citizenship\b/i,
  /\bmust\s+be\s+(?:a\s+)?(?:u\.?s\.?|united states)\s+persons?\b/i,
  /\b(?:u\.?s\.?|united states)\s+persons?\b[^.]{0,80}\b(?:ITAR|EAR|export)\b/i,
  /\bITAR\b/, // case-sensitive on purpose: "itar" inside words never matches
  /\bexport[- ]control(?:led)?\b[^.]{0,80}\b(?:citizen|u\.?s\.? person)/i,
];

// ---- Main ------------------------------------------------------------------

export function extractFields(input: {
  title: string;
  location?: string | null;
  description: string;
}): ExtractedFields {
  const raw = input.description;
  const text = stripBoilerplate(raw);
  const location = input.location ?? "";
  const evidence: Record<string, string> = {};

  const years = extractYears(text);
  if (years.evidence) evidence.yearsRequired = years.evidence;

  const locationAndText = `${location}\n${input.title}\n${text}`;
  const remote = !NOT_REMOTE.test(locationAndText) && REMOTE.test(locationAndText);
  const remoteEvidence = remote ? findFirst(locationAndText, [REMOTE]) : null;
  if (remoteEvidence) evidence.remote = remoteEvidence;
  const remoteUs = findFirst(locationAndText, [REMOTE_US]);
  if (remoteUs) evidence.remoteCountryStated = remoteUs;

  const sponsorship = extractSponsorship(text);
  if (sponsorship.evidence) evidence.sponsorshipStated = sponsorship.evidence;

  const employment = {} as EmploymentFlags;
  const titleAndText = `${input.title}\n${text}`;
  for (const key of Object.keys(EMPLOYMENT_PATTERNS) as (keyof EmploymentFlags)[]) {
    const hit = findFirst(titleAndText, EMPLOYMENT_PATTERNS[key]);
    employment[key] = hit !== null;
    if (hit) evidence[`employment.${key}`] = hit;
  }

  // Read from the RAW text: the E-Verify notice usually sits in the boilerplate we stripped.
  const eVerify = findFirst(raw, [/\bparticipates in e-?verify\b|\be-?verify (?:employer|participant|participation)\b/i]);
  if (eVerify) evidence.eVerifyMentioned = eVerify;

  const clearance = findFirst(text, CLEARANCE);
  if (clearance) evidence.requiresClearance = clearance;
  const citizenship = findFirst(text, CITIZENSHIP);
  if (citizenship) evidence.requiresCitizenship = citizenship;

  return {
    yearsRequired: years.years,
    remote,
    // A location string that names the US also counts ("Remote - United States").
    remoteCountryStated: remoteUs !== null,
    sponsorshipStated: sponsorship.value,
    employment,
    requiresClearance: clearance !== null,
    requiresCitizenship: citizenship !== null,
    eVerifyMentioned: eVerify !== null,
    evidence,
  };
}
