import type { Frame, Page } from "playwright";
import type { FormControl, FillAction, FillPlan, LeftForYou, PrefillValues } from "./plan";
import { planAnswer, planFill } from "./plan";

// Reads a real application form, fills what the plan says, and stops. It
// never submits and never touches a CAPTCHA: you review the form and press
// Submit yourself (hard constraint). The only button it may click is a
// resume "Attach"/"Upload" button, to open the file picker when a form has
// no plain file input.

export type PrefillResult = {
  readError?: string;
  filled: { label: string; value: string }[];
  leftForYou: LeftForYou[];
  resumeUploaded: boolean;
  notices: string[];
  /** Questions the answer writer handed back to you, with where to type your reply. */
  asks: { control: FormControl; frame: Frame; question: string; draft: string | null }[];
};

/**
 * Called with the questions nothing prepared covers. Returns answers to type
 * (already Truth-Checked) and questions to put to you.
 */
export type QuestionHandler = (controls: FormControl[]) => Promise<{
  answers: { controlId: string; value: string }[];
  asks: { controlId: string; question: string; draft: string | null }[];
}>;

const ACTION_TIMEOUT = 5000;

/** Runs inside the page: tags every form field and describes it. */
function describeFields(): FormControl[] {
  let n = Number(document.documentElement.dataset.autopilotNext ?? "0");
  const tag = (el: Element) => {
    const existing = el.getAttribute("data-autopilot-id");
    if (existing) return existing;
    const id = `ap${n++}`;
    el.setAttribute("data-autopilot-id", id);
    return id;
  };
  const text = (el: Element | null | undefined) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && (el as HTMLElement).getClientRects().length > 0;
  };
  const labelOf = (el: Element): string => {
    const id = el.getAttribute("id");
    if (id) {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (l && text(l)) return text(l);
    }
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((x) => text(document.getElementById(x))).join(" ").trim();
      if (t) return t;
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const wrap = el.closest("label");
    if (wrap) {
      // The label's own words, without the options of a select inside it.
      const copy = wrap.cloneNode(true) as Element;
      copy.querySelectorAll("select, textarea, input").forEach((x) => x.remove());
      if (text(copy)) return text(copy);
    }
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      const l = p.querySelector("label, legend, [class*='label'], [class*='Label']");
      if (l && !l.contains(el) && !el.contains(l) && text(l)) return text(l);
    }
    return el.getAttribute("placeholder") ?? "";
  };
  const hintsOf = (el: Element) =>
    [el.getAttribute("id"), el.getAttribute("name"), el.getAttribute("autocomplete"), el.getAttribute("placeholder"), `type ${el.getAttribute("type") ?? ""}`]
      .filter(Boolean)
      .join(" ");
  const isRequired = (el: Element, label: string) =>
    (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true" || /[*✱]/.test(label);

  const out: FormControl[] = [];
  const radiosDone = new Set<string>();
  for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute("type") ?? "text").toLowerCase();
    if (["hidden", "submit", "button", "image", "reset", "search"].includes(type)) continue;
    if (el.closest("[aria-hidden='true']") && type !== "file") continue;
    if (type !== "file" && !visible(el)) continue;
    if (el.getAttribute("name") === "g-recaptcha-response" || el.closest(".g-recaptcha, .h-captcha")) continue;

    if (type === "radio") {
      const name = input.name || tag(el);
      if (radiosDone.has(name)) continue;
      radiosDone.add(name);
      const group = Array.from(document.querySelectorAll(`input[type=radio][name="${CSS.escape(name)}"]`)) as HTMLInputElement[];
      const fs = el.closest("fieldset");
      const rg = el.closest("[role=radiogroup]");
      const label = (fs && text(fs.querySelector("legend"))) || (rg && (rg.getAttribute("aria-label") || text(document.getElementById(rg.getAttribute("aria-labelledby") ?? "")))) || labelOf(fs ?? rg ?? el.closest("ul, ol, [class*='options'], [class*='answers']") ?? el.parentElement?.parentElement ?? el);
      const options = group.map((r) => ({ id: tag(r), text: labelOf(r) || r.value }));
      const checked = group.find((r) => r.checked);
      out.push({ id: tag(el), kind: "radio", label, hints: hintsOf(el), required: group.some((r) => r.required) || isRequired(el, label), value: checked ? labelOf(checked) || checked.value : "", options });
      continue;
    }

    const label = labelOf(el);
    const base = { id: tag(el), label, hints: hintsOf(el), required: isRequired(el, label), options: [] as { text: string }[] };
    if (type === "file") {
      out.push({ ...base, kind: "file", value: input.files?.length ? "file" : "" });
    } else if (type === "checkbox") {
      out.push({ ...base, kind: "checkbox", value: input.checked ? "checked" : "" });
    } else if (el.tagName === "SELECT") {
      const s = el as HTMLSelectElement;
      const options = Array.from(s.options).filter((o) => o.value !== "" && !/^(select|choose|please select)/i.test(o.text.trim())).map((o) => ({ text: o.text.trim() }));
      const chosen = s.selectedOptions[0];
      out.push({ ...base, kind: "select", options, value: chosen && chosen.value !== "" ? chosen.text.trim() : "" });
    } else if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list" || /select__input/.test(el.className)) {
      // react-select style: the chosen value is shown next to the input, not in it.
      const box = el.closest("[class*='control'], [class*='container']") ?? el.parentElement?.parentElement;
      const shown = box?.querySelector("[class*='single-value'], [class*='singleValue'], [class*='multi-value']");
      out.push({ ...base, kind: "combobox", value: text(shown) || input.value });
    } else if (el.tagName === "TEXTAREA") {
      out.push({ ...base, kind: "textarea", value: input.value });
    } else {
      out.push({ ...base, kind: "text", value: input.value });
    }
  }
  document.documentElement.dataset.autopilotNext = String(n);
  return out;
}

async function act(frame: Frame, a: FillAction, resumePath: string): Promise<boolean> {
  const loc = frame.locator(`[data-autopilot-id="${a.id}"]`);
  try {
    switch (a.op) {
      case "fill":
        await loc.fill(a.value, { timeout: ACTION_TIMEOUT });
        return (await loc.inputValue({ timeout: ACTION_TIMEOUT })) === a.value;
      case "select":
        await loc.selectOption({ label: a.value }, { timeout: ACTION_TIMEOUT });
        return true;
      case "check":
        // Radios are often visually hidden behind styled labels; click in-page.
        await loc.evaluate((el) => (el as HTMLInputElement).click());
        return await loc.isChecked();
      case "upload":
        await loc.setInputFiles(resumePath, { timeout: ACTION_TIMEOUT });
        return (await loc.evaluate((el) => (el as HTMLInputElement).files?.length ?? 0)) > 0;
      case "combobox": {
        await loc.click({ timeout: ACTION_TIMEOUT });
        await loc.pressSequentially(a.value, { delay: 40, timeout: ACTION_TIMEOUT });
        const option = frame.getByRole("option", { name: new RegExp(a.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first();
        await option.waitFor({ state: "visible", timeout: ACTION_TIMEOUT });
        await option.click({ timeout: ACTION_TIMEOUT });
        return true;
      }
    }
  } catch {
    return false;
  }
}

async function runPlan(frame: Frame, plan: Pick<FillPlan, "actions" | "leftForYou">, resumePath: string, result: PrefillResult) {
  for (const a of plan.actions) {
    if (await act(frame, a, resumePath)) {
      result.filled.push({ label: a.label, value: a.value });
      if (a.op === "upload") result.resumeUploaded = true;
    } else if (a.op !== "upload") {
      result.leftForYou.push({ label: a.label, reason: `Couldn't fill it automatically. Value: ${a.value}`, required: true });
    }
  }
  result.leftForYou.push(...plan.leftForYou);
}

/** Fill one control with a value (used for answers you give in the chat after the fact). */
export async function fillControl(frame: Frame, control: FormControl, value: string): Promise<boolean> {
  const a = planAnswer(control, value);
  return a ? act(frame, a, "") : false;
}

// tsx/esbuild wraps named functions in a __name() helper that doesn't exist
// inside the page; define a no-op one before sending page code across.
async function readFields(frame: Frame): Promise<FormControl[]> {
  await frame.evaluate("window.__name = window.__name || ((f) => f)");
  return frame.evaluate(describeFields);
}

/**
 * No plain file input took the resume: find an "Attach" / "Upload" button
 * near the word "Resume" or "CV" and answer its file picker.
 */
async function attachViaButton(page: Page, frame: Frame, resumePath: string): Promise<boolean> {
  await frame.evaluate("window.__name = window.__name || ((f) => f)");
  const id = await frame.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button, [role=button], label, a")) as HTMLElement[];
    for (const b of buttons) {
      if (!/^(attach|upload|choose file|browse|select file|upload file|upload resume)/i.test((b.innerText || "").trim())) continue;
      let p: HTMLElement | null = b;
      for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
        const t = p.innerText || "";
        if (/\b(resume|cv)\b/i.test(t) && !/cover letter/i.test(t)) {
          b.setAttribute("data-autopilot-attach", "1");
          return true;
        }
      }
    }
    return false;
  });
  if (!id) return false;
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: ACTION_TIMEOUT }),
      frame.locator("[data-autopilot-attach='1']").first().click({ timeout: ACTION_TIMEOUT }),
    ]);
    await chooser.setFiles(resumePath);
    return true;
  } catch {
    return false;
  }
}

/** Wait until some frame has what looks like an application form (an email field), up to ~15s. */
async function waitForForm(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  const sel = "input[type=email], input[name*=email i], input[id*=email i], input[autocomplete=email], input[type=file]";
  for (let i = 0; i < 30; i++) {
    for (const f of page.frames()) {
      if (await f.locator(sel).count().catch(() => 0)) return;
    }
    await page.waitForTimeout(500);
  }
}

async function captchaVisible(page: Page): Promise<boolean> {
  for (const f of page.frames()) {
    if (/recaptcha\/api2\/bframe|hcaptcha\.com\/.*challenge|challenges\.cloudflare\.com/.test(f.url())) {
      const el = await f.frameElement().catch(() => null);
      const box = el ? await el.boundingBox().catch(() => null) : null;
      if (box && box.width > 50 && box.height > 50) return true;
    }
  }
  return false;
}

/** Fill every frame that has form fields (some careers pages embed the ATS form in an iframe). */
export async function prefillPage(page: Page, values: PrefillValues, resumePath: string, onQuestions?: QuestionHandler): Promise<PrefillResult> {
  const result: PrefillResult = { filled: [], leftForYou: [], resumeUploaded: false, notices: [], asks: [] };
  await waitForForm(page);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

  let formFrame: Frame | null = null;
  for (const frame of page.frames()) {
    let controls: FormControl[];
    try {
      controls = await readFields(frame);
    } catch (err) {
      if (frame === page.mainFrame()) result.readError = (err as Error).message.split("\n")[0]!;
      continue; // a frame that went away mid-read, or a CAPTCHA widget
    }
    if (!controls.some((c) => c.kind !== "file")) continue;
    formFrame ??= frame;

    // Resume first: Lever and Ashby parse it and may fill some fields from it.
    const first = planFill(controls, values);
    const uploads = first.actions.filter((a) => a.op === "upload");
    if (uploads.length) await runPlan(frame, { actions: uploads, leftForYou: [] }, resumePath, result);
    if (!result.resumeUploaded && (await attachViaButton(page, frame, resumePath))) {
      result.resumeUploaded = true;
      result.filled.push({ label: "Resume", value: values.resumeFileName });
    }
    if (result.resumeUploaded) {
      await page.waitForTimeout(2000);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    }

    const rest = planFill((await readFields(frame)).filter((c) => c.kind !== "file"), values);
    await runPlan(frame, rest, resumePath, result);
    result.leftForYou.push(...first.leftForYou.filter((l) => /file|cover letter/i.test(l.reason)));

    // Questions nothing prepared covers: draft answers, or ask you.
    if (onQuestions && rest.unanswered.length) {
      const handled = new Set<string>();
      try {
        const out = await onQuestions(rest.unanswered);
        for (const a of out.answers) {
          const c = rest.unanswered.find((x) => x.id === a.controlId);
          if (c && (await fillControl(frame, c, a.value))) {
            result.filled.push({ label: c.label.replace(/[✱*]\s*$/, "").trim(), value: a.value });
            handled.add(c.id);
          }
        }
        for (const q of out.asks) {
          const c = rest.unanswered.find((x) => x.id === q.controlId);
          if (c && !handled.has(c.id)) {
            result.asks.push({ control: c, frame, question: q.question, draft: q.draft });
            handled.add(c.id);
          }
        }
      } catch (err) {
        result.notices.push(`Couldn't draft answers for the open questions (${(err as Error).message.split("\n")[0]}). They're listed below for you.`);
      }
      result.leftForYou = result.leftForYou.filter((l) => !l.controlId || !handled.has(l.controlId));
    }
  }

  if (!formFrame) result.notices.push("Couldn't find an application form on this page. If there's an Apply button, press it in the window, then press Open and prefill again.");
  else if (!result.resumeUploaded) {
    result.leftForYou.unshift({ label: "Resume", reason: `Not attached. Attach ${values.resumeFileName} yourself (download it from the copy panel)`, required: true });
  }
  if (await captchaVisible(page)) result.notices.push("The page is showing a CAPTCHA. Solve it in the window; the app won't touch it.");
  return result;
}

export type FormReading = {
  prepared: { label: string; value: string }[];
  leftForYou: LeftForYou[];
  asks: { control: FormControl; question: string; draft: string | null }[];
  notices: string[];
  readError?: string;
};

/**
 * Copy mode, for sites that block automated browsers: read the form's
 * questions (never fill or submit), and work out every answer so you can
 * paste them in your own browser, in the form's order.
 */
export async function readFormForCopy(page: Page, values: PrefillValues, onQuestions?: QuestionHandler): Promise<FormReading> {
  const out: FormReading = { prepared: [], leftForYou: [], asks: [], notices: [] };
  await waitForForm(page);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  let found = false;
  for (const frame of page.frames()) {
    let controls: FormControl[];
    try {
      controls = await readFields(frame);
    } catch (err) {
      if (frame === page.mainFrame()) out.readError = (err as Error).message.split("\n")[0]!;
      continue;
    }
    if (!controls.some((c) => c.kind !== "file")) continue;
    found = true;
    const plan = planFill(controls, values);
    const byControl = new Map<string, string>();
    for (const a of plan.actions) byControl.set(a.id, a.op === "upload" ? `Attach ${a.value}` : a.value);
    const handled = new Set<string>();
    if (onQuestions && plan.unanswered.length) {
      try {
        const r = await onQuestions(plan.unanswered);
        for (const a of r.answers) {
          byControl.set(a.controlId, a.value);
          handled.add(a.controlId);
        }
        for (const q of r.asks) {
          const c = plan.unanswered.find((x) => x.id === q.controlId);
          if (c && !handled.has(c.id)) {
            out.asks.push({ control: c, question: q.question, draft: q.draft });
            handled.add(c.id);
          }
        }
      } catch (err) {
        out.notices.push(`Couldn't draft answers for the open questions (${(err as Error).message.split("\n")[0]}).`);
      }
    }
    // In the form's order.
    for (const c of controls) {
      const v = byControl.get(c.id);
      if (v) out.prepared.push({ label: c.label.replace(/[✱*]\s*$/, "").replace(/\s+/g, " ").trim() || "(unlabeled field)", value: v });
    }
    out.leftForYou.push(...plan.leftForYou.filter((l) => !l.controlId || !handled.has(l.controlId)));
  }
  if (!found) out.notices.push("Couldn't read the form's questions. The copy panel below still has all your details and answers.");
  return out;
}
