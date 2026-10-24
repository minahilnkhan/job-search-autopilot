import type { FormControl } from "./plan";

// Runs inside the page (sent there by Playwright, or bundled into the Chrome
// extension): tags every form field with data-autopilot-id and describes it.
// Self-contained on purpose: no imports used at runtime, no outside variables.

export function describeFields(): FormControl[] {
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

