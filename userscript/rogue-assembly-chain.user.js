// ==UserScript==
// @name         Rogue Assembly Chain Watcher
// @namespace    rogueassembly.chain
// @version      0.2.1
// @description  Local Rogue Assembly chain rotation. Scan visible faction chat for !hit / !cancel, cycle hitters, and prepare chat messages without sending them.
// @author       Rogue Assembly
// @license      GPL-3.0-only
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_addStyle
// @connect      api.torn.com
// @run-at       document-idle
// @noframes
// @downloadURL  https://raw.githubusercontent.com/PurpleZyn/rogue-assembly-chain-coordinator/main/userscript/rogue-assembly-chain.user.js
// @updateURL    https://raw.githubusercontent.com/PurpleZyn/rogue-assembly-chain-coordinator/main/userscript/rogue-assembly-chain.user.js
// ==/UserScript==

(() => {
  "use strict";

  const VERSION = "0.2.1";
  const STORE = "ra-chain:v2:";
  const PDA_KEY_PLACEHOLDER = "###PDA-APIKEY###";
  const CHAIN_URL = "https://api.torn.com/v2/faction/chain";
  const COMMAND_RE = /^\s*!(hit|cancel)\b/i;
  const glob = typeof globalThis !== "undefined" ? globalThis : window;

  const state = {
    minimized: load("minimized", false),
    position: load("position", null),
    rotation: cleanRotation(load("rotation", [])),
    called: load("called", false),
    processed: new Set(load("processed", [])),
    chain: null,
    chainError: "",
    chainTimer: null,
    message: "",
    kind: "info",
    scan: "Not scanned yet"
  };

  let panel, chainEl, currentEl, controlsEl, rotationEl, messageEl, settingsEl, scanEl;

  function load(key, fallback) {
    try {
      const raw = typeof GM_getValue === "function" ? GM_getValue(STORE + key, undefined) : localStorage.getItem(STORE + key);
      if (raw === undefined || raw === null || raw === "") return fallback;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch { return fallback; }
  }

  function save(key, value) {
    try {
      const raw = JSON.stringify(value);
      if (typeof GM_setValue === "function") GM_setValue(STORE + key, raw);
      else localStorage.setItem(STORE + key, raw);
    } catch {}
  }

  function persist() {
    save("rotation", state.rotation);
    save("called", state.called);
    const p = Array.from(state.processed);
    if (p.length > 500) state.processed = new Set(p.slice(-500));
    save("processed", Array.from(state.processed));
  }

  function cleanRotation(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set(), out = [];
    for (const m of value) {
      if (!m || typeof m !== "object") continue;
      const id = String(m.id || m.name || "").trim();
      const name = String(m.name || m.id || "").trim();
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name, joinedAt: Number(m.joinedAt || Date.now()) });
    }
    return out;
  }

  function pdaKey() {
    const k = String(PDA_KEY_PLACEHOLDER || "").trim();
    return k && k !== "###PDA-APIKEY###" && /^[A-Za-z0-9]{16}$/.test(k) ? k : "";
  }

  function apiKey() { return pdaKey() || String(load("apiKey", "") || "").trim(); }
  function normalize(v) { return String(v || "").replace(/\s+/g, " ").trim(); }
  function visible(el) {
    if (!(el instanceof Element)) return false;
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) !== 0 && r.width > 0 && r.height > 0;
  }

  function gmXhr() {
    if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest;
    if (typeof GM !== "undefined" && GM && typeof GM.xmlHttpRequest === "function") return GM.xmlHttpRequest.bind(GM);
    return null;
  }

  function readRes(res) {
    let json = null;
    try { json = JSON.parse(res?.responseText || ""); } catch {}
    return { status: Number(res?.status || 0), json };
  }

  function request(url, headers) {
    if (typeof glob.PDA_httpGet === "function") {
      return new Promise((resolve) => {
        try {
          const p = glob.PDA_httpGet(url, headers);
          p?.then ? p.then((r) => resolve(readRes(r)), () => resolve({ status: 0, json: null })) : resolve({ status: 0, json: null });
        } catch { resolve({ status: 0, json: null }); }
      });
    }
    const send = gmXhr();
    if (send) return new Promise((resolve) => {
      const done = (r) => resolve(readRes(r));
      const ret = send({ method: "GET", url, headers, timeout: 15000, onload: done, onerror: () => resolve({ status: 0, json: null }), ontimeout: () => resolve({ status: 0, json: null }) });
      if (ret?.then) ret.then(done, () => resolve({ status: 0, json: null }));
    });
    return fetch(url, { headers }).then(async (r) => {
      const text = await r.text(); let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: r.status, json };
    }).catch(() => ({ status: 0, json: null }));
  }

  async function syncChain() {
    if (document.visibilityState === "hidden") return scheduleChain(30000);
    const key = apiKey();
    if (!key) {
      state.chain = null;
      state.chainError = "Add a Torn public API key in ⚙ to show chain count/timer.";
      renderChain();
      return scheduleChain(30000);
    }
    const r = await request(CHAIN_URL, { Authorization: `ApiKey ${key}`, Accept: "application/json" });
    if (r.status === 200 && r.json?.chain) { state.chain = r.json.chain; state.chainError = ""; }
    else state.chainError = r.json?.error?.error || (r.status ? `Torn API ${r.status}` : "Torn API unavailable");
    renderChain();
    scheduleChain(15000);
  }

  function scheduleChain(ms) {
    clearTimeout(state.chainTimer);
    state.chainTimer = setTimeout(syncChain, ms);
  }

  function profileFrom(container) {
    if (!container) return null;
    for (const a of container.querySelectorAll('a[href*="XID="]')) {
      const href = a.getAttribute("href") || "";
      const match = /XID=(\d+)/i.exec(href);
      const name = normalize(a.textContent || a.title || a.getAttribute("aria-label"));
      if (match && name) return { id: match[1], name };
    }
    const x = container.querySelector('[data-user-id],[data-userid],[data-user-name],[data-username]');
    if (x) {
      const id = x.getAttribute("data-user-id") || x.getAttribute("data-userid") || "";
      const name = x.getAttribute("data-user-name") || x.getAttribute("data-username") || normalize(x.textContent);
      if (name) return { id: String(id || name), name };
    }
    return null;
  }

  function messageContainer(el) {
    let n = el;
    for (let i = 0; n && i < 9; i++, n = n.parentElement) if (profileFrom(n)) return n;
    return null;
  }

  function commandNodes() {
    return Array.from(document.querySelectorAll("div,span,p")).filter((el) => {
      if (!visible(el) || panel?.contains(el)) return false;
      const txt = normalize(el.textContent);
      if (!COMMAND_RE.test(txt)) return false;
      return !Array.from(el.children).some((c) => COMMAND_RE.test(normalize(c.textContent)));
    });
  }

  function hasMember(id, name) {
    const i = String(id || ""), n = String(name || "").toLowerCase();
    return state.rotation.some((m) => String(m.id) === i || String(m.name).toLowerCase() === n);
  }

  function addMember(member) {
    if (!member?.name || hasMember(member.id, member.name)) return false;
    state.rotation.push({ id: String(member.id || member.name), name: String(member.name), joinedAt: Date.now() });
    persist();
    return true;
  }

  function removeMember(id, name) {
    const i = String(id || ""), n = String(name || "").toLowerCase();
    const idx = state.rotation.findIndex((m) => String(m.id) === i || String(m.name).toLowerCase() === n);
    if (idx < 0) return false;
    if (idx === 0 && state.called) state.called = false;
    state.rotation.splice(idx, 1);
    if (!state.rotation.length) state.called = false;
    persist();
    return true;
  }

  function scanChat() {
    const nodes = commandNodes();
    let added = 0, removed = 0, unresolved = 0, old = 0;
    const events = [];
    for (const el of nodes) {
      const cmd = COMMAND_RE.exec(normalize(el.textContent))?.[1]?.toLowerCase();
      if (!cmd) continue;
      const box = messageContainer(el), who = profileFrom(box);
      if (!box || !who) { unresolved++; continue; }
      const sig = `${who.id}|${cmd}|${normalize(box.textContent).slice(0, 800)}`;
      if (state.processed.has(sig)) { old++; continue; }
      state.processed.add(sig);
      if (cmd === "hit") {
        if (addMember(who)) { added++; events.push(`${who.name} joined`); }
      } else if (removeMember(who.id, who.name)) {
        removed++; events.push(`${who.name} left`);
      }
    }
    persist();
    state.scan = `${nodes.length} visible command${nodes.length === 1 ? "" : "s"} · +${added} / -${removed}`;
    render();
    if (!nodes.length) setMessage("No visible !hit / !cancel messages found. Open faction chat so the commands are visible, then scan again.", "warn");
    else if (unresolved) setMessage(`I found commands, but ${unresolved} sender${unresolved === 1 ? " was" : "s were"} not recognizable. Send me a screenshot of the open faction chat and I can tune the selector.`, "warn");
    else if (events.length) setMessage(events.join(" · "), "good", 3200);
    else if (old) setMessage("No new rotation changes; those visible commands were already processed.", "info", 2200);
    else setMessage("Scan complete; rotation is already current.", "info", 2200);
  }

  function manualAdd() {
    const name = normalize(prompt("Enter the Torn name to add to the end of the rotation:") || "");
    if (!name) return;
    if (hasMember(name, name)) return setMessage(`${name} is already in the rotation.`, "warn", 2200);
    addMember({ id: `manual:${name.toLowerCase()}`, name });
    render();
    setMessage(`${name} added.`, "good", 2200);
  }

  function currentMessage(prefix = "") {
    if (!state.rotation.length) return setMessage("The rotation is empty.", "warn", 2000);
    state.called = true;
    persist();
    render();
    const cur = state.rotation[0], next = state.rotation[1];
    let text = prefix ? `${prefix} ` : "";
    text += `🔔 ${cur.name} — you're up!`;
    if (next) text += ` ${next.name} is on deck.`;
    fillChat(text);
  }

  function completeNext() {
    if (!state.rotation.length) return setMessage("The rotation is empty.", "warn", 2000);
    if (!state.called) return currentMessage();
    const done = state.rotation.shift();
    state.rotation.push(done);
    state.called = true;
    persist();
    render();
    const cur = state.rotation[0], next = state.rotation[1];
    let text = state.rotation.length === 1 ? `✅ ${done.name} complete. 🔔 ${cur.name} — you're up again!` : `✅ ${done.name} complete! 🔔 ${cur.name} — you're up!`;
    if (next) text += ` ${next.name} is on deck.`;
    fillChat(text);
  }

  function skipRotate() {
    if (!state.rotation.length) return setMessage("The rotation is empty.", "warn", 2000);
    const skipped = state.rotation.shift();
    state.rotation.push(skipped);
    state.called = true;
    persist();
    render();
    const cur = state.rotation[0], next = state.rotation[1];
    let text = `⏭️ ${skipped.name} skipped for now. 🔔 ${cur.name} — you're up!`;
    if (next) text += ` ${next.name} is on deck.`;
    fillChat(text);
  }

  function rotationMessage() {
    if (!state.rotation.length) return setMessage("The rotation is empty.", "warn", 2000);
    fillChat(`🔗 Current chain rotation: ${state.rotation.map((m, i) => `${i + 1}. ${m.name}`).join(" | ")}`);
  }

  function chatInput() {
    const list = Array.from(document.querySelectorAll('textarea,input[type="text"],[contenteditable="true"]')).filter((el) => visible(el) && !panel?.contains(el));
    let best = null, score = -1;
    for (const el of list) {
      let s = /message|chat|type/i.test(`${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`) ? 20 : 0;
      let n = el;
      for (let i = 0; n && i < 8; i++, n = n.parentElement) {
        const meta = `${n.id || ""} ${n.className || ""} ${n.getAttribute?.("title") || ""} ${n.getAttribute?.("aria-label") || ""}`;
        if (/chat/i.test(meta)) s += 10;
        if (/faction/i.test(meta)) s += 80;
        const text = normalize(n.textContent);
        if (text.length < 1500 && /\bfaction\b/i.test(text)) s += 25;
      }
      if (s > score) { score = s; best = el; }
    }
    return best;
  }

  function setInput(el, value) {
    if (el instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter ? setter.call(el, value) : (el.value = value);
    } else if (el instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter ? setter.call(el, value) : (el.value = value);
    } else {
      el.focus();
      try { document.execCommand("selectAll", false, null); document.execCommand("insertText", false, value); }
      catch { el.textContent = value; }
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.focus();
  }

  async function fillChat(text) {
    const input = chatInput();
    if (input) {
      setInput(input, text);
      return setMessage("Faction chat message prepared. Review it, then press Enter yourself to send.", "good", 3800);
    }
    try {
      await navigator.clipboard.writeText(text);
      setMessage("Couldn't identify the open faction-chat input, so I copied the message to your clipboard instead.", "warn");
    } catch {
      setMessage(`Couldn't find faction chat. Prepared message: ${text}`, "warn");
    }
  }

  function clearRotation() {
    if (!state.rotation.length || !confirm("Clear the entire local chain rotation?")) return;
    state.rotation = [];
    state.called = false;
    persist();
    render();
    setMessage("Rotation cleared.", "good", 2000);
  }

  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function fmtTime(s) { s = Math.max(0, Number(s || 0)); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`; }
  function esc(v) { return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  function render() {
    if (!panel) return;
    renderChain();
    renderCurrent();
    renderControls();
    renderRotation();
    renderMessage();
    scanEl.textContent = `${state.scan} · !hit joins/stays in rotation · !cancel leaves`;
  }

  function renderChain() {
    if (!chainEl) return;
    if (!state.chain) {
      chainEl.innerHTML = `<div class="card"><small>FACTION CHAIN</small><div class="muted">${esc(state.chainError || "Waiting for Torn API…")}</div></div>`;
      return;
    }
    const t = Number(state.chain.timeout || 0);
    chainEl.innerHTML = `<div class="card chain"><div><small>FACTION CHAIN</small><strong>${fmt(state.chain.current)} <em>/ ${fmt(state.chain.max)}</em></strong></div><div class="timer ${t && t <= 90 ? "dangerText" : t && t <= 180 ? "warnText" : ""}">${t ? fmtTime(t) : "—"}<small>timeout</small></div></div>`;
  }

  function renderCurrent() {
    if (!state.rotation.length) {
      currentEl.innerHTML = '<div class="card"><small>ROTATION</small><div class="empty">Nobody is in the rotation yet.</div></div>';
      return;
    }
    const a = state.rotation[0], b = state.rotation[1];
    currentEl.innerHTML = `<div class="card ${state.called ? "calledCard" : ""}"><div class="current"><div><small>${state.called ? "UP NOW" : "NEXT UP"}</small><b>${esc(a.name)}</b></div><div><small>ON DECK</small><b>${esc(b?.name || "—")}</b></div></div></div>`;
  }

  function renderControls() {
    controlsEl.innerHTML = `<div class="card"><div class="buttons"><button class="primary" data-act="scan">Scan Faction Chat</button><button data-act="add">+ Add Member</button></div><div class="buttons main"><button class="primary" data-act="call" ${!state.rotation.length ? "disabled" : ""}>${state.called ? "Re-fill Call" : "Call Next"}</button><button class="success" data-act="complete" ${!state.rotation.length ? "disabled" : ""}>Hit Complete + Next</button><button data-act="skip" ${!state.rotation.length ? "disabled" : ""}>Skip / Rotate</button></div><div class="buttons"><button data-act="rotation" ${!state.rotation.length ? "disabled" : ""}>Fill Rotation Message</button><button class="danger" data-act="clear" ${!state.rotation.length ? "disabled" : ""}>Clear Rotation</button></div></div>`;
  }

  function renderRotation() {
    if (!state.rotation.length) { rotationEl.innerHTML = ""; return; }
    let html = `<div class="card"><div class="row"><small>PERSISTENT ROTATION</small><b>${state.rotation.length}</b></div>`;
    state.rotation.forEach((m, i) => {
      const tag = i === 0 ? (state.called ? "UP" : "NEXT") : i === 1 ? "DECK" : `#${i + 1}`;
      html += `<div class="member ${i === 0 ? "first" : ""}"><span>${tag}</span><b>${esc(m.name)}</b><button data-act="remove" data-id="${esc(m.id)}">×</button></div>`;
    });
    rotationEl.innerHTML = html + "</div>";
  }

  function renderMessage() {
    if (!state.message) { messageEl.hidden = true; return; }
    messageEl.hidden = false;
    messageEl.className = `msg ${state.kind}`;
    messageEl.textContent = state.message;
  }

  let msgTimer;
  function setMessage(text, kind = "info", hide = 0) {
    state.message = String(text || "");
    state.kind = kind;
    clearTimeout(msgTimer);
    if (hide) msgTimer = setTimeout(() => { state.message = ""; renderMessage(); }, hide);
    if (messageEl) renderMessage();
  }

  function applySavedPosition() {
    if (!panel || !state.position || !Number.isFinite(state.position.left) || !Number.isFinite(state.position.top)) return;
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - Math.min(rect.width || 370, window.innerWidth));
    const maxTop = Math.max(0, window.innerHeight - Math.min(rect.height || 42, window.innerHeight));
    panel.style.left = `${Math.min(maxLeft, Math.max(0, state.position.left))}px`;
    panel.style.top = `${Math.min(maxTop, Math.max(0, state.position.top))}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function savePosition() {
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    state.position = { left: Math.round(r.left), top: Math.round(r.top) };
    save("position", state.position);
  }

  function resetPosition() {
    state.position = null;
    save("position", null);
    panel.style.left = "";
    panel.style.top = "";
    panel.style.right = "12px";
    panel.style.bottom = "12px";
    setMessage("Panel position reset.", "good", 1800);
  }

  function makeDraggable(handle) {
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

    const start = (e) => {
      if (e.target.closest("button,input")) return;
      const point = e.touches?.[0] || e;
      const r = panel.getBoundingClientRect();
      dragging = true;
      startX = point.clientX;
      startY = point.clientY;
      startLeft = r.left;
      startTop = r.top;
      panel.style.left = `${r.left}px`;
      panel.style.top = `${r.top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      document.body.classList.add("rac-dragging");
      if (e.cancelable) e.preventDefault();
    };

    const move = (e) => {
      if (!dragging) return;
      const point = e.touches?.[0] || e;
      const r = panel.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - r.width);
      const maxTop = Math.max(0, window.innerHeight - Math.min(r.height, window.innerHeight));
      const left = Math.min(maxLeft, Math.max(0, startLeft + point.clientX - startX));
      const top = Math.min(maxTop, Math.max(0, startTop + point.clientY - startY));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      if (e.cancelable) e.preventDefault();
    };

    const end = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("rac-dragging");
      savePosition();
    };

    handle.addEventListener("mousedown", start);
    handle.addEventListener("touchstart", start, { passive: false });
    window.addEventListener("mousemove", move);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("mouseup", end);
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
  }

  function build() {
    panel = document.createElement("section");
    panel.id = "ra-chain-watcher";
    panel.innerHTML = `<div class="head"><div><b>RA Chain Watcher</b><small>v${VERSION}</small></div><div><button data-act="settings" title="Settings">⚙</button><button data-act="min" title="Minimize">${state.minimized ? "+" : "–"}</button></div></div><div class="body"><div class="chainEl"></div><div class="msg" hidden></div><div class="currentEl"></div><div class="controlsEl"></div><div class="rotationEl"></div><div class="scanEl"></div><div class="settings" hidden><b>Settings</b><div class="note">Optional Torn public API key — only used for chain count/timer.</div><div class="input"><input type="password" maxlength="16" data-key placeholder="16-character API key"><button data-act="save">Save</button></div><div class="buttons settingsButtons"><button data-act="reset-pos">Reset Panel Position</button></div><div class="note">Drag the dark title bar to move this panel. Its position is remembered on this device.</div><div class="note">Only the chain watcher needs this script. Faction members just use !hit and !cancel in faction chat.</div></div></div>`;
    document.body.appendChild(panel);

    chainEl = panel.querySelector(".chainEl");
    currentEl = panel.querySelector(".currentEl");
    controlsEl = panel.querySelector(".controlsEl");
    rotationEl = panel.querySelector(".rotationEl");
    messageEl = panel.querySelector(".msg");
    settingsEl = panel.querySelector(".settings");
    scanEl = panel.querySelector(".scanEl");

    const input = panel.querySelector("[data-key]");
    if (pdaKey()) { input.disabled = true; input.placeholder = "Using Torn PDA saved key"; }
    else input.value = apiKey();

    panel.addEventListener("click", click);
    applyMin();
    applySavedPosition();
    makeDraggable(panel.querySelector(".head"));
    render();
  }

  async function click(e) {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const a = b.dataset.act;

    if (a === "min") {
      state.minimized = !state.minimized;
      save("minimized", state.minimized);
      b.textContent = state.minimized ? "+" : "–";
      applyMin();
      savePosition();
      return;
    }
    if (a === "settings") { settingsEl.hidden = !settingsEl.hidden; return; }
    if (a === "reset-pos") return resetPosition();
    if (a === "save") {
      const k = normalize(panel.querySelector("[data-key]").value);
      if (k && !/^[A-Za-z0-9]{16}$/.test(k)) return setMessage("Enter a valid 16-character key, or leave it blank.", "bad");
      save("apiKey", k);
      settingsEl.hidden = true;
      setMessage(k ? "API key saved locally." : "API key cleared.", "good", 2000);
      return syncChain();
    }
    if (a === "scan") return scanChat();
    if (a === "add") return manualAdd();
    if (a === "call") return currentMessage();
    if (a === "complete") return completeNext();
    if (a === "skip") return skipRotate();
    if (a === "rotation") return rotationMessage();
    if (a === "clear") return clearRotation();
    if (a === "remove") {
      const m = state.rotation.find((x) => String(x.id) === String(b.dataset.id));
      if (m) { removeMember(m.id, m.name); render(); setMessage(`${m.name} removed.`, "good", 1800); }
    }
  }

  function applyMin() {
    if (panel) panel.classList.toggle("minimized", state.minimized);
  }

  function styles() {
    const css = `#ra-chain-watcher{position:fixed;right:12px;bottom:12px;width:370px;max-height:86vh;z-index:2147483000;background:#17191e;color:#edf0f5;border:1px solid #343943;border-radius:12px;box-shadow:0 12px 36px #0008;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overflow:hidden}#ra-chain-watcher *{box-sizing:border-box}#ra-chain-watcher button{font:inherit;border:1px solid #3b414d;background:#2a2f38;color:#eef1f5;border-radius:7px;padding:5px 9px;cursor:pointer}#ra-chain-watcher button:disabled{opacity:.35;cursor:not-allowed}.head{height:42px;padding:0 9px 0 11px;background:#20232a;border-bottom:1px solid #343943;display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none;touch-action:none}.head>div{display:flex;align-items:center;gap:6px}.head small{opacity:.4;font-size:9px}.head button{width:29px;height:27px;padding:0;cursor:pointer}.rac-dragging,.rac-dragging *{user-select:none!important}.body{padding:8px;overflow-y:auto;max-height:calc(86vh - 42px)}.minimized .body{display:none}.minimized{width:176px!important}.card{background:#20232a;border:1px solid #303641;border-radius:9px;padding:9px;margin-bottom:7px}.card small{font-size:9px;opacity:.52;letter-spacing:.55px}.muted{opacity:.58}.empty{text-align:center;padding:10px 3px 3px;opacity:.48}.row{display:flex;align-items:center;justify-content:space-between}.chain{display:flex;align-items:center;justify-content:space-between}.chain strong{display:block;font-size:20px}.chain em{font-size:11px;opacity:.45;font-style:normal}.timer{text-align:right;font-size:20px;font-weight:800}.timer small{display:block}.warnText{color:#f0c45e}.dangerText{color:#ef7565}.current{display:grid;grid-template-columns:1fr 1fr;gap:7px}.current>div{background:#17191e;border-radius:7px;padding:7px}.current b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.calledCard{border-color:#8b7040;background:#292518}.buttons{display:flex;gap:5px;flex-wrap:wrap}.buttons+.buttons{margin-top:6px}.main button{flex:1 1 auto}.primary{background:#3c5f9d!important}.success{background:#356c45!important}.danger{margin-left:auto;color:#ef9b90!important}.member{display:grid;grid-template-columns:42px 1fr 28px;align-items:center;gap:7px;padding:6px 3px;border-top:1px solid #2e333c}.member span{font-size:9px;font-weight:800;opacity:.5;text-align:right}.member button{width:26px;height:24px;padding:0}.member.first{background:#222b38;border-radius:6px;border-top:0;margin-top:6px}.member.first span{color:#9ec1ff;opacity:1}.msg{padding:7px 9px;border-radius:8px;margin-bottom:7px;border:1px solid}.msg.info{background:#202a38;border-color:#33465d}.msg.good{background:#1e3124;border-color:#315a3a;color:#bde7c5}.msg.warn{background:#352f1c;border-color:#5c4f27;color:#f2d98b}.msg.bad{background:#38231f;border-color:#633a32;color:#efb0a6}.scanEl{text-align:center;opacity:.42;font-size:9px;padding:2px 4px 5px}.settings{border-top:1px solid #343943;padding-top:8px;margin-top:5px}.note{opacity:.48;font-size:9.5px;margin-top:6px}.input{display:flex;gap:5px;margin-top:5px}.input input{flex:1;min-width:0;border:1px solid #3a414c;background:#111318;color:#eef1f5;border-radius:7px;padding:7px}.settingsButtons{margin-top:7px}@media(max-width:520px){#ra-chain-watcher{width:min(370px,calc(100vw - 12px));max-height:72vh}.body{max-height:calc(72vh - 42px)}.minimized{width:170px!important}}`;
    if (typeof GM_addStyle === "function") GM_addStyle(css);
    else {
      const s = document.createElement("style");
      s.textContent = css;
      (document.head || document.documentElement).appendChild(s);
    }
  }

  function boot() {
    if (!document.body) return setTimeout(boot, 250);
    styles();
    build();
    syncChain();
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" ? scheduleChain(30000) : syncChain());
    window.addEventListener("resize", () => {
      if (!state.position) return;
      applySavedPosition();
      savePosition();
    });
  }

  boot();
})();
