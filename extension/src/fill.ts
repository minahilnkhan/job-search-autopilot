// Injected into the job's page (every frame) when you press Fill in the side
// panel. Reads the form, fills what the plan says, and stops. It never clicks
// Submit and never touches a CAPTCHA. Same matching rules as the app's own
// prefill (server/src/submit/plan.ts), so both behave the same.
import { describeFields } from "../../server/src/submit/describe";
import { planAnswer, planFill, type FillAction, type FormControl, type LeftForYou, type PrefillValues } from "../../server/src/submit/plan";

export type FillPayload = { values: PrefillValues; resume: { fileName: string; base64: string } };
export type FrameResult = {
  hasForm: boolean;
  filled: { label: string; value: string }[];
  leftForYou: LeftForYou[];
  resumeUploaded: boolean;
  unanswered: FormControl[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const byId = (id: string) => document.querySelector(`[data-autopilot-id="${id}"]`) as HTMLElement | null;

/** Set a value the way a person typing would, so React and friends notice. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function resumeFile(p: FillPayload): File {
  const bytes = Uint8Array.from(atob(p.resume.base64), (c) => c.charCodeAt(0));
  return new File([bytes], p.resume.fileName, { type: "application/pdf" });
}

async function act(a: FillAction, file: File | null): Promise<boolean> {
  const el = byId(a.id);
  if (!el) return false;
  try {
    switch (a.op) {
      case "fill": {
        const input = el as HTMLInputElement;
        input.focus();
        setValue(input, a.value);
        input.dispatchEvent(new Event("blur", { bubbles: true }));
        return input.value === a.value;
      }
      case "select": {
        const s = el as HTMLSelectElement;
        const o = Array.from(s.options).find((x) => x.text.trim() === a.value);
        if (!o) return false;
        s.value = o.value;
        s.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      case "check":
        (el as HTMLInputElement).click();
        return (el as HTMLInputElement).checked;
      case "upload": {
        if (!file) return false;
        const dt = new DataTransfer();
        dt.items.add(file);
        (el as HTMLInputElement).files = dt.files;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return ((el as HTMLInputElement).files?.length ?? 0) > 0;
      }
      case "combobox": {
        // react-select style: type to filter, then pick the matching option.
        const input = el as HTMLInputElement;
        input.focus();
        input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        setValue(input, a.value);
        const want = a.value.toLowerCase();
        for (let i = 0; i < 20; i++) {
          await sleep(100);
          const visible = Array.from(document.querySelectorAll<HTMLElement>("[role=option]")).filter((o) => o.offsetParent !== null);
          const full = a.match?.toLowerCase();
          const option = (full && visible.find((o) => o.innerText.trim().toLowerCase().startsWith(full))) || visible.find((o) => o.innerText.toLowerCase().includes(want));
          if (option) {
            option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            option.click();
            return true;
          }
        }
        return false;
      }
    }
  } catch {
    return false;
  }
}

const cleanLabel = (s: string) => s.replace(/[✱*]\s*$/, "").replace(/\s+/g, " ").trim();

async function fill(p: FillPayload): Promise<FrameResult> {
  const result: FrameResult = { hasForm: false, filled: [], leftForYou: [], resumeUploaded: false, unanswered: [] };
  const controls = describeFields();
  if (!controls.some((c) => c.kind !== "file")) return result;
  result.hasForm = true;
  const file = resumeFile(p);

  // Resume first: some forms fill fields from it.
  const first = planFill(controls, p.values);
  for (const a of first.actions.filter((x) => x.op === "upload")) {
    if (await act(a, file)) {
      result.resumeUploaded = true;
      result.filled.push({ label: a.label, value: a.value });
    }
  }
  if (result.resumeUploaded) await sleep(1500);

  const rest = planFill(describeFields().filter((c) => c.kind !== "file"), p.values);
  for (const a of rest.actions) {
    if (await act(a, null)) result.filled.push({ label: a.label, value: a.value });
    else result.leftForYou.push({ label: a.label, reason: `Couldn't fill it automatically. Value: ${a.value}`, required: true });
  }
  result.leftForYou.push(...rest.leftForYou, ...first.leftForYou.filter((l) => /file|cover letter/i.test(l.reason)));
  result.unanswered = rest.unanswered.map((c) => ({ ...c, label: cleanLabel(c.label) }));
  return result;
}

/** Put one value (a drafted answer, or your reply) into one field. */
async function fillOne(id: string, value: string): Promise<boolean> {
  const c = describeFields().find((x) => x.id === id);
  if (!c) return false;
  const a = planAnswer(c, value);
  return a ? act(a, null) : false;
}

(window as unknown as { __autopilot: unknown }).__autopilot = { fill, fillOne };
