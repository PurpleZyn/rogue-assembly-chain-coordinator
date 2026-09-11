// ==UserScript==
// @name         Rogue Assembly Chain Coordinator
// @namespace    rogueassembly.chain
// @version      0.1.0
// @description  Shared Rogue Assembly chain watcher and hit-request queue for Torn and Torn PDA.
// @author       Rogue Assembly
// @license      GPL-3.0-only
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_addStyle
// @connect      api.torn.com
// @connect      workers.dev
// @run-at       document-idle
// @noframes
// @downloadURL  https://raw.githubusercontent.com/PurpleZyn/rogue-assembly-chain-coordinator/main/userscript/rogue-assembly-chain.user.js
// @updateURL    https://raw.githubusercontent.com/PurpleZyn/rogue-assembly-chain-coordinator/main/userscript/rogue-assembly-chain.user.js
// ==/UserScript==

(() => {
  "use strict";

  const VERSION = "0.1.0";
  const BACKEND_URL = "https://YOUR-WORKER.workers.dev";
  const PDA_KEY = "###PDA-APIKEY###";
  const STORE = "ra-chain:";
  const CHAIN_URL = "https://api.torn.com/v2/faction/chain";
  const POLL = { normal: 8000, waiting: 6000, called: 2500, watcher: 4000, hidden: 20000, chain: 15000, heartbeat: 45000 };

  const state = {
    minimized: get("minimized", false),
    session: get("session", ""),
    expires: get("expires", 0),
    user: get("user", null),
    queue: null,
    chain: null,
    connected: false,
    busy: false,
    authBusy: false,
    lastQueue: 0,
    lastChain: 0,
    lastHeartbeat: 0,
    message: "",
    kind: "info",
    pollTimer: null,
    chainTimer: null,
  };

  let panel, chainEl, watchersEl, actionsEl, queueEl, msgEl, syncEl, settingsEl, dotEl;
  const glob = typeof globalThis !== "undefined" ? globalThis : window;

  function get(k, fallback) {
    try {
      const raw = typeof GM_getValue === "function" ? GM_getValue(STORE + k, undefined) : localStorage.getItem(STORE + k);
      if (raw === undefined || raw === null || raw === "") return fallback;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch { return fallback; }
  }

  function set(k, v) {
    try {
      const raw = JSON.stringify(v);
      if (typeof GM_setValue === "function") GM_setValue(STORE + k, raw);
      else localStorage.setItem(STORE + k, raw);
    } catch {}
  }

  function pdaKey() {
    const k = String(PDA_KEY || "").trim();
    return k && k !== "###PDA-APIKEY###" && /^[A-Za-z0-9]{16}$/.test(k) ? k : "";
  }

  function apiKey() { return pdaKey() || String(get("apiKey", "") || "").trim(); }
  function backendReady() { return /^https:\/\//.test(BACKEND_URL) && !/YOUR-WORKER/.test(BACKEND_URL); }
  function visible() { return document.visibilityState !== "hidden"; }
  function epoch() { return Math.floor(Date.now() / 1000); }

  function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

  function readResponse(res) {
    const text = res && typeof res.responseText === "string" ? res.responseText : "";
    return { status: Number(res?.status || 0), json: parseJson(text) };
  }

  function request(method, url, body, headers = {}) {
    const h = { Accept: "application/json", ...headers };
    const data = body === undefined ? undefined : JSON.stringify(body);
    if (data !== undefined) h["Content-Type"] = "application/json";

    const isPost = method === "POST";
    const pda = isPost
      ? (typeof glob.PDA_httpPost === "function" ? glob.PDA_httpPost : null)
      : (typeof glob.PDA_httpGet === "function" ? glob.PDA_httpGet : null);

    if (pda) {
      return new Promise((resolve) => {
        try {
          const p = isPost ? pda(url, h, data || "") : pda(url, h);
          if (!p || typeof p.then !== "function") return resolve({ status: 0, json: null });
          p.then((r) => resolve(readResponse(r)), () => resolve({ status: 0, json: null }));
        } catch { resolve({ status: 0, json: null }); }
      });
    }

    const gm = typeof GM_xmlhttpRequest === "function"
      ? GM_xmlhttpRequest
      : (typeof GM !== "undefined" && GM?.xmlHttpRequest ? GM.xmlHttpRequest.bind(GM) : null);

    if (gm) {
      return new Promise((resolve) => {
        const opts = {
          method, url, headers: h, timeout: 15000,
          onload: (r) => resolve(readResponse(r)),
          onerror: () => resolve({ status: 0, json: null }),
          ontimeout: () => resolve({ status: 0, json: null }),
        };
        if (data !== undefined) opts.data = data;
        const ret = gm(opts);
        if (ret && typeof ret.then === "function") ret.then((r) => resolve(readResponse(r)), () => resolve({ status: 0, json: null }));
      });
    }

    return fetch(url, { method, headers: h, body: data })
      .then(async (r) => ({ status: r.status, json: parseJson(await r.text()) }))
      .catch(() => ({ status: 0, json: null }));
  }

  async function backend(method, path, body) {
    const headers = state.session ? { Authorization: "Bearer " + state.session } : {};
    return request(method, BACKEND_URL + path, body, headers);
  }

  function clearSession() {
    state.session = "";
    state.expires = 0;
    state.user = null;
    set("session", "");
    set("expires", 0);
    set("user", null);
  }

  async function auth(force = false) {
    if (!force && state.session && state.expires > epoch() + 60) return true;
    if (state.authBusy) return false;

    const key = apiKey();
    if (!key) {
      message("Open ⚙ and save a Torn public API key. Torn PDA can supply its saved key automatically.", "warn");
      return false;
    }
    if (!backendReady()) {
      message("Backend not deployed yet. Finish the Cloudflare setup first.", "warn");
      return false;
    }

    state.authBusy = true;
    render();
    const r = await request("POST", BACKEND_URL + "/api/auth/login", { apiKey: key });
    state.authBusy = false;

    if (r.status === 200 && r.json?.ok && r.json.token) {
      state.session = r.json.token;
      state.expires = Number(r.json.expiresAt || 0);
      state.user = r.json.user || null;
      set("session", state.session);
      set("expires", state.expires);
      set("user", state.user);
      message("Signed in as " + (state.user?.name || "faction member") + ".", "good", 2200);
      return true;
    }

    clearSession();
    message(r.json?.message || errorText(r.json?.error) || "Could not authenticate.", "bad");
    return false;
  }

  async function syncQueue() {
    if (!visible()) return scheduleQueue(POLL.hidden);
    if (!(await auth())) return scheduleQueue(12000);
    if (state.busy) return scheduleQueue();

    state.busy = true;
    const r = await backend("GET", "/api/state");
    state.busy = false;

    if (r.status === 401) {
      clearSession();
      if (await auth(true)) return syncQueue();
    }

    if (r.status === 200 && r.json?.ok) {
      state.queue = r.json;
      state.connected = true;
      state.lastQueue = Date.now();
      if (r.json.isWatcher && Date.now() - state.lastHeartbeat > POLL.heartbeat) heartbeat();
    } else {
      state.connected = false;
      if (r.status) message(errorText(r.json?.error) || "Coordinator sync failed.", "bad");
    }

    render();
    scheduleQueue();
  }

  function scheduleQueue(delay) {
    clearTimeout(state.pollTimer);
    const me = mine();
    let ms = delay || POLL.normal;
    if (!visible()) ms = POLL.hidden;
    else if (me?.status === "called") ms = POLL.called;
    else if (state.queue?.isWatcher) ms = POLL.watcher;
    else if (me?.status === "waiting") ms = POLL.waiting;
    state.pollTimer = setTimeout(syncQueue, ms);
  }

  async function syncChain() {
    if (!visible()) return scheduleChain(POLL.hidden);
    const key = apiKey();
    if (!key) return scheduleChain();

    const r = await request("GET", CHAIN_URL, undefined, { Authorization: "ApiKey " + key });
    if (r.status === 200 && r.json?.chain) {
      state.chain = r.json.chain;
      state.lastChain = Date.now();
    }
    renderChain();
    scheduleChain();
  }

  function scheduleChain(ms = POLL.chain) {
    clearTimeout(state.chainTimer);
    state.chainTimer = setTimeout(syncChain, ms);
  }

  async function heartbeat() {
    if (!state.queue?.isWatcher || !state.session) return;
    state.lastHeartbeat = Date.now();
    await backend("POST", "/api/watcher/heartbeat", {});
  }

  async function mutate(path, body = {}) {
    if (state.busy || !(await auth())) return;
    state.busy = true;
    render();
    const r = await backend("POST", path, body);
    state.busy = false;

    if (r.status === 401) {
      clearSession();
      if (await auth(true)) return mutate(path, body);
    }

    if (r.status >= 200 && r.status < 300 && r.json?.ok !== false) {
      const success = {
        "/api/queue/join": "Your hit request is in the queue.",
        "/api/queue/cancel": "Your hit request was removed.",
        "/api/queue/done": "Hit marked complete.",
        "/api/queue/call-next": (r.json?.entry?.user_name || "Next member") + " is up.",
        "/api/queue/skip": (r.json?.entry?.user_name || "Current member") + " was skipped.",
        "/api/queue/reset": "The queue was reset.",
        "/api/watcher/claim": r.json?.slot === "backup" ? "You are now backup watcher." : "You are now watching the chain.",
        "/api/watcher/release": "Watcher duty released.",
      };
      message(success[path] || "Updated.", "good", 2200);
      return syncQueue();
    }

    if (r.json?.error === "already_called") message("Waiting for the current called member to finish.", "warn");
    else if (r.json?.error === "queue_empty") message("The request queue is empty.", "warn");
    else if (r.json?.error === "slot_taken") message((r.json?.watcher?.user_name || "Someone") + " already has that watcher slot.", "warn");
    else message(errorText(r.json?.error) || r.json?.message || "Action failed.", "bad");

    render();
  }

  function mine() {
    const uid = Number(state.user?.id || 0);
    return state.queue?.queue?.find((q) => Number(q.userId) === uid) || state.queue?.me || null;
  }

  function watcherSlot() {
    const uid = Number(state.user?.id || 0);
    for (const slot of ["primary", "backup"]) {
      if (Number(state.queue?.watchers?.[slot]?.userId || 0) === uid) return slot;
    }
    return null;
  }

  function build() {
    panel = document.createElement("section");
    panel.id = "ra-chain-coordinator";
    panel.innerHTML = `
      <div class="rac-head">
        <div class="rac-brand"><span class="rac-dot"></span><b>RA Chain</b><small>v${VERSION}</small></div>
        <div><button data-act="refresh">↻</button><button data-act="settings">⚙</button><button data-act="min">–</button></div>
      </div>
      <div class="rac-body">
        <div class="rac-chain"></div>
        <div class="rac-message" hidden></div>
        <div class="rac-watchers"></div>
        <div class="rac-actions"></div>
        <div class="rac-queue"></div>
        <div class="rac-sync"></div>
        <div class="rac-settings" hidden>
          <b>Settings</b>
          <div class="rac-note">Torn public API key</div>
          <div class="rac-input"><input type="password" maxlength="16" data-key placeholder="16-character key"><button data-act="save-key">Save</button></div>
          <div class="rac-note">Desktop: stored locally on this device. Torn PDA users can normally use PDA's saved API key automatically.</div>
          <div class="rac-note rac-backend"></div>
        </div>
      </div>`;

    document.body.appendChild(panel);
    chainEl = panel.querySelector(".rac-chain");
    watchersEl = panel.querySelector(".rac-watchers");
    actionsEl = panel.querySelector(".rac-actions");
    queueEl = panel.querySelector(".rac-queue");
    msgEl = panel.querySelector(".rac-message");
    syncEl = panel.querySelector(".rac-sync");
    settingsEl = panel.querySelector(".rac-settings");
    dotEl = panel.querySelector(".rac-dot");

    const input = panel.querySelector("[data-key]");
    if (pdaKey()) {
      input.disabled = true;
      input.placeholder = "Using Torn PDA saved key";
    } else input.value = apiKey();

    panel.querySelector(".rac-backend").textContent = backendReady()
      ? "Backend: " + new URL(BACKEND_URL).host
      : "Backend not configured yet.";

    panel.addEventListener("click", click);
    applyMin();
    render();
  }

  async function click(e) {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const a = b.dataset.act;

    if (a === "min") {
      state.minimized = !state.minimized;
      set("minimized", state.minimized);
      b.textContent = state.minimized ? "+" : "–";
      return applyMin();
    }
    if (a === "settings") {
      settingsEl.hidden = !settingsEl.hidden;
      return;
    }
    if (a === "refresh") {
      syncQueue();
      syncChain();
      return;
    }
    if (a === "save-key") {
      const key = String(panel.querySelector("[data-key]").value || "").trim();
      if (!/^[A-Za-z0-9]{16}$/.test(key)) return message("Enter a valid 16-character Torn API key.", "bad");
      set("apiKey", key);
      clearSession();
      message("Key saved locally. Verifying…", "info");
      if (await auth(true)) {
        settingsEl.hidden = true;
        syncQueue();
        syncChain();
      }
      return;
    }

    if (a === "join") return mutate("/api/queue/join");
    if (a === "cancel") return mutate("/api/queue/cancel");
    if (a === "done") return mutate("/api/queue/done");
    if (a === "call") return mutate("/api/queue/call-next");
    if (a === "skip") return mutate("/api/queue/skip");
    if (a === "primary") return mutate("/api/watcher/claim", { slot: "primary" });
    if (a === "backup") return mutate("/api/watcher/claim", { slot: "backup" });
    if (a === "release") return mutate("/api/watcher/release", { slot: watcherSlot() });
    if (a === "reset" && confirm("Reset the shared hit queue?")) return mutate("/api/queue/reset");
  }

  function render() {
    if (!panel) return;
    dotEl.className = "rac-dot " + (state.connected ? "online" : "offline");
    renderChain();
    renderMessage();
    renderWatchers();
    renderActions();
    renderQueue();
    renderSync();
  }

  function renderChain() {
    if (!chainEl) return;
    const c = state.chain;
    chainEl.innerHTML = c
      ? `<div class="card chain"><div><small>FACTION CHAIN</small><strong>${fmt(c.current)} <em>/ ${fmt(c.max)}</em></strong></div><div class="timer">${Number(c.timeout) > 0 ? time(c.timeout) : "—"}<small>timeout</small></div></div>`
      : `<div class="card"><small>FACTION CHAIN</small><div class="muted">Waiting for Torn API…</div></div>`;
  }

  function renderWatchers() {
    if (!state.queue) {
      watchersEl.innerHTML = '<div class="card"><small>CHAIN WATCHERS</small><div class="muted">Waiting for coordinator…</div></div>';
      return;
    }
    const p = state.queue.watchers?.primary;
    const b = state.queue.watchers?.backup;
    const slot = watcherSlot();

    watchersEl.innerHTML = `
      <div class="card">
        <div class="row"><small>CHAIN WATCHERS</small><span>Session ${state.queue.cycle}</span></div>
        <div class="watchers"><div><small>PRIMARY</small><b>${esc(p?.userName || "Open")}</b></div><div><small>BACKUP</small><b>${esc(b?.userName || "Open")}</b></div></div>
        <div class="buttons">
          ${slot ? '<button data-act="release">Release Watch</button>' : ""}
          ${!slot && !p ? '<button class="primary" data-act="primary">Take Watch</button>' : ""}
          ${!slot && !b ? '<button data-act="backup">Be Backup</button>' : ""}
        </div>
      </div>`;
  }

  function renderActions() {
    if (!state.user) {
      actionsEl.innerHTML = '<div class="card"><b>Sign in required</b><div class="muted">Open ⚙ to connect your Torn identity.</div></div>';
      return;
    }

    const me = mine();
    const called = state.queue?.queue?.find((q) => q.status === "called");

    if (me?.status === "called") {
      actionsEl.innerHTML = '<div class="card called"><b>YOU\'RE UP</b><div>Make your hit in Torn now.</div><div class="buttons"><button class="success" data-act="done">Hit Done</button><button data-act="cancel">Can\'t Hit</button></div></div>';
    } else if (me?.status === "waiting") {
      actionsEl.innerHTML = `<div class="card action"><div><b>You're in the queue</b><div class="muted">Position #${me.position || "?"}</div></div><button data-act="cancel">Cancel</button></div>`;
    } else {
      actionsEl.innerHTML = '<div class="card action"><div><b>Ready for a chain hit?</b><div class="muted">Add yourself to the queue.</div></div><button class="primary" data-act="join">Request Hit</button></div>';
    }

    if (state.queue?.isWatcher) {
      actionsEl.innerHTML += `
        <div class="card">
          <small>WATCHER CONTROLS</small>
          <div class="muted">${called ? "Waiting on " + esc(called.userName) : "Nobody is currently called."}</div>
          <div class="buttons">
            <button class="primary" data-act="call" ${called ? "disabled" : ""}>Call Next</button>
            <button data-act="skip" ${called ? "" : "disabled"}>Skip Current</button>
            <button class="danger" data-act="reset">Reset Queue</button>
          </div>
        </div>`;
    }
  }

  function renderQueue() {
    const entries = state.queue?.queue || [];
    const called = entries.find((q) => q.status === "called");
    const waiting = entries.filter((q) => q.status === "waiting");

    let html = `<div class="card"><div class="row"><small>HIT QUEUE</small><b>${waiting.length}${called ? " + 1 called" : ""}</b></div>`;
    if (called) html += `<div class="qrow now"><span>NOW</span><b>${esc(called.userName)}</b><i>${age(called.calledAt)}</i></div>`;
    if (!waiting.length) html += '<div class="empty">No one is waiting.</div>';
    for (const q of waiting) {
      const mineRow = Number(q.userId) === Number(state.user?.id || 0) ? " mine" : "";
      html += `<div class="qrow${mineRow}"><span>#${q.position}</span><b>${esc(q.userName)}</b><i>${age(q.requestedAt)}</i></div>`;
    }
    queueEl.innerHTML = html + "</div>";
  }

  function renderMessage() {
    if (!state.message) return msgEl.hidden = true;
    msgEl.hidden = false;
    msgEl.className = "rac-message " + state.kind;
    msgEl.textContent = state.message;
  }

  function renderSync() {
    const bits = [];
    if (state.user?.name) bits.push(esc(state.user.name));
    if (state.lastQueue) bits.push("queue " + ago(state.lastQueue) + "s ago");
    if (state.lastChain) bits.push("chain " + ago(state.lastChain) + "s ago");
    syncEl.innerHTML = bits.length ? bits.join(" · ") : "Not connected yet";
  }

  let msgTimer;
  function message(text, kind = "info", hide = 0) {
    state.message = String(text || "");
    state.kind = kind;
    clearTimeout(msgTimer);
    if (hide) msgTimer = setTimeout(() => { state.message = ""; renderMessage(); }, hide);
    if (msgEl) renderMessage();
  }

  function applyMin() {
    if (panel) panel.classList.toggle("min", state.minimized);
  }

  function styles() {
    const css = `
#ra-chain-coordinator{position:fixed;right:12px;bottom:12px;width:360px;max-height:86vh;z-index:2147483000;background:#17191e;color:#edf0f5;border:1px solid #343943;border-radius:12px;box-shadow:0 12px 36px #0008;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow:hidden}
#ra-chain-coordinator *{box-sizing:border-box}#ra-chain-coordinator button{font:inherit;border:1px solid #3b414d;background:#2a2f38;color:#eef1f5;border-radius:7px;padding:5px 9px;cursor:pointer}#ra-chain-coordinator button:disabled{opacity:.35;cursor:not-allowed}
.rac-head{height:42px;padding:0 9px 0 11px;background:#20232a;border-bottom:1px solid #343943;display:flex;align-items:center;justify-content:space-between}.rac-head button{width:29px;height:27px;padding:0;margin-left:4px}.rac-brand{display:flex;align-items:center;gap:7px}.rac-brand small{opacity:.4;font-size:9px}.rac-dot{width:8px;height:8px;border-radius:50%;background:#777}.rac-dot.online{background:#71d66b}.rac-dot.offline{background:#e17466}
.rac-body{padding:8px;overflow-y:auto;max-height:calc(86vh - 42px)}.min .rac-body{display:none}.min{width:160px!important}.card{background:#20232a;border:1px solid #303641;border-radius:9px;padding:9px;margin-bottom:7px}.card>small,.card small{font-size:9px;opacity:.5;letter-spacing:.5px}.muted{opacity:.58}.row{display:flex;align-items:center;justify-content:space-between;gap:8px}.row>span{opacity:.45;font-size:10px}.buttons{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.primary{background:#3c5f9d!important}.success{background:#356c45!important}.danger{margin-left:auto;color:#ef9b90!important}
.chain{display:flex;justify-content:space-between;align-items:center}.chain strong{display:block;font-size:20px}.chain em{font-size:11px;opacity:.45;font-style:normal}.timer{text-align:right;font-size:20px;font-weight:800}.timer small{display:block}.watchers{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:7px 0}.watchers>div{background:#17191e;border-radius:7px;padding:7px}.watchers b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.action{display:flex;align-items:center;justify-content:space-between;gap:8px}.called{border-color:#8b7040;background:#292518}.called>b{display:inline-block;background:#d6a93d;color:#17130b;padding:2px 7px;border-radius:999px;margin-bottom:5px}
.qrow{display:grid;grid-template-columns:36px 1fr auto;gap:7px;align-items:center;padding:6px 4px;border-top:1px solid #2e333c}.qrow span{text-align:right;opacity:.5}.qrow i{font-style:normal;opacity:.4}.qrow.now{background:#2c2719;border-radius:6px;border-top:0;margin:6px 0}.qrow.now span{color:#e8b945;font-weight:900;opacity:1}.qrow.mine{background:#222b38;border-radius:6px}.empty{text-align:center;padding:12px 3px 5px;opacity:.48}
.rac-message{padding:7px 9px;border-radius:8px;margin-bottom:7px;border:1px solid}.rac-message.info{background:#202a38;border-color:#33465d}.rac-message.good{background:#1e3124;border-color:#315a3a;color:#bde7c5}.rac-message.warn{background:#352f1c;border-color:#5c4f27;color:#f2d98b}.rac-message.bad{background:#38231f;border-color:#633a32;color:#efb0a6}.rac-sync{text-align:center;opacity:.35;font-size:9px;padding:1px 0 3px}
.rac-settings{border-top:1px solid #343943;padding-top:8px;margin-top:5px}.rac-note{opacity:.48;font-size:9.5px;margin-top:6px}.rac-input{display:flex;gap:5px;margin-top:5px}.rac-input input{flex:1;min-width:0;border:1px solid #3a414c;background:#111318;color:#eef1f5;border-radius:7px;padding:7px}
@media(max-width:520px){#ra-chain-coordinator{left:6px;right:6px;bottom:7px;width:auto;max-height:72vh}.rac-body{max-height:calc(72vh - 42px)}.min{left:auto;width:155px!important}}
`;
    if (typeof GM_addStyle === "function") GM_addStyle(css);
    else {
      const s = document.createElement("style");
      s.textContent = css;
      (document.head || document.documentElement).appendChild(s);
    }
  }

  function errorText(code) {
    return ({
      backend_not_configured: "Coordinator backend is not configured yet.",
      auth_required: "Please sign in again.",
      session_expired: "Your coordinator session expired.",
      wrong_faction: "This tool is restricted to Rogue Assembly.",
      watcher_required: "Take a watcher slot first.",
      not_queued: "You are not currently queued.",
      not_called: "You have not been called.",
      nothing_called: "Nobody is currently called.",
    })[code] || (code ? String(code).replace(/_/g, " ") : "");
  }

  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function time(sec) { sec = Math.max(0, Number(sec || 0)); return Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0"); }
  function age(ts) { const s = Math.max(0, epoch() - Number(ts || 0)); return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m" : Math.floor(s / 3600) + "h"; }
  function ago(ms) { return Math.max(0, Math.floor((Date.now() - ms) / 1000)); }
  function esc(v) { return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  function boot() {
    if (!document.body) return setTimeout(boot, 250);
    styles();
    build();
    auth();
    syncQueue();
    syncChain();
    document.addEventListener("visibilitychange", () => {
      if (visible()) { syncQueue(); syncChain(); }
      else { scheduleQueue(POLL.hidden); scheduleChain(POLL.hidden); }
    });
  }

  boot();
})();
