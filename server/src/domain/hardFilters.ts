import type { EVerify, ExtractedFields, FilterReason } from "../../../shared/types";
import { isTargetRole } from "./roleFamily";

// Hard filters from job-mentor-prompt.md, as pure functions. No DB, no LLM,
// no clock: the caller passes in everything, so every rule is unit-testable.
// All filters run every time (no short-circuit) so the UI shows every reason
// a job failed, not just the first.

export type FilterInput = {
  title: string;
  location: string | null;
  fields: ExtractedFields;
  company: { eVerify: EVerify };
  history: {
    /** An approved-or-later application exists for this role at this company. */
    alreadyApplied: boolean;
    /** Approved-or-later applications at this company in the last 30 days. */
    companyAppsLast30Days: number;
  };
  /** True for job-board postings: titles outside your target roles fail before any AI scoring. */
  requireTargetRole?: boolean;
};

export type FilterResult = { pass: boolean; reasons: FilterReason[] };

export const E_VERIFY_SEARCH_URL = "https://www.e-verify.gov/e-verify-employer-search";

const MAX_YEARS = 4; // 4+ years required = skip; 2–3 is fine
const MAX_COMPANY_APPS_30D = 2;

const SENIOR_TITLE = /\b(senior|sr\.?|staff|lead|principal|director|head of|vp|vice president|chief)\b/i;
const LEVEL_THREE = /\b(iii|3)\s*$|\b(iii)\b/i;
const PURE_SALES_TITLE =
  /\b(account executive|sales (?:development )?rep(?:resentative)?|business development rep(?:resentative)?|sdr|bdr|inside sales)\b/i;

const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
const US_STATE_NAMES =
  "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming";
// Words that clearly mean US. A ", XX" state suffix is weaker evidence, because
// "IN" and "CA" are also country codes (Bengaluru, IN / Toronto, CA).
const US_WORDS = new RegExp(
  `\\b(united states|usa|u\\.s\\.a?\\.?|us|${US_STATE_NAMES}|nyc|san francisco|bay area|seattle|chicago|boston|austin|los angeles|denver|atlanta)\\b`,
  "i"
);
const US_STATE_SUFFIX = new RegExp(`,\\s*(${US_STATES})\\b`); // case-sensitive
const NON_US_LOCATION =
  /\b(canada|toronto|vancouver|montreal|mexico|brazil|argentina|colombia|latam|uk|united kingdom|england|london|ireland|dublin|germany|berlin|munich|france|paris|spain|madrid|barcelona|portugal|lisbon|netherlands|amsterdam|poland|warsaw|sweden|stockholm|switzerland|zurich|europe|emea|apac|india|bangalore|bengaluru|hyderabad|pune|singapore|japan|tokyo|korea|seoul|china|australia|sydney|melbourne|new zealand|israel|tel aviv|uae|dubai|philippines|pakistan)\b/i;

function locationCheck(location: string | null, f: ExtractedFields): FilterReason | null {
  const loc = (location ?? "").trim();
  if (!loc) {
    if (f.remote && !f.remoteCountryStated) {
      return { code: "remote_no_country", severity: "warn", message: "Remote, but the posting doesn't say remote-US. Confirm before applying." };
    }
    if (f.remote) return null; // remote-US stated in the JD body
    return { code: "location_missing", severity: "warn", message: "No location given. Confirm it's in the US." };
  }
  const nonUs = NON_US_LOCATION.test(loc);
  const usWord = US_WORDS.test(loc);
  // A non-US place wins unless a clear US word is also there ("New York or London").
  if (nonUs && !usWord) {
    return { code: "location_non_us", severity: "fail", message: `Location is outside the US: "${loc}".`, evidence: loc };
  }
  const usMatch = usWord || US_STATE_SUFFIX.test(loc);
  if (usMatch) return null;
  if (f.remote) {
    return f.remoteCountryStated
      ? null
      : { code: "remote_no_country", severity: "warn", message: "Remote, but the posting doesn't say remote-US. Confirm before applying." };
  }
  return { code: "location_unknown", severity: "warn", message: `Couldn't confirm "${loc}" is in the US.`, evidence: loc };
}

export function runHardFilters(input: FilterInput): FilterResult {
  const { title, fields: f, company, history } = input;
  const reasons: FilterReason[] = [];
  const fail = (code: string, message: string, evidenceKey?: string) =>
    reasons.push({ code, severity: "fail", message, evidence: evidenceKey ? f.evidence[evidenceKey] : undefined });
  const warn = (code: string, message: string, evidenceKey?: string) =>
    reasons.push({ code, severity: "warn", message, evidence: evidenceKey ? f.evidence[evidenceKey] : undefined });

  // --- Role family (job-board postings only)
  if (input.requireTargetRole && !isTargetRole(title)) {
    fail("off_target_role", "Not one of your target roles (FDE, solutions, deployment, applied AI, new-grad or full-stack/backend SWE), so it wasn't scored.");
  }

  // --- Experience / seniority
  if (f.yearsRequired === null) {
    warn("years_missing", "Years of experience not found. Check the requirements section.");
  } else if (f.yearsRequired >= MAX_YEARS) {
    fail("experience_4plus", `Asks for ${f.yearsRequired}+ years (skip at ${MAX_YEARS}+).`, "yearsRequired");
  }
  const senior = SENIOR_TITLE.exec(title);
  if (senior) fail("title_senior", `Title is senior-level ("${senior[0]}").`);
  if (LEVEL_THREE.test(title)) warn("title_level_3", 'Title has level "III", which is usually mid/senior. Check the years asked.');
  if (PURE_SALES_TITLE.test(title)) fail("pure_sales", "Pure sales role. Excluded, and a STEM OPT risk (not related to the CS degree).");

  // --- Location
  const loc = locationCheck(input.location, f);
  if (loc) reasons.push(loc);

  // --- STEM OPT: paid, direct employer, ≥20 h/week
  const e = f.employment;
  if (e.w1099) fail("employment_1099", "1099 contract. STEM OPT needs a W-2 employer-employee relationship.", "employment.w1099");
  if (e.c2c) fail("employment_c2c", "Corp-to-corp. Not a direct employer, so it fails STEM OPT.", "employment.c2c");
  if (e.freelance) fail("employment_freelance", "Freelance / self-employment doesn't qualify for STEM OPT.", "employment.freelance");
  if (e.unpaid) fail("employment_unpaid", "Unpaid role.", "employment.unpaid");
  if (e.commissionOnly) fail("employment_commission", "Commission-only pay.", "employment.commissionOnly");
  if (e.contractToHire) warn("employment_c2h", "Contract-to-hire. Confirm it's W-2 with the hiring company and they'll sign an I-983.", "employment.contractToHire");
  else if (e.contract) warn("employment_contract", "Contract role. Confirm it's W-2, direct, and that they'll sign an I-983.", "employment.contract");
  if (e.staffingAgency) warn("staffing_agency", "Looks like a staffing/consulting firm. These often fail STEM OPT (no direct employer, no I-983).", "employment.staffingAgency");
  if (e.partTime) warn("part_time", "Part-time. STEM OPT needs at least 20 hours/week. Confirm the hours.", "employment.partTime");

  // --- Clearance / citizenship
  if (f.requiresClearance) fail("clearance", "Requires a security clearance.", "requiresClearance");
  if (f.requiresCitizenship) fail("citizenship", "Requires US citizenship / US-person status.", "requiresCitizenship");

  // --- Sponsorship: not a fail. Tier B cap is applied in Phase 2 scoring.
  if (f.sponsorshipStated === "no") {
    warn("no_sponsorship", "Says no visa sponsorship. You can still work there on OPT; it will be capped at Tier B.", "sponsorshipStated");
  }

  // --- E-Verify (STEM OPT requirement; there's no API, so you confirm per company)
  if (company.eVerify === "unknown") {
    warn(
      "everify_unknown",
      f.eVerifyMentioned
        ? `The JD mentions E-Verify, but the company isn't confirmed yet. Confirm at ${E_VERIFY_SEARCH_URL}`
        : `E-Verify status unknown. Check ${E_VERIFY_SEARCH_URL} and set it on the company.`,
      "eVerifyMentioned"
    );
  }

  // --- Application history
  if (history.alreadyApplied) fail("already_applied", "You already applied to this role.");
  if (history.companyAppsLast30Days >= MAX_COMPANY_APPS_30D) {
    fail(
      "company_cap_30d",
      `Already ${history.companyAppsLast30Days} applications at this company in the last 30 days (max ${MAX_COMPANY_APPS_30D}).`
    );
  }

  return { pass: !reasons.some((r) => r.severity === "fail"), reasons };
}
