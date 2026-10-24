import type { Answer, Profile } from "../../../shared/types";

// Decides what to put in each field of an application form. Pure: the
// browser code (prefill.ts) reads the form into FormControls, this file plans,
// and the browser code carries out the plan. That keeps the matching rules
// testable without a browser.
//
// Fields are matched by their visible label (plus id/name/autocomplete hints),
// not by fixed selectors, so the same rules work on Greenhouse, Lever, Ashby
// and most hand-built forms, and survive markup changes.

export type ControlKind = "text" | "textarea" | "select" | "combobox" | "radio" | "checkbox" | "file";

export type FormControl = {
  id: string; // data-autopilot-id the page code put on the element
  kind: ControlKind;
  label: string; // the question as shown
  hints: string; // id, name, autocomplete, placeholder, input type
  required: boolean;
  value: string; // current value; "" if empty
  options: { id?: string; text: string }[]; // select options, or radio buttons (with their own ids)
};

export type FillAction =
  | { op: "fill"; id: string; label: string; value: string }
  | { op: "select"; id: string; label: string; value: string } // value = the option's text
  | { op: "check"; id: string; label: string; value: string } // id = the radio to check
  | { op: "combobox"; id: string; label: string; value: string; match?: string } // type value, pick the option starting with match (else containing value)
  | { op: "upload"; id: string; label: string; value: string }; // value = file name shown in the report

export type LeftForYou = { label: string; reason: string; required: boolean; controlId?: string };
/** unanswered: questions nothing prepared covers; the answer writer gets a go at them. */
export type FillPlan = { actions: FillAction[]; leftForYou: LeftForYou[]; unanswered: FormControl[] };

export type PrefillValues = {
  profile: Profile;
  answers: Answer[];
  recruiterNote: string | null;
  resumeFileName: string;
};

export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[✱*]/g, " ")
    .replace(/\(required\)|\(optional\)/g, " ")
    .replace(/[^a-z0-9@+/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const short = (label: string) => {
  const t = label.replace(/\s+/g, " ").replace(/[✱*]\s*$/, "").trim();
  return t.length > 120 ? `${t.slice(0, 117)}…` : t || "(unlabeled field)";
};

// Voluntary self-identification questions. Never filled: your call, every time.
const EEO = /\b(gender|race|racial|ethnic|ethnicity|hispanic|latin[oax]|veteran|disabilit|pronoun|sexual orientation|transgender|lgbt)/;

const STOP = new Set(
  "a an and are as at be by can do does for from have how i if in is it me my of on or our please the this to us we what when where which who why will with would you your yourself about any".split(" ")
);
const SYNONYMS: Record<string, string> = { compensation: "salary", pay: "salary", wage: "salary", earliest: "start", begin: "start", notice: "start", learn: "hear", find: "hear", found: "hear" };

function keys(s: string): Set<string> {
  return new Set(
    norm(s)
      .split(" ")
      .filter((w) => w && !STOP.has(w))
      .map((w) => (SYNONYMS[w] ?? w).slice(0, 5))
  );
}

/** How alike two questions are, 0–1 (Dice coefficient on content-word stems). */
export function questionSimilarity(a: string, b: string): number {
  const A = keys(a);
  const B = keys(b);
  if (A.size === 0 || B.size === 0) return 0;
  let both = 0;
  for (const k of A) if (B.has(k)) both++;
  return (2 * both) / (A.size + B.size);
}

const MATCH_AT = 0.6;

type ProfileKey = keyof Profile;
// Hints are normalized too: "first_name" → "first name", "urls[LinkedIn]" → "urls linkedin".
const PROFILE_RULES: { key: ProfileKey; label: RegExp; hint: RegExp }[] = [
  { key: "firstName", label: /\b(first name|given name|preferred first)\b/, hint: /\b(first ?name|given name|fname)\b/ },
  { key: "lastName", label: /\b(last name|surname|family name)\b/, hint: /\b(last ?name|family name|lname)\b/ },
  { key: "email", label: /\be ?mail\b/, hint: /\b(email|type email)\b/ },
  { key: "phone", label: /\b(phone|mobile|cell)\b/, hint: /\b(phone|tel|type tel)\b/ },
  { key: "linkedin", label: /\blinkedin\b/, hint: /linkedin/ },
  { key: "github", label: /\bgithub\b/, hint: /github/ },
  { key: "website", label: /\b(website|portfolio|personal site|blog|other url)\b/, hint: /\b(website|portfolio)\b/ },
  { key: "currentCompany", label: /\b(current (company|employer)|most recent (company|employer))\b/, hint: /\borg\b/ },
  { key: "location", label: /^(current )?(location|city)\b|\bwhere are you (currently )?(located|based)\b|\blocation city\b/, hint: /\b(candidate location|address level2)\b/ },
];
const FULL_NAME_LABEL = /^(full |legal |your )?name$/;
const FULL_NAME_HINT = /(^| )(name|systemfield name)( |$)/;

function profileKey(label: string, hints: string, rawLabel: string): ProfileKey | "fullName" | null {
  if (FULL_NAME_LABEL.test(label)) return "fullName";
  const byLabel = PROFILE_RULES.find((r) => r.label.test(label));
  if (byLabel) return byLabel.key;
  if (rawLabel.includes("?")) return null; // a question, not a contact field; leave it to the answers
  const byHint = PROFILE_RULES.find((r) => r.hint.test(hints));
  if (byHint) return byHint.key;
  if (FULL_NAME_HINT.test(hints) && !/\b(company|school|reference|referr)/.test(label)) return "fullName";
  return null;
}
const NOTE_LABEL = /\b(cover letter|additional information|anything else|message to (the )?(hiring|recruit)|note to (the )?(hiring|recruit))\b/;

/** The option whose text starts with the answer's first word ("Yes, anywhere…" → "Yes"). */
function pickOption(options: { id?: string; text: string }[], answer: string) {
  const a = norm(answer);
  const exact = options.find((o) => norm(o.text) === a);
  if (exact) return exact;
  const first = a.split(" ")[0];
  if (!first) return undefined;
  const hits = options.filter((o) => norm(o.text).split(" ")[0] === first);
  return hits.length === 1 ? hits[0] : undefined;
}

export function planFill(controls: FormControl[], v: PrefillValues): FillPlan {
  const actions: FillAction[] = [];
  const leftForYou: LeftForYou[] = [];
  const unanswered: FormControl[] = [];
  const fixedAuth = v.answers.find((a) => a.source === "fixed" && /authori/i.test(a.question) && !/sponsor/i.test(a.question));
  const fixedSponsor = v.answers.find((a) => a.source === "fixed" && /sponsor/i.test(a.question));
  const fileInputs = controls.filter((c) => c.kind === "file");
  let resumeDone = false;

  for (const c of controls) {
    const label = norm(c.label);
    const hints = norm(c.hints);
    const both = `${label} ${hints}`;

    const left = (reason: string) => leftForYou.push({ label: short(c.label), reason, required: c.required });

    if (c.kind === "file") {
      if (/cover/.test(both)) {
        if (c.required) left("Cover letter file: attach one, or paste your note if there's a text option");
        continue;
      }
      if (!resumeDone && (/\b(resume|cv)\b/.test(both) || fileInputs.length === 1)) {
        actions.push({ op: "upload", id: c.id, label: short(c.label), value: v.resumeFileName });
        resumeDone = true;
      } else if (c.required) left("File upload");
      continue;
    }

    if (c.value.trim()) continue; // never overwrite what's already there (e.g. parsed from the resume)

    if (EEO.test(label)) {
      left("Voluntary self-identification: your call");
      continue;
    }

    // Work authorization: always the fixed answers from Settings.
    const fixed = /\bsponsor/.test(label) ? fixedSponsor : /\b(authori[sz]ed to work|eligible to work|legally (able|allowed|permitted) to work|right to work|work authori[sz]ation)\b/.test(label) ? fixedAuth : undefined;
    if (fixed) {
      const a = planAnswer(c, fixed.answer);
      if (a) actions.push(a);
      else left(`Work authorization: choose "${fixed.answer}" (fixed in Settings)`);
      continue;
    }

    // Country (phone country or residence): she lives and works in the US.
    if (/^(country|country of residence|phone country)$/.test(label)) {
      const act = planAnswer(c, "United States");
      if (act) actions.push(act);
      else if (c.required) left('Pick "United States"');
      continue;
    }

    // Profile fields.
    const key = profileKey(label, hints, c.label);
    if (key) {
      const value = key === "fullName" ? `${v.profile.firstName} ${v.profile.lastName}`.trim() : v.profile[key];
      if (!value) {
        left("Not in Settings → Profile yet");
        continue;
      }
      if (c.kind === "text" || c.kind === "textarea") actions.push({ op: "fill", id: c.id, label: short(c.label), value });
      else if (c.kind === "combobox") actions.push({ op: "combobox", id: c.id, label: short(c.label), value: key === "location" ? value.split(",")[0]!.trim() : value });
      else {
        const a = planAnswer(c, value);
        if (a) actions.push(a);
        else left("Pick this one yourself");
      }
      continue;
    }

    // The recruiter note fits "cover letter" / "additional information" boxes.
    if (c.kind === "textarea" && NOTE_LABEL.test(label)) {
      if (v.recruiterNote) actions.push({ op: "fill", id: c.id, label: short(c.label), value: v.recruiterNote });
      else if (c.required) left("No recruiter note yet");
      continue;
    }

    // Prepared answers (standard and generated), by question similarity.
    const best = v.answers
      .filter((a) => a.source !== "fixed" && a.answer.trim())
      .map((a) => ({ a, s: questionSimilarity(c.label, a.question) }))
      .sort((x, y) => y.s - x.s)[0];
    if (best && best.s >= MATCH_AT) {
      const a = planAnswer(c, best.a.answer);
      if (a) {
        actions.push(a);
        continue;
      }
    }

    if (c.kind === "checkbox") {
      if (c.required) left("Checkbox: read it and tick it yourself");
      continue;
    }
    if (c.required || label) {
      leftForYou.push({ label: short(c.label), reason: c.required ? "No prepared answer" : "Optional, no prepared answer", required: c.required, controlId: c.id });
      if (label) unanswered.push(c);
    }
  }
  return { actions, leftForYou, unanswered };
}

/** The fill action for putting `answer` into control `c`, or null if it can't (e.g. no matching option). */
export function planAnswer(c: FormControl, answer: string): FillAction | null {
  const label = short(c.label);
  switch (c.kind) {
    case "text":
    case "textarea":
      return { op: "fill", id: c.id, label, value: answer };
    case "select": {
      const o = pickOption(c.options, answer);
      return o ? { op: "select", id: c.id, label, value: o.text } : null;
    }
    case "radio": {
      const o = pickOption(c.options, answer);
      return o?.id ? { op: "check", id: o.id, label, value: o.text } : null;
    }
    case "combobox": {
      // Options aren't known until it opens; type the answer's first word ("Yes").
      const first = answer.trim().split(/[\s,.]+/)[0];
      return first ? { op: "combobox", id: c.id, label, value: first, match: answer.trim() } : null;
    }
    default:
      return null;
  }
}
