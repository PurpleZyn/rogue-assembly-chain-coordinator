const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (request.method === "GET" && path === "/health") {
        return reply({ ok: true, service: "rogue-assembly-chain-api", version: "0.1.0" });
      }

      if (request.method === "POST" && path === "/api/auth/login") {
        return cors(await login(request, env));
      }

      const user = await requireUser(request, env);
      if (!user.ok) return cors(user.response);

      if (request.method === "GET" && path === "/api/state") {
        return cors(await getState(env, user.value));
      }

      if (request.method === "POST" && path === "/api/queue/join") {
        return cors(await joinQueue(env, user.value));
      }
      if (request.method === "POST" && path === "/api/queue/cancel") {
        return cors(await cancelQueue(env, user.value));
      }
      if (request.method === "POST" && path === "/api/queue/done") {
        return cors(await completeOwnCall(env, user.value));
      }
      if (request.method === "POST" && path === "/api/queue/call-next") {
        return cors(await callNext(env, user.value));
      }
      if (request.method === "POST" && path === "/api/queue/skip") {
        return cors(await skipCurrent(env, user.value));
      }
      if (request.method === "POST" && path === "/api/queue/reset") {
        return cors(await resetQueue(env, user.value));
      }

      if (request.method === "POST" && path === "/api/watcher/claim") {
        return cors(await claimWatcher(request, env, user.value));
      }
      if (request.method === "POST" && path === "/api/watcher/release") {
        return cors(await releaseWatcher(request, env, user.value));
      }
      if (request.method === "POST" && path === "/api/watcher/heartbeat") {
        return cors(await watcherHeartbeat(env, user.value));
      }

      return cors(reply({ ok: false, error: "not_found" }, 404));
    } catch (error) {
      return cors(reply({ ok: false, error: "server_error", message: safeMessage(error) }, 500));
    }
  },
};

async function login(request, env) {
  const body = await readBody(request);
  const apiKey = String(body.apiKey || "").trim();

  if (!/^[A-Za-z0-9]{16}$/.test(apiKey)) {
    return reply({ ok: false, error: "bad_key_format" }, 400);
  }

  const [basic, faction] = await Promise.all([
    tornGet("/user/basic", apiKey),
    tornGet("/user/faction", apiKey),
  ]);

  if (!basic.ok || !faction.ok) {
    const tornError = basic.error || faction.error || "Torn rejected the API key.";
    return reply({ ok: false, error: "torn_auth_failed", message: tornError }, 401);
  }

  const profile = basic.data?.profile;
  const membership = faction.data?.faction;
  const requiredFaction = Number(env.FACTION_ID || 0);

  if (!profile?.id || !membership?.id) {
    return reply({ ok: false, error: "not_in_faction", message: "Torn does not report this player in a faction." }, 403);
  }

  if (requiredFaction && Number(membership.id) !== requiredFaction) {
    return reply({
      ok: false,
      error: "wrong_faction",
      message: `This coordinator is restricted to ${env.FACTION_NAME || "the configured faction"}.`,
      faction: { id: membership.id, name: membership.name },
    }, 403);
  }

  const ttl = clampInt(env.SESSION_TTL_SECONDS, 3600, 604800, 86400);
  const now = epoch();
  const sessionUser = {
    uid: Number(profile.id),
    name: String(profile.name || profile.id),
    fid: Number(membership.id),
    position: String(membership.position || "Member"),
    iat: now,
    exp: now + ttl,
  };

  const token = await signSession(sessionUser, env.SESSION_SECRET);

  return reply({
    ok: true,
    token,
    expiresAt: sessionUser.exp,
    user: {
      id: sessionUser.uid,
      name: sessionUser.name,
      factionId: sessionUser.fid,
      factionName: membership.name,
      position: sessionUser.position,
    },
  });
}

async function getState(env, user) {
  const cycle = await currentCycle(env);
  const staleAfter = clampInt(env.WATCHER_STALE_SECONDS, 30, 900, 180);
  const cutoff = epoch() - staleAfter;

  const watcherRows = await env.DB.prepare(
    `SELECT slot, user_id, user_name, claimed_at, heartbeat_at
       FROM watchers
      WHERE heartbeat_at >= ?
      ORDER BY CASE slot WHEN 'primary' THEN 0 ELSE 1 END`
  ).bind(cutoff).all();

  const queueRows = await env.DB.prepare(
    `SELECT id, user_id, user_name, status, requested_at, called_at
       FROM queue_entries
      WHERE cycle = ? AND status IN ('waiting', 'called')
      ORDER BY CASE status WHEN 'called' THEN 0 ELSE 1 END, id ASC`
  ).bind(cycle).all();

  const queue = (queueRows.results || []).map((row) => ({
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    status: row.status,
    requestedAt: row.requested_at,
    calledAt: row.called_at,
  }));

  let waitingPosition = 0;
  for (const entry of queue) {
    if (entry.status === "waiting") entry.position = ++waitingPosition;
    else entry.position = 0;
  }

  const watchers = { primary: null, backup: null };
  for (const row of watcherRows.results || []) {
    watchers[row.slot] = {
      userId: row.user_id,
      userName: row.user_name,
      claimedAt: row.claimed_at,
      heartbeatAt: row.heartbeat_at,
    };
  }

  const me = queue.find((entry) => Number(entry.userId) === Number(user.uid)) || null;
  const isWatcher = Object.values(watchers).some((w) => w && Number(w.userId) === Number(user.uid));

  return reply({
    ok: true,
    serverTime: epoch(),
    cycle,
    watchers,
    queue,
    me,
    isWatcher,
  });
}

async function joinQueue(env, user) {
  const cycle = await currentCycle(env);
  const active = await env.DB.prepare(
    `SELECT id, status FROM queue_entries
      WHERE cycle = ? AND user_id = ? AND status IN ('waiting','called')
      LIMIT 1`
  ).bind(cycle, user.uid).first();

  if (active) {
    return reply({ ok: true, alreadyQueued: true, entry: active });
  }

  const now = epoch();
  const result = await env.DB.prepare(
    `INSERT INTO queue_entries (cycle, user_id, user_name, status, requested_at)
     VALUES (?, ?, ?, 'waiting', ?)
     RETURNING id, user_id, user_name, status, requested_at`
  ).bind(cycle, user.uid, user.name, now).first();

  await audit(env, user, "queue_join", { queueId: result?.id, cycle });
  return reply({ ok: true, entry: result });
}

async function cancelQueue(env, user) {
  const cycle = await currentCycle(env);
  const now = epoch();
  const result = await env.DB.prepare(
    `UPDATE queue_entries
        SET status = 'cancelled', resolved_at = ?
      WHERE cycle = ? AND user_id = ? AND status IN ('waiting','called')
      RETURNING id, status`
  ).bind(now, cycle, user.uid).first();

  if (!result) return reply({ ok: false, error: "not_queued" }, 409);
  await audit(env, user, "queue_cancel", { queueId: result.id, cycle });
  return reply({ ok: true });
}

async function completeOwnCall(env, user) {
  const cycle = await currentCycle(env);
  const now = epoch();
  const result = await env.DB.prepare(
    `UPDATE queue_entries
        SET status = 'done', resolved_at = ?
      WHERE cycle = ? AND user_id = ? AND status = 'called'
      RETURNING id`
  ).bind(now, cycle, user.uid).first();

  if (!result) return reply({ ok: false, error: "not_called" }, 409);
  await audit(env, user, "queue_done", { queueId: result.id, cycle });
  return reply({ ok: true });
}

async function callNext(env, user) {
  const auth = await requireWatcher(env, user);
  if (!auth.ok) return auth.response;

  const cycle = await currentCycle(env);
  const now = epoch();

  const called = await env.DB.prepare(
    `UPDATE queue_entries
        SET status = 'called', called_at = ?
      WHERE id = (
        SELECT id FROM queue_entries
         WHERE cycle = ? AND status = 'waiting'
           AND NOT EXISTS (
             SELECT 1 FROM queue_entries
              WHERE cycle = ? AND status = 'called'
           )
         ORDER BY id ASC
         LIMIT 1
      )
      RETURNING id, user_id, user_name, status, requested_at, called_at`
  ).bind(now, cycle, cycle).first();

  if (!called) {
    const existing = await env.DB.prepare(
      `SELECT id, user_id, user_name, called_at FROM queue_entries
        WHERE cycle = ? AND status = 'called' LIMIT 1`
    ).bind(cycle).first();
    if (existing) return reply({ ok: false, error: "already_called", current: existing }, 409);
    return reply({ ok: false, error: "queue_empty" }, 409);
  }

  await audit(env, user, "queue_call_next", { queueId: called.id, targetUserId: called.user_id, cycle });
  return reply({ ok: true, entry: called });
}

async function skipCurrent(env, user) {
  const auth = await requireWatcher(env, user);
  if (!auth.ok) return auth.response;

  const cycle = await currentCycle(env);
  const now = epoch();
  const skipped = await env.DB.prepare(
    `UPDATE queue_entries
        SET status = 'skipped', resolved_at = ?
      WHERE id = (
        SELECT id FROM queue_entries
         WHERE cycle = ? AND status = 'called'
         ORDER BY called_at ASC LIMIT 1
      )
      RETURNING id, user_id, user_name`
  ).bind(now, cycle).first();

  if (!skipped) return reply({ ok: false, error: "nothing_called" }, 409);
  await audit(env, user, "queue_skip", { queueId: skipped.id, targetUserId: skipped.user_id, cycle });
  return reply({ ok: true, entry: skipped });
}

async function resetQueue(env, user) {
  const auth = await requireWatcher(env, user);
  if (!auth.ok) return auth.response;

  const now = epoch();
  const result = await env.DB.prepare(
    `UPDATE app_state
        SET cycle = cycle + 1, updated_at = ?
      WHERE id = 1
      RETURNING cycle`
  ).bind(now).first();

  await audit(env, user, "queue_reset", { cycle: result?.cycle });
  return reply({ ok: true, cycle: result?.cycle });
}

async function claimWatcher(request, env, user) {
  const body = await readBody(request);
  const slot = body.slot === "backup" ? "backup" : "primary";
  const now = epoch();
  const staleAfter = clampInt(env.WATCHER_STALE_SECONDS, 30, 900, 180);
  const cutoff = now - staleAfter;

  await env.DB.prepare(`DELETE FROM watchers WHERE heartbeat_at < ?`).bind(cutoff).run();

  const occupied = await env.DB.prepare(
    `SELECT slot, user_id, user_name, heartbeat_at FROM watchers WHERE slot = ? LIMIT 1`
  ).bind(slot).first();

  if (occupied && Number(occupied.user_id) !== Number(user.uid)) {
    return reply({ ok: false, error: "slot_taken", watcher: occupied }, 409);
  }

  await env.DB.prepare(`DELETE FROM watchers WHERE user_id = ?`).bind(user.uid).run();
  await env.DB.prepare(
    `INSERT INTO watchers (slot, user_id, user_name, claimed_at, heartbeat_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(slot) DO UPDATE SET
       user_id = excluded.user_id,
       user_name = excluded.user_name,
       claimed_at = excluded.claimed_at,
       heartbeat_at = excluded.heartbeat_at`
  ).bind(slot, user.uid, user.name, now, now).run();

  await audit(env, user, "watcher_claim", { slot });
  return reply({ ok: true, slot });
}

async function releaseWatcher(request, env, user) {
  const body = await readBody(request);
  const slot = body.slot === "backup" ? "backup" : body.slot === "primary" ? "primary" : null;

  const result = slot
    ? await env.DB.prepare(`DELETE FROM watchers WHERE slot = ? AND user_id = ?`).bind(slot, user.uid).run()
    : await env.DB.prepare(`DELETE FROM watchers WHERE user_id = ?`).bind(user.uid).run();

  await audit(env, user, "watcher_release", { slot: slot || "any" });
  return reply({ ok: true, changed: Number(result.meta?.changes || 0) });
}

async function watcherHeartbeat(env, user) {
  const now = epoch();
  const result = await env.DB.prepare(
    `UPDATE watchers SET heartbeat_at = ? WHERE user_id = ?`
  ).bind(now, user.uid).run();

  return reply({ ok: true, watching: Number(result.meta?.changes || 0) > 0 });
}

async function requireWatcher(env, user) {
  const cutoff = epoch() - clampInt(env.WATCHER_STALE_SECONDS, 30, 900, 180);
  const row = await env.DB.prepare(
    `SELECT slot FROM watchers WHERE user_id = ? AND heartbeat_at >= ? LIMIT 1`
  ).bind(user.uid, cutoff).first();

  return row
    ? { ok: true, slot: row.slot }
    : { ok: false, response: reply({ ok: false, error: "watcher_required" }, 403) };
}

async function currentCycle(env) {
  const row = await env.DB.prepare(`SELECT cycle FROM app_state WHERE id = 1`).first();
  if (row?.cycle) return Number(row.cycle);

  const now = epoch();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO app_state (id, cycle, updated_at) VALUES (1, 1, ?)`
  ).bind(now).run();
  return 1;
}

async function audit(env, user, action, detail = {}) {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (created_at, user_id, user_name, action, detail_json)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(epoch(), user.uid, user.name, action, JSON.stringify(detail)).run();
  } catch {
    // Auditing must never break the queue itself.
  }
}

async function tornGet(path, apiKey) {
  try {
    const res = await fetch(`https://api.torn.com/v2${path}`, {
      headers: {
        Authorization: `ApiKey ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "RogueAssemblyChainCoordinator/0.1",
      },
    });
    const data = await res.json().catch(() => null);

    if (!res.ok || data?.error) {
      return {
        ok: false,
        status: res.status,
        error: data?.error?.error || data?.error?.message || `Torn API returned ${res.status}`,
      };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, status: 0, error: safeMessage(error) };
  }
}

async function requireUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return { ok: false, response: reply({ ok: false, error: "auth_required" }, 401) };

  try {
    const user = await verifySession(match[1], env.SESSION_SECRET);
    if (!user || user.exp <= epoch()) {
      return { ok: false, response: reply({ ok: false, error: "session_expired" }, 401) };
    }
    if (Number(env.FACTION_ID || 0) && Number(user.fid) !== Number(env.FACTION_ID)) {
      return { ok: false, response: reply({ ok: false, error: "wrong_faction" }, 403) };
    }
    return { ok: true, value: user };
  } catch {
    return { ok: false, response: reply({ ok: false, error: "bad_session" }, 401) };
  }
}

async function signSession(payload, secret) {
  if (!secret) throw new Error("SESSION_SECRET is not configured.");
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(body, secret, "sign");
  return `${body}.${base64UrlEncode(new Uint8Array(sig))}`;
}

async function verifySession(token, secret) {
  if (!secret) throw new Error("SESSION_SECRET is not configured.");
  const [body, signature, extra] = String(token || "").split(".");
  if (!body || !signature || extra !== undefined) return null;
  const valid = await hmac(body, secret, "verify", base64UrlDecode(signature));
  if (!valid) return null;
  const json = new TextDecoder().decode(base64UrlDecode(body));
  return JSON.parse(json);
}

async function hmac(message, secret, mode, signature) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const data = new TextEncoder().encode(message);
  return mode === "verify"
    ? crypto.subtle.verify("HMAC", key, signature, data)
    : crypto.subtle.sign("HMAC", key, data);
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function readBody(request) {
  try { return await request.json(); }
  catch { return {}; }
}

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function epoch() { return Math.floor(Date.now() / 1000); }
function safeMessage(error) { return error instanceof Error ? error.message : String(error || "Unknown error"); }
function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
