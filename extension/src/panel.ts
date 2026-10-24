// The side panel: pairs with your local app, finds the approved application
// for the page you're on, fills the form, asks you what it can't answer, and
// records the submission when you press "I submitted it".
import type { FrameResult, FillPayload } from "./fill";
import type { FormControl, LeftForYou } from "../../server/src/submit/plan";

type Cfg = { appUrl: string; code: string };
type Match = { best: number | null; applications: { id: number; jobTitle: string; companyName: string }[] };
type Ask = { id: string; label: string; question: string; draft: string | null; required: boolean; frameId: number; localId: string; answer?: string; filled?: boolean };

const DEFAULT_URL = "http://127.0.0.1:3001";
const $app = document.getElementById("app")!;
const testTabId = Number(new URLSearchParams(location.search).get("tabId")) || null; // for automated tests

let cfg: Cfg = { appUrl: DEFAULT_URL, code: "" };
let tab: { id: number; url: string } | null = null;
let match: Match | null = null;
let selected: number | null = null;
let busy = false;
let status: { kind: "soft" | "pass" | "fail"; text: string } | null = null;
let result: { filled: { label: string; value: string }[]; leftForYou: LeftForYou[]; resumeUploaded: boolean; notices: string[] } | null = null;
let asks: Ask[] = [];
let submitted = false;
let needsPermission = false;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cfg.appUrl}/api/extension${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Autopilot-Token": cfg.code, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error("Can't reach the app. Is it running (npm run dev)?");
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `The app said ${res.status}`);
  return data as T;
}

async function loadTab() {
  if (testTabId) {
    const t = await chrome.tabs.get(testTabId);
    tab = { id: t.id!, url: t.url ?? "" };
  } else {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = t?.id ? { id: t.id, url: t.url ?? "" } : null;
  }
}

async function refresh() {
  if (busy) return;
  status = null;
  result = null;
  asks = [];
  submitted = false;
  await loadTab();
  if (!cfg.code) return render();
  try {
    match = await api<Match>("/match", { url: tab?.url ?? "" });
    selected = match.best ?? match.applications[0]?.id ?? null;
    needsPermission = false;
  } catch (e) {
    status = { kind: "fail", text: (e as Error).message };
  }
  render();
}

// ---- filling ---------------------------------------------------------------

async function inject(tabId: number, frameId: number) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["dist/fill.js"] });
}

async function runInFrame<T>(tabId: number, frameId: number, fn: (...args: never[]) => Promise<T>, args: unknown[]): Promise<T> {
  const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: fn as never, args: args as never[] });
  return r?.result as T;
}

async function fill() {
  if (!tab || selected === null) return;
  busy = true;
  status = { kind: "soft", text: "Filling the form…" };
  render();
  try {
    const payload = await api<FillPayload & { applicationId: number }>(`/applications/${selected}/payload`);
    const frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) ?? [{ frameId: 0 }];
    const agg = { filled: [] as { label: string; value: string }[], leftForYou: [] as LeftForYou[], resumeUploaded: false, notices: [] as string[] };
    const unanswered: (FormControl & { frameId: number })[] = [];
    let anyForm = false;
    let mainBlocked = false;
    for (const f of frames) {
      try {
        await inject(tab.id, f.frameId);
        const r = await runInFrame<FrameResult>(tab.id, f.frameId, (p: never) => (window as unknown as { __autopilot: { fill: (p: unknown) => Promise<FrameResult> } }).__autopilot.fill(p), [payload]);
        if (!r?.hasForm) continue;
        anyForm = true;
        agg.filled.push(...r.filled);
        agg.leftForYou.push(...r.leftForYou);
        agg.resumeUploaded ||= r.resumeUploaded;
        unanswered.push(...r.unanswered.map((c) => ({ ...c, frameId: f.frameId })));
      } catch {
        if (f.frameId === 0) mainBlocked = true; // no permission for this site yet
      }
    }
    if (!anyForm) {
      if (mainBlocked) {
        needsPermission = true;
        throw new Error("The extension needs your OK to work on this site.");
      }
      throw new Error("Couldn't find an application form on this page. If there's an Apply button, press it, then Fill again.");
    }
    if (!agg.resumeUploaded) agg.leftForYou.unshift({ label: "Resume", reason: `Not attached. Attach ${payload.resume.fileName} yourself (the app's Review page has a download link)`, required: true });

    // Open questions: drafted answers go straight in; the rest become questions for you.
    if (unanswered.length) {
      status = { kind: "soft", text: `Filled ${agg.filled.length} fields. Drafting answers to ${unanswered.length} open question${unanswered.length === 1 ? "" : "s"}…` };
      render();
      const key = (c: { frameId: number; id: string }) => `${c.frameId}|${c.id}`;
      const out = await api<{ answers: { controlId: string; value: string }[]; asks: (Omit<Ask, "frameId" | "localId"> & { controlKey: string })[] }>(
        `/applications/${selected}/questions`,
        { url: tab.url, controls: unanswered.map(({ frameId, ...c }) => ({ ...c, id: key({ frameId, id: c.id }), options: c.options.map((o) => ({ text: o.text })) })) }
      );
      const handled = new Set<string>();
      for (const a of out.answers) {
        const [frameId, localId] = a.controlId.split("|");
        const ok = await runInFrame<boolean>(tab.id, Number(frameId), (id: never, v: never) => (window as unknown as { __autopilot: { fillOne: (i: string, v: string) => Promise<boolean> } }).__autopilot.fillOne(id, v), [localId, a.value]);
        if (ok) {
          handled.add(a.controlId);
          agg.filled.push({ label: unanswered.find((c) => key(c) === a.controlId)?.label ?? "", value: a.value });
        }
      }
      asks = out.asks.map((q) => {
        handled.add(q.controlKey);
        const [frameId, localId] = q.controlKey.split("|");
        return { ...q, frameId: Number(frameId), localId: localId! };
      });
      const labels = new Set(unanswered.filter((c) => handled.has(key(c))).map((c) => c.label.replace(/[✱*]\s*$/, "").trim()));
      agg.leftForYou = agg.leftForYou.filter((l) => !labels.has(l.label));
    }
    result = agg;
    await api(`/applications/${selected}/report`, agg);
    status = { kind: "pass", text: "Done. Check the form, answer any questions below, then press Submit on the page." };
  } catch (e) {
    status = { kind: "fail", text: (e as Error).message };
  } finally {
    busy = false;
    render();
  }
}

async function sendAnswer(ask: Ask, value: string, remember: boolean) {
  if (!tab || selected === null) return;
  const filled = await runInFrame<boolean>(tab.id, ask.frameId, (id: never, v: never) => (window as unknown as { __autopilot: { fillOne: (i: string, v: string) => Promise<boolean> } }).__autopilot.fillOne(id, v), [ask.localId, value]).catch(() => false);
  await api(`/applications/${selected}/answer`, { askId: ask.id, answer: value, remember, filled });
  ask.answer = value;
  ask.filled = filled;
  render();
}

// ---- rendering -------------------------------------------------------------

function render() {
  if (!cfg.code) return renderPairing();
  const apps = match?.applications ?? [];
  const parts: string[] = [];
  if (status) parts.push(`<p class="${status.kind}">${esc(status.text)}</p>`);
  if (needsPermission) parts.push(`<div class="row"><button id="allow" class="primary">Allow on this site</button></div>`);
  if (!apps.length) {
    parts.push(`<p class="soft">No approved applications. Approve one in Review in the app, then open its job page here.</p>`);
  } else {
    parts.push(`<div class="card"><label class="soft" for="pick">Application</label>
      <select id="pick">${apps.map((a) => `<option value="${a.id}" ${a.id === selected ? "selected" : ""}>${esc(a.jobTitle)} · ${esc(a.companyName)}${a.id === match?.best ? " (this page)" : ""}</option>`).join("")}</select>
      ${match?.best ? "" : `<p class="soft">Couldn't tell which application this page is for; pick it above.</p>`}
      <div class="row"><button id="fill" class="primary" ${busy ? "disabled" : ""}>${result ? "Fill again" : "Fill this form"}</button>
      <button id="refresh" ${busy ? "disabled" : ""}>Refresh</button></div></div>`);
  }
  if (result) {
    const required = result.leftForYou.filter((l) => l.required);
    parts.push(`<div class="card"><p class="${result.resumeUploaded ? "pass" : "fail"}">Filled ${result.filled.length} fields${result.resumeUploaded ? ", resume attached" : ""}.</p>
      ${required.length ? `<h2>Fill these yourself</h2><ul>${required.map((l) => `<li><b>${esc(l.label)}</b> <span class="soft">· ${esc(l.reason)}</span></li>`).join("")}</ul>` : ""}</div>`);
  }
  if (asks.length) {
    parts.push(`<h2>Questions for you</h2>`);
    asks.forEach((a, i) => {
      parts.push(`<div class="bubble"><small>${esc(a.label)}${a.required ? " · required" : ""}</small>${esc(a.question)}</div>`);
      if (a.answer) parts.push(`<div class="mine">${esc(a.answer)}</div><p class="soft" style="text-align:right">${a.filled ? "Typed into the form." : "Saved; paste it into the form."}</p>`);
      else
        parts.push(`<textarea id="ans-${i}" rows="${a.draft ? 4 : 2}" placeholder="Type your answer">${esc(a.draft ?? "")}</textarea>
          <div class="row"><label class="check"><input type="checkbox" id="rem-${i}" /> Use on every application</label><button class="primary" data-send="${i}">Send</button></div>`);
    });
  }
  if (result && !submitted) parts.push(`<div class="row"><button id="submitted">I submitted it</button></div><p class="soft">Press this after you submit, so the app tracks it.</p>`);
  if (submitted) parts.push(`<p class="pass">Marked submitted. It's on the Tracker in the app.</p>`);
  parts.push(`<p class="soft" style="margin-top:18px"><a href="#" id="unpair">Change pairing code</a></p>`);
  $app.innerHTML = parts.join("");

  document.getElementById("pick")?.addEventListener("change", (e) => (selected = Number((e.target as HTMLSelectElement).value)));
  document.getElementById("fill")?.addEventListener("click", () => void fill());
  document.getElementById("refresh")?.addEventListener("click", () => void refresh());
  document.getElementById("allow")?.addEventListener("click", () => {
    // Must be the first thing in the click, so Chrome sees your click.
    const origin = tab ? `${new URL(tab.url).origin}/*` : "";
    chrome.permissions.request({ origins: [origin] }, (ok) => {
      needsPermission = !ok;
      status = ok ? { kind: "soft", text: "Allowed. Press Fill this form." } : { kind: "fail", text: "Not allowed, so the extension can't fill this site." };
      render();
    });
  });
  document.getElementById("submitted")?.addEventListener("click", async () => {
    try {
      await api(`/applications/${selected}/submitted`, {});
      submitted = true;
    } catch (e) {
      status = { kind: "fail", text: (e as Error).message };
    }
    render();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-send]").forEach((b) =>
    b.addEventListener("click", async () => {
      const i = Number(b.dataset.send);
      const v = (document.getElementById(`ans-${i}`) as HTMLTextAreaElement).value.trim();
      if (!v) return;
      b.disabled = true;
      try {
        await sendAnswer(asks[i]!, v, (document.getElementById(`rem-${i}`) as HTMLInputElement).checked);
      } catch (e) {
        status = { kind: "fail", text: (e as Error).message };
        render();
      }
    })
  );
  document.getElementById("unpair")?.addEventListener("click", (e) => {
    e.preventDefault();
    cfg.code = "";
    render();
  });
}

function renderPairing() {
  $app.innerHTML = `<div class="card"><h2>Pair with your app</h2>
    <p class="soft">In the app, open Settings → Chrome extension and copy the pairing code.</p>
    <label class="soft" for="code">Pairing code</label><input id="code" type="password" autocomplete="off" />
    <details><summary class="soft">App address</summary><input id="url" type="text" value="${esc(cfg.appUrl)}" /></details>
    <div class="row"><button id="save" class="primary">Pair</button></div>
    ${status ? `<p class="${status.kind}">${esc(status.text)}</p>` : ""}</div>`;
  document.getElementById("save")!.addEventListener("click", async () => {
    const code = (document.getElementById("code") as HTMLInputElement).value.trim();
    const appUrl = ((document.getElementById("url") as HTMLInputElement).value.trim() || DEFAULT_URL).replace(/\/$/, "");
    cfg = { appUrl, code };
    try {
      await api("/ping");
      await chrome.storage.local.set({ cfg });
      status = { kind: "pass", text: "Paired." };
      await refresh();
    } catch (e) {
      cfg.code = "";
      status = { kind: "fail", text: (e as Error).message };
      renderPairing();
    }
  });
}

chrome.tabs.onActivated.addListener(() => void refresh());
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === tab?.id && info.status === "complete" && !result) void refresh();
});

void (async () => {
  const stored = (await chrome.storage.local.get("cfg")) as { cfg?: Cfg };
  if (stored.cfg) cfg = stored.cfg;
  await refresh();
})();
