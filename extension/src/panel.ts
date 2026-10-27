// The side panel. Two tabs:
//   Fill: finds the approved application for this page, fills the form,
//         and lists what's left for you.
//   Chat: ask for changes ("shorten Why Anthropic to two sentences"); each
//         proposed edit is Truth-Checked by the app, and Apply puts it in the
//         application and the form. Questions the form left for you appear
//         here too.
import type { FrameResult, FillPayload } from "./fill";
import type { FormControl, LeftForYou } from "../../server/src/submit/plan";

type Cfg = { appUrl: string; code: string };
type Match = { best: number | null; applications: { id: number; jobTitle: string; companyName: string }[] };
type Ask = { id: string; label: string; question: string; draft: string | null; required: boolean; frameId: number; localId: string; answer?: string; filled?: boolean };
type Edit = { kind: "line" | "answer" | "note"; key: string; label: string; before: string; after: string };
type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; edits: Edit[]; blocked: { label: string; reason: string }[]; state?: "applied" | "discarded"; result?: string }
  | { role: "ask"; ask: Ask };
type Field = { frameId: number; id: string; label: string; kind: string };

const DEFAULT_URL = "http://127.0.0.1:3001";
const $app = document.getElementById("app")!;
const testTabId = Number(new URLSearchParams(location.search).get("tabId")) || null; // for automated tests

let cfg: Cfg = { appUrl: DEFAULT_URL, code: "" };
let tab: { id: number; url: string } | null = null;
let match: Match | null = null;
let selected: number | null = null;
let view: "fill" | "chat" = "fill";
let busy = false;
let status: { kind: "pass" | "warn" | "fail" | "soft"; text: string } | null = null;
let result: { filled: { label: string; value: string }[]; leftForYou: LeftForYou[]; resumeUploaded: boolean; notices: string[] } | null = null;
let fields: Field[] = [];
let messages: Msg[] = [];
let submitted = false;
let needsPermission = false;
let draft = "";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const clean = (s: string) => s.replace(/[✱*]\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
const NOTE_FIELD = /cover letter|additional information|anything else|message to (the )?(hiring|recruit)/i;

const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cfg.appUrl}/api/extension${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Autopilot-Token": cfg.code, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error("Can't reach the app. Is it running (npm run dev)?");
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data as { error?: string; issues?: { path: string; message: string }[] };
    // Say which field the app rejected, not just "Invalid input".
    const why = d.issues?.length ? ` (${d.issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join("; ")})` : "";
    throw new Error(`${d.error ?? `The app said ${res.status}`}${why}`);
  }
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
  fields = [];
  messages = [];
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

// ---- talking to the page ---------------------------------------------------

type Remote = { fill: (p: unknown) => Promise<FrameResult>; fillOne: (i: string, v: string) => Promise<boolean>; attachResume: (p: unknown) => Promise<boolean> };
// Functions sent to the page run there on their own: they can't use anything from this file.

async function inject(tabId: number, frameId: number) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["dist/fill.js"] });
}
async function run<T>(frameId: number, fn: (...args: never[]) => Promise<T>, args: unknown[]): Promise<T> {
  const [r] = await chrome.scripting.executeScript({ target: { tabId: tab!.id, frameIds: [frameId] }, func: fn as never, args: args as never[] });
  return r?.result as T;
}
const fillOne = (frameId: number, id: string, value: string) =>
  run<boolean>(frameId, ((i: string, v: string) => (window as unknown as { __autopilot: Remote }).__autopilot.fillOne(i, v)) as never, [id, value]).catch(() => false);

async function fill() {
  if (!tab || selected === null) return;
  busy = true;
  status = { kind: "soft", text: "Filling the form…" };
  render();
  try {
    const payload = await api<FillPayload>(`/applications/${selected}/payload`);
    const frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) ?? [{ frameId: 0 }];
    const agg = { filled: [] as { label: string; value: string }[], leftForYou: [] as LeftForYou[], resumeUploaded: false, notices: [] as string[] };
    const unanswered: (FormControl & { frameId: number })[] = [];
    fields = [];
    let anyForm = false;
    let mainBlocked = false;
    for (const f of frames) {
      try {
        await inject(tab.id, f.frameId);
        const r = await run<FrameResult>(f.frameId, ((p: unknown) => (window as unknown as { __autopilot: Remote }).__autopilot.fill(p)) as never, [payload]);
        if (!r?.hasForm) continue;
        anyForm = true;
        agg.filled.push(...r.filled);
        agg.leftForYou.push(...r.leftForYou);
        agg.resumeUploaded ||= r.resumeUploaded;
        unanswered.push(...r.unanswered.map((c) => ({ ...c, frameId: f.frameId })));
        fields.push(...r.fields.map((x) => ({ ...x, frameId: f.frameId })));
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
    if (!agg.resumeUploaded) agg.leftForYou.unshift({ label: "Resume", reason: `Not attached. Attach ${payload.resume.fileName} yourself (Review in the app has a download link)`, required: true });

    // Open questions: drafted answers go straight in; the rest become questions in Chat.
    if (unanswered.length) {
      status = { kind: "soft", text: `Filled ${agg.filled.length} fields. Drafting answers to ${unanswered.length} open question${unanswered.length === 1 ? "" : "s"}…` };
      render();
      const key = (c: { frameId: number; id: string }) => `${c.frameId}|${c.id}`;
      const out = await api<{ answers: { controlId: string; value: string }[]; asks: (Omit<Ask, "frameId" | "localId"> & { controlKey: string })[] }>(
        `/applications/${selected}/questions`,
        { url: tab.url, controls: unanswered.slice(0, 100).map(({ frameId, ...c }) => ({
          ...c,
          id: key({ frameId, id: c.id }),
          label: cut(c.label, 2000),
          hints: cut(c.hints, 2000),
          value: cut(c.value, 10000),
          options: c.options.slice(0, 300).map((o) => ({ text: cut(o.text, 500) })),
        })) }
      );
      const handled = new Set<string>();
      for (const a of out.answers) {
        const [frameId, localId] = a.controlId.split("|");
        if (await fillOne(Number(frameId), localId!, a.value)) {
          handled.add(a.controlId);
          agg.filled.push({ label: unanswered.find((c) => key(c) === a.controlId)?.label ?? "", value: a.value });
        }
      }
      for (const q of out.asks) {
        handled.add(q.controlKey);
        const [frameId, localId] = q.controlKey.split("|");
        messages.push({ role: "ask", ask: { ...q, frameId: Number(frameId), localId: localId! } });
      }
      const labels = new Set(unanswered.filter((c) => handled.has(key(c))).map((c) => c.label.replace(/[✱*]\s*$/, "").trim()));
      agg.leftForYou = agg.leftForYou.filter((l) => !labels.has(l.label));
    }
    result = agg;
    await api(`/applications/${selected}/report`, {
      filled: agg.filled.slice(0, 300).map((f) => ({ label: cut(f.label, 500), value: cut(f.value, 10000) })),
      leftForYou: agg.leftForYou.slice(0, 300).map((l) => ({ label: cut(l.label, 500), reason: cut(l.reason, 500), required: l.required })),
      resumeUploaded: agg.resumeUploaded,
      notices: agg.notices.slice(0, 20).map((n) => cut(n, 1000)),
    });
    const asks = messages.filter((m) => m.role === "ask").length;
    status = asks
      ? { kind: "warn", text: `Filled ${agg.filled.length} fields${agg.resumeUploaded ? " and attached your resume" : ""}. ${asks} question${asks === 1 ? "" : "s"} for you in Chat.` }
      : { kind: "pass", text: `Filled ${agg.filled.length} fields${agg.resumeUploaded ? " and attached your resume" : ""}. Check the form, then press Submit on the page.` };
  } catch (e) {
    status = { kind: "fail", text: (e as Error).message };
  } finally {
    busy = false;
    render();
  }
}

async function answerAsk(ask: Ask, value: string, remember: boolean) {
  const filled = await fillOne(ask.frameId, ask.localId, value);
  await api(`/applications/${selected}/answer`, { askId: ask.id, answer: value, remember, filled });
  ask.answer = value;
  ask.filled = filled;
  render();
}

// ---- chat --------------------------------------------------------------------

async function sendChat(text: string) {
  if (!text.trim() || selected === null) return;
  // A reply to an open form question goes to that question.
  const open = messages.find((m): m is Extract<Msg, { role: "ask" }> => m.role === "ask" && !m.ask.answer);
  messages.push({ role: "user", text });
  draft = "";
  busy = true;
  render();
  try {
    if (open && !/^(change|make|shorten|rewrite|add|remove|delete|update|edit|mention)\b/i.test(text.trim())) {
      await answerAsk(open.ask, text.trim(), false);
      return;
    }
    const history = messages
      .filter((m): m is Extract<Msg, { role: "user" | "assistant" }> => m.role === "user" || m.role === "assistant")
      .slice(0, -1)
      .map((m) => ({ role: m.role, text: m.text }));
    const formQuestions = fields.filter((f) => f.kind !== "file" && f.label).map((f) => f.label);
    const r = await api<{ reply: string; edits: Edit[]; blocked: { label: string; reason: string }[] }>(`/applications/${selected}/chat`, { message: text, history, formQuestions });
    messages.push({ role: "assistant", text: r.reply, edits: r.edits, blocked: r.blocked });
  } catch (e) {
    messages.push({ role: "assistant", text: (e as Error).message, edits: [], blocked: [] });
  } finally {
    busy = false;
    render();
  }
}

async function applyEdits(m: Extract<Msg, { role: "assistant" }>) {
  if (selected === null) return;
  busy = true;
  render();
  try {
    const r = await api<{ status: string; resumeChanged: boolean; message: string | null }>(`/applications/${selected}/chat/apply`, {
      edits: m.edits.map(({ kind, key, after }) => ({ kind, key, after })),
    });
    // Put the changes into the open form too.
    const notes: string[] = [];
    for (const e of m.edits) {
      const target =
        e.kind === "answer" ? fields.find((f) => clean(f.label) === clean(e.key)) : e.kind === "note" ? fields.find((f) => f.kind === "textarea" && NOTE_FIELD.test(f.label)) : undefined;
      if (target && !(await fillOne(target.frameId, target.id, e.after))) notes.push(`Couldn't type "${e.label}" into the form; paste it.`);
    }
    if (r.resumeChanged && r.status === "approved" && tab) {
      const payload = await api<FillPayload>(`/applications/${selected}/payload`);
      let attached = false;
      for (const f of fields.filter((x) => x.kind === "file")) {
        attached ||= await run<boolean>(f.frameId, ((p: unknown) => (window as unknown as { __autopilot: Remote }).__autopilot.attachResume(p)) as never, [payload]).catch(() => false);
      }
      notes.push(attached ? "Re-attached the updated resume." : "Attach the updated resume yourself (download it from Review in the app).");
    }
    m.state = "applied";
    m.result = [r.message ?? "Applied, and the application is still approved.", ...notes].join(" ");
  } catch (e) {
    m.result = (e as Error).message;
  } finally {
    busy = false;
    render();
  }
}

// ---- rendering -----------------------------------------------------------------

const app = () => match?.applications.find((a) => a.id === selected);

function header(): string {
  const a = app();
  const apps = match?.applications ?? [];
  return `<header class="head">
    <div class="brand">
      <span class="mark" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg></span>
      <div style="flex:1;min-width:0">
        <p class="title">${a ? esc(a.jobTitle) : "Autopilot"}</p>
        <p class="soft small" style="margin:0">${a ? `${esc(a.companyName)} · ${a.id === match?.best ? "matched to this page" : "picked by you"}` : "No approved application"}</p>
      </div>
    </div>
    ${apps.length > 1 && !match?.best ? `<select id="pick" aria-label="Application">${apps.map((x) => `<option value="${x.id}" ${x.id === selected ? "selected" : ""}>${esc(x.jobTitle)} · ${esc(x.companyName)}</option>`).join("")}</select>` : ""}
    <nav class="tabs" role="tablist">
      <button role="tab" id="tab-fill" aria-selected="${view === "fill"}">Fill</button>
      <button role="tab" id="tab-chat" aria-selected="${view === "chat"}">Chat${messages.some((m) => m.role === "ask" && !m.ask.answer) ? " •" : ""}</button>
    </nav>
  </header>`;
}

function fillView(): string {
  const parts: string[] = [];
  if (status) parts.push(`<p class="banner ${status.kind === "soft" ? "" : status.kind}">${esc(status.text)}</p>`);
  if (needsPermission) parts.push(`<div class="row"><button id="allow" class="primary">Allow on this site</button></div>`);
  if (!match?.applications.length) {
    parts.push(`<p class="soft">No approved applications. Approve one in the app, then open its job page here.</p>`);
    return parts.join("");
  }
  parts.push(`<div class="row"><button id="fill" class="primary" ${busy ? "disabled" : ""}>${result ? "Fill again" : "Fill this form"}</button><button id="refresh" ${busy ? "disabled" : ""}>Refresh</button></div>`);
  if (result) {
    const required = result.leftForYou.filter((l) => l.required);
    if (required.length) parts.push(`<h2>Fill these yourself</h2><ul>${required.map((l) => `<li><b>${esc(l.label)}</b> <span class="soft">· ${esc(l.reason)}</span></li>`).join("")}</ul>`);
    if (result.filled.length) parts.push(`<details><summary class="soft">What was filled (${result.filled.length})</summary><ul class="small">${result.filled.map((f) => `<li><span class="soft">${esc(f.label)}:</span> ${esc(f.value.length > 60 ? `${f.value.slice(0, 57)}…` : f.value)}</li>`).join("")}</ul></details>`);
  }
  return parts.join("");
}

function chatView(): string {
  const parts: string[] = [];
  if (!messages.length)
    parts.push(`<p class="soft">Ask for a change to your resume, recruiter note or answers, like "Shorten Why Anthropic to two sentences" or "Mention the Roblox HQ camp in the note". Every change is Truth-Checked before you see it, and nothing changes until you press Apply.</p>`);
  messages.forEach((m, i) => {
    if (m.role === "user") parts.push(`<div class="me">${esc(m.text)}</div>`);
    else if (m.role === "ask") {
      const a = m.ask;
      parts.push(`<div class="them"><small>The form asks · ${esc(a.label)}${a.required ? " · required" : ""}</small>${esc(a.question)}${a.draft ? `<br><span class="soft small">Draft: ${esc(a.draft)}</span>` : ""}</div>`);
      if (a.answer) parts.push(`<div class="me">${esc(a.answer)}</div><p class="soft small" style="text-align:right;margin:0">${a.filled ? "Typed into the form." : "Saved; paste it into the form."}</p>`);
      else parts.push(`<label class="check"><input type="checkbox" id="rem-${i}"> Use this answer on every application</label>`);
    } else {
      parts.push(`<div class="them">${esc(m.text)}</div>`);
      if (m.blocked.length) parts.push(`<div class="warnmsg">${m.blocked.map((b) => `Left out ${esc(b.label)}: ${esc(b.reason)}`).join("<br>")}</div>`);
      if (m.edits.length) {
        parts.push(`<div class="card diff">${m.edits
          .map((e) => `<p class="soft small" style="margin:0">${esc(e.label)}</p>${e.before ? `<p class="before">${esc(e.before)}</p>` : ""}<p class="after">${esc(e.after)}</p>`)
          .join("")}
          ${m.state ? `<p class="small ${m.state === "applied" ? "" : "soft"}" style="margin:4px 0 0">${esc(m.result ?? (m.state === "discarded" ? "Discarded." : ""))}</p>` : `<div class="row"><button class="primary small" data-apply="${i}" ${busy ? "disabled" : ""}>Apply</button><button class="small" data-discard="${i}">Discard</button></div>`}
        </div>`);
      }
    }
  });
  return parts.join("");
}

function render() {
  if (!cfg.code) return renderPairing();
  const pendingAsk = messages.some((m) => m.role === "ask" && !m.ask.answer);
  $app.innerHTML = `${header()}
    <section class="body" id="body">${view === "fill" ? fillView() : chatView()}</section>
    <footer class="foot">
      ${view === "chat" ? `<form class="composer" id="composer"><input id="msg" type="text" autocomplete="off" aria-label="Message" placeholder="${pendingAsk ? "Answer the question, or ask for a change" : "Ask for a change"}" value="${esc(draft)}" ${busy ? "disabled" : ""}><button class="primary send" aria-label="Send" ${busy ? "disabled" : ""}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></form>` : ""}
      ${submitted ? `<p class="banner pass">Marked submitted. It's on the Applications page in the app.</p>` : result ? `<button id="submitted">I submitted it</button>` : ""}
      <button class="link small" id="unpair" style="align-self:flex-start">Change pairing code</button>
    </footer>`;

  const body = document.getElementById("body")!;
  if (view === "chat") body.scrollTop = body.scrollHeight;
  document.getElementById("tab-fill")!.addEventListener("click", () => ((view = "fill"), render()));
  document.getElementById("tab-chat")!.addEventListener("click", () => ((view = "chat"), render()));
  document.getElementById("pick")?.addEventListener("change", (e) => ((selected = Number((e.target as HTMLSelectElement).value)), render()));
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
  const msg = document.getElementById("msg") as HTMLInputElement | null;
  msg?.addEventListener("input", () => (draft = msg.value));
  document.getElementById("composer")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const pending = messages.findIndex((m) => m.role === "ask" && !m.ask.answer);
    const remember = pending >= 0 && (document.getElementById(`rem-${pending}`) as HTMLInputElement | null)?.checked;
    if (pending >= 0 && remember && msg?.value.trim()) {
      const ask = (messages[pending] as Extract<Msg, { role: "ask" }>).ask;
      messages.push({ role: "user", text: msg.value.trim() });
      draft = "";
      void answerAsk(ask, msg.value.trim(), true);
      return;
    }
    void sendChat(msg?.value ?? "");
  });
  document.querySelectorAll<HTMLButtonElement>("[data-apply]").forEach((b) =>
    b.addEventListener("click", () => void applyEdits(messages[Number(b.dataset.apply)] as Extract<Msg, { role: "assistant" }>))
  );
  document.querySelectorAll<HTMLButtonElement>("[data-discard]").forEach((b) =>
    b.addEventListener("click", () => {
      (messages[Number(b.dataset.discard)] as Extract<Msg, { role: "assistant" }>).state = "discarded";
      render();
    })
  );
  document.getElementById("submitted")?.addEventListener("click", async () => {
    try {
      await api(`/applications/${selected}/submitted`, {});
      submitted = true;
    } catch (e) {
      status = { kind: "fail", text: (e as Error).message };
    }
    render();
  });
  document.getElementById("unpair")?.addEventListener("click", () => {
    cfg.code = "";
    render();
  });
}

function renderPairing() {
  $app.innerHTML = `<header class="head"><div class="brand"><span class="mark" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg></span><p class="title">Pair with your app</p></div></header>
    <section class="body">
      <p class="soft">In the app, open Settings → Chrome extension and copy the pairing code.</p>
      <label class="soft small" for="code">Pairing code</label><input id="code" type="password" autocomplete="off" />
      <details><summary class="soft small">App address</summary><input id="url" type="text" value="${esc(cfg.appUrl)}" /></details>
      <div class="row"><button id="save" class="primary">Pair</button></div>
      ${status ? `<p class="banner ${status.kind === "soft" ? "" : status.kind}">${esc(status.text)}</p>` : ""}
    </section>`;
  document.getElementById("save")!.addEventListener("click", async () => {
    const code = (document.getElementById("code") as HTMLInputElement).value.trim();
    const appUrl = ((document.getElementById("url") as HTMLInputElement).value.trim() || DEFAULT_URL).replace(/\/$/, "");
    cfg = { appUrl, code };
    try {
      await api("/ping");
      await chrome.storage.local.set({ cfg });
      status = null;
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
