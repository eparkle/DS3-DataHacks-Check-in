// Offline support for the check-in desk: network state, timed Supabase calls,
// the per-organizer roster cache, and the queue of check-ins / undos that
// couldn't reach the server.
//
// Rules the rest of the app relies on:
//   - Only "couldn't reach the server" (offline, fetch threw, ~6 s timeout:
//     no HTTP answer at all) is treated as transient and may be queued. Any
//     HTTP answer is real: a 401/403 (sign-in gone), a 5xx (server error) or
//     a refusal ("unknown", "dupe", a 4xx) is never queued as "will sync";
//     the desk shows a red card instead (see errors.js).
//   - A saved item that gets a server error is retried a few times, then
//     flagged for attention; one that gets a 401/403 is flagged at once (with
//     everything else waiting), and tried again after the next sign-in.
//   - The queue holds at most one waiting op per code (a check-in, or an undo
//     of a server check-in); an undo of a queued check-in just removes it.
//   - Items are sent one at a time, in order, each with its own client id
//     (the item id) and the time it was scanned. The database remembers the
//     client id, so a retry of a request that did land (we never saw the
//     answer) comes back as the original "ok", not "already checked in"; and
//     the check-in keeps the scan time, not the sync time.
//   - A database without those parameters yet (the site's migration isn't on
//     it) answers PGRST202; the call is repeated the old way and remembered
//     for the session, so the app works before and after the migration.

import { supabase } from "./supabase.js";
import { kvGet, kvSet, kvDelete, kvDeletePrefix } from "./offline-store.js";
import { classifyResponse, classifySession, isMissingApi, queueStep, attentionText } from "./errors.js";

export { isMissingApi, attentionText };

export const RPC_TIMEOUT_MS = 6000;
const FLUSH_BASE_MS = 15000;
const FLUSH_MAX_MS = 60000;

// ---------- Network state ----------
// navigator.onLine only knows about the Wi-Fi link; venue Wi-Fi is often
// "connected" with no internet. `reachable` drops on a network failure and
// comes back on the next answer from Supabase (or the browser's online event).
const net = { reachable: true };
const netListeners = new Set();

export function isOffline() {
  return (typeof navigator !== "undefined" && navigator.onLine === false) || !net.reachable;
}

export function onNetChange(fn) {
  netListeners.add(fn);
  return () => netListeners.delete(fn);
}

function emitNet(reason) {
  netListeners.forEach((fn) => {
    try {
      fn(reason);
    } catch (err) {
      console.error(err);
    }
  });
}

export function markReachable(value) {
  if (net.reachable === value) return;
  net.reachable = value;
  emitNet(value ? "reconnected" : "unreachable");
}

window.addEventListener("online", () => {
  net.reachable = true;
  emitNet("online");
});
window.addEventListener("offline", () => emitNet("offline"));

// ---------- Timed Supabase calls ----------

function timeoutAfter(ms) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

// The sign-in is gone (401 / 403 / expired JWT): ask supabase-js to refresh
// once; if the refresh token is gone too it signs out and the app shows the
// sign-in screen. Throttled so a burst of scans doesn't hammer auth.
let lastRefreshAt = 0;
function refreshSessionSoon() {
  const now = Date.now();
  if (now - lastRefreshAt < 15000) return;
  lastRefreshAt = now;
  supabase.auth.refreshSession().catch(() => {});
}

// { kind: "ok", data } | { kind: "transient", reason, maybeSent, message } |
// { kind: "error", category: "auth" | "server" | "rejected", status, code, message, ... }
function classify(res, { sent }) {
  const result = classifyResponse(res, { sent });
  // No HTTP answer: the network is down (or Supabase is unreachable).
  // Any HTTP answer, even an error, means it's reachable.
  markReachable(result.kind !== "transient");
  if (result.kind === "error" && result.category === "auth") refreshSessionSoon();
  return result;
}

// Functions the database only has in their old form (per session).
const legacyRpc = new Set();
export const isLegacyRpc = (name) => legacyRpc.has(name);

// An RPC with new optional parameters: tries them, and on an older database
// repeats the call with only the old ones (and remembers that).
export async function callRpcCompat(name, args, legacyArgs, opts) {
  if (!legacyRpc.has(name)) {
    const res = await callRpc(name, args, opts);
    if (!isMissingApi(res) || !legacyArgs) return res;
    legacyRpc.add(name);
  }
  return legacyArgs ? callRpc(name, legacyArgs, opts) : { kind: "error", message: "Not available on this database", code: "PGRST202", status: 404 };
}

// Run a PostgREST builder (select or rpc) with a hard timeout. The timeout
// also covers supabase-js fetching / refreshing the session first.
export async function timedQuery(makeBuilder, { timeout = RPC_TIMEOUT_MS } = {}) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { kind: "transient", reason: "offline", maybeSent: false, message: "Offline" };
  }
  const ctrl = new AbortController();
  const t = timeoutAfter(timeout);
  try {
    let builder = makeBuilder();
    if (typeof builder.abortSignal === "function") builder = builder.abortSignal(ctrl.signal);
    // GETs retry on their own (1 s, 2 s, 4 s); the queue does the retrying here.
    if (typeof builder.retry === "function") builder = builder.retry(false);
    const res = await Promise.race([Promise.resolve(builder).catch((error) => ({ error, status: 0 })), t.promise]);
    if (res.timedOut) ctrl.abort();
    return classify(res, { sent: true });
  } finally {
    t.cancel();
  }
}

// An RPC that writes: make sure there is a session first (an expired token
// that can't refresh offline would otherwise go out as the anon key and come
// back as "Not authorized").
export async function callRpc(name, args, { timeout = RPC_TIMEOUT_MS } = {}) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { kind: "transient", reason: "offline", maybeSent: false, message: "Offline" };
  }
  const started = Date.now();
  const t = timeoutAfter(timeout);
  let sessionResult;
  try {
    const res = await Promise.race([supabase.auth.getSession().catch((thrown) => ({ thrown })), t.promise]);
    sessionResult = classifySession(res);
  } finally {
    t.cancel();
  }
  // No session: offline with an expired token is transient (it refreshes
  // once the connection is back); signed out / refresh refused is not.
  if (sessionResult.kind === "transient" && sessionResult.reason !== "lock") markReachable(false);
  if (sessionResult.kind !== "ok") return sessionResult;
  return timedQuery(() => supabase.rpc(name, args), { timeout: Math.max(1500, timeout - (Date.now() - started)) });
}

// ---------- Roster + events cache (per organizer, per event) ----------

const rosterKey = (userId, eventId) => `roster:${userId}:${eventId}`;
const eventsKey = (userId) => `events:${userId}`;
const queueKey = (userId) => `queue:${userId}`;

export async function saveRosterCache(userId, eventId, rows, syncedAt) {
  if (!userId || !eventId) return;
  try {
    await kvSet(rosterKey(userId, eventId), { rows, syncedAt: syncedAt || null, savedAt: new Date().toISOString() });
  } catch (err) {
    console.warn("Couldn't save the roster on this phone", err);
  }
}

export async function loadRosterCache(userId, eventId) {
  if (!userId || !eventId) return null;
  try {
    const v = await kvGet(rosterKey(userId, eventId));
    return v && Array.isArray(v.rows) ? v : null;
  } catch {
    return null;
  }
}

export async function saveEventsCache(userId, events) {
  if (!userId) return;
  try {
    await kvSet(eventsKey(userId), { events });
  } catch {
    /* ignore */
  }
}

export async function loadEventsCache(userId) {
  if (!userId) return null;
  try {
    const v = await kvGet(eventsKey(userId));
    return Array.isArray(v?.events) && v.events.length ? v.events : null;
  } catch {
    return null;
  }
}

// Small per-organizer extras: scan types, who already had each meal, and
// organizers' names ("by Evan"). key is e.g. "scantypes:<event>".
export async function saveUserCache(userId, key, value) {
  if (!userId) return;
  try {
    await kvSet(`x:${userId}:${key}`, value);
  } catch {
    /* ignore */
  }
}

export async function loadUserCache(userId, key) {
  if (!userId) return null;
  try {
    return (await kvGet(`x:${userId}:${key}`)) ?? null;
  } catch {
    return null;
  }
}

// Sign-out: forget this organizer's roster and events on this phone.
export async function clearUserCache(userId) {
  if (!userId) return;
  try {
    await kvDeletePrefix(`roster:${userId}:`);
    await kvDeletePrefix(`x:${userId}:`);
    await kvDelete(eventsKey(userId));
  } catch {
    /* ignore */
  }
}

// ---------- The queue ----------

function uuid() {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Item: { id (also the client id the database dedupes on), op: "check_in" |
//         "undo" | "scan", eventId, code, name, roles, team,
//         at (client scan time), state: "pending" | "attention", attempts,
//         unverified, error,
//         serverFailures: server errors (5xx) so far; flagged at SERVER_RETRY_LIMIT,
//         blocked: why it's flagged when it wasn't a refusal: "auth" | "server",
//         prevAt: (undo) the check-in time being undone,
//         scanTypeId, label: (scan) which meal / swag,
//         sendingAt: set while a request is out (survives a reload mid-send) }

// The RPC call for a queued item: new parameters, plus the old form for an
// older database (scans have none).
export function rpcForItem(item) {
  const base = { p_event_id: item.eventId, p_code: item.code };
  if (item.op === "undo") {
    return ["undo_check_in", { ...base, ...(item.prevAt ? { p_expected_checked_in_at: item.prevAt } : {}), p_source: "offline" }, base];
  }
  if (item.op === "scan") {
    return ["record_scan", { ...base, p_scan_type_id: item.scanTypeId, p_scanned_at: item.at, p_client_id: item.id, p_source: "offline" }, null];
  }
  return ["check_in_by_code", { ...base, p_checked_in_at: item.at, p_client_id: item.id, p_source: "offline" }, base];
}

export class CheckinQueue {
  constructor() {
    this.userId = null;
    this.items = [];
    this.inFlight = null; // id of the item being sent
    this.flushing = false;
    this.flushAgain = false;
    this.failures = 0;
    this.timer = null;
    this.nextAttemptAt = 0;
    this.lastError = "";
    this.listeners = new Set();
    this.writeChain = Promise.resolve();
    // (item, outcome, data) => void; outcome: synced | already | attention | undone
    this.onSettled = () => {};
    // Called once a flush leaves nothing waiting.
    this.onDrained = () => {};
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.listeners.forEach((fn) => {
      try {
        fn(this);
      } catch (err) {
        console.error(err);
      }
    });
  }

  async load(userId) {
    this.stop();
    this.userId = userId;
    this.items = [];
    this.failures = 0;
    try {
      const saved = await kvGet(queueKey(userId));
      if (this.userId !== userId) return;
      this.items = Array.isArray(saved) ? saved.filter((i) => i && i.id && i.code && i.op) : [];
      // The page went away while a request was out: it may have landed; the
      // retry carries the same client id, so the database won't do it twice.
      this.items.forEach((i) => {
        delete i.sendingAt;
        delete i.landedFrom;
        delete i.landedTo;
        // Flagged because the sign-in had gone: this is a new sign-in, try again.
        if (i.state === "attention" && i.blocked === "auth") reopen(i);
      });
    } catch {
      this.items = [];
    }
    this.emit();
  }

  unload() {
    this.stop();
    this.userId = null;
    this.items = [];
    this.emit();
  }

  async clear(userId = this.userId) {
    if (userId === this.userId) this.items = [];
    try {
      await kvDelete(queueKey(userId));
    } catch {
      /* ignore */
    }
    this.emit();
  }

  persist() {
    const userId = this.userId;
    if (!userId) return Promise.resolve();
    const snapshot = this.items.map((i) => ({ ...i }));
    this.writeChain = this.writeChain
      .then(() => kvSet(queueKey(userId), snapshot))
      .catch((err) => console.warn("Couldn't save the check-in queue", err));
    return this.writeChain;
  }

  get pending() {
    return this.items.filter((i) => i.state === "pending");
  }

  get attention() {
    return this.items.filter((i) => i.state === "attention");
  }

  // The waiting (not in flight, not needing attention) op for a code, if any.
  waitingFor(eventId, code) {
    return this.items.find((i) => i.eventId === eventId && i.code === code && i.state === "pending" && i.id !== this.inFlight) || null;
  }

  // Any pending check-in / undo for a code, including the one being sent right now.
  latestFor(eventId, code) {
    for (let k = this.items.length - 1; k >= 0; k--) {
      const i = this.items[k];
      if (i.eventId === eventId && i.code === code && i.state === "pending" && i.op !== "scan") return i;
    }
    return null;
  }

  // A meal / swag scan of this code for this scan type saved on this phone.
  scanFor(eventId, code, scanTypeId) {
    // One flagged because it never reached the server (sign-in gone, server
    // errors) doesn't count: they haven't had it as far as anyone knows.
    return this.items.find((i) => i.op === "scan" && i.eventId === eventId && i.code === code && i.scanTypeId === scanTypeId && !(i.state === "attention" && i.blocked)) || null;
  }

  async add(fields) {
    const item = {
      id: uuid(),
      state: "pending",
      attempts: 0,
      unverified: false,
      error: "",
      at: new Date().toISOString(),
      ...fields,
    };
    this.items.push(item);
    this.emit();
    await this.persist();
    this.schedule(FLUSH_BASE_MS);
    return item;
  }

  async remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length !== before) {
      this.emit();
      await this.persist();
    }
  }

  async retry(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    reopen(item);
    // Move it to the end so it doesn't block newer check-ins.
    this.items = [...this.items.filter((i) => i.id !== id), item];
    this.emit();
    await this.persist();
    this.flushSoon();
  }

  // The session came back (token refreshed / signed in again in this tab):
  // items flagged because the sign-in was gone get one more go each. Once
  // only, so a 403 that isn't about the token can't loop with the refresh.
  reopenBlocked(kind = "auth") {
    const items = this.items.filter((i) => i.state === "attention" && i.blocked === kind && !i.autoReopened);
    if (!items.length) return;
    items.forEach((i) => {
      reopen(i);
      i.autoReopened = true;
    });
    this.emit();
    this.persist();
    this.flushSoon();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.nextAttemptAt = 0;
  }

  schedule(delay) {
    if (!this.userId) return;
    const due = Date.now() + delay;
    // Keep an earlier attempt if one is already planned.
    if (this.timer && this.nextAttemptAt && this.nextAttemptAt <= due) return;
    clearTimeout(this.timer);
    this.nextAttemptAt = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextAttemptAt = 0;
      this.flush();
    }, delay);
  }

  // online, back in the foreground, "Sync now": try right away.
  flushSoon() {
    this.failures = 0;
    this.stop();
    this.flush();
  }

  backoff() {
    this.failures += 1;
    const base = Math.min(FLUSH_BASE_MS * 2 ** (this.failures - 1), FLUSH_MAX_MS);
    const jitter = base * (Math.random() * 0.2 - 0.1);
    this.schedule(Math.round(base + jitter));
  }

  async flush() {
    if (this.flushing) {
      // Asked again mid-flush (back online, a sign-in came back): one more pass after this one.
      this.flushAgain = true;
      return;
    }
    if (!this.userId) return;
    if (!this.pending.length) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.backoff();
      return;
    }
    const userId = this.userId;
    this.flushing = true;
    this.emit();
    let synced = 0;
    let stoppedEarly = false;
    try {
      for (;;) {
        if (this.userId !== userId) return;
        const item = this.items.find((i) => i.state === "pending");
        if (!item) break;
        this.inFlight = item.id;
        item.attempts += 1;
        item.sendingAt = new Date().toISOString();
        await this.persist();

        const [fn, args, legacyArgs] = rpcForItem(item);
        const result = await callRpcCompat(fn, args, legacyArgs);
        this.inFlight = null;
        delete item.sendingAt;
        if (this.userId !== userId) return;

        const step = queueStep(result, item);
        item.serverFailures = step.serverFailures;
        if (step.action === "wait") {
          // No answer (or a server error, under the limit): try again later.
          this.lastError = result.kind === "error" ? `server error, HTTP ${result.status}` : result.message;
          await this.persist();
          stoppedEarly = true;
          this.backoff();
          break;
        }
        if (step.action === "auth") {
          // The sign-in is gone: nothing else will sync either. Flag them all
          // (the sheet says to sign in again); the next sign-in retries them.
          stoppedEarly = true;
          this.lastError = "";
          const blocked = this.items.filter((i) => i.state === "pending");
          blocked.forEach((i) => {
            i.state = "attention";
            i.blocked = "auth";
            i.error = attentionText(i, result);
          });
          this.stop();
          this.emit();
          await this.persist();
          blocked.forEach((i) => {
            try {
              this.onSettled(i, "attention", null);
            } catch (err) {
              console.error(err);
            }
          });
          break;
        }
        this.failures = 0;
        this.lastError = "";
        const outcome = step.action === "attention" ? "attention" : this.outcomeFor(item, result);
        if (outcome === "attention") {
          item.state = "attention";
          item.blocked = result.kind === "error" && result.category === "server" ? "server" : "";
          item.error = attentionText(item, result);
        } else {
          this.items = this.items.filter((i) => i.id !== item.id);
          synced += 1;
        }
        this.emit();
        await this.persist();
        try {
          this.onSettled(item, outcome, result.data || null);
        } catch (err) {
          console.error(err);
        }
      }
    } finally {
      this.inFlight = null;
      this.flushing = false;
      this.emit();
      if (this.flushAgain) {
        this.flushAgain = false;
        if (this.userId === userId && this.pending.length) setTimeout(() => this.flush(), 0);
      }
    }
    if (!stoppedEarly && !this.pending.length) {
      this.stop();
      try {
        this.onDrained(synced);
      } catch (err) {
        console.error(err);
      }
    }
  }

  outcomeFor(item, result) {
    if (result.kind === "error") return "attention";
    const status = result.data?.status;
    if (item.op === "undo") {
      // ok, or not_checked_in (someone already undid it): either way, done.
      return status === "ok" || status === "not_checked_in" ? "undone" : "attention";
    }
    if (item.op === "scan") {
      if (status === "ok" || status === "not_checked_in") return "synced";
      return status === "already" ? "already" : "attention";
    }
    // ok includes a replay of our own earlier attempt (same client id).
    if (status === "ok") return "synced";
    if (status === "dupe") return "already";
    return "attention";
  }
}

// Back to waiting, with a fresh count of server errors.
function reopen(item) {
  item.state = "pending";
  item.error = "";
  item.blocked = "";
  item.serverFailures = 0;
  delete item.autoReopened;
}

export const queue = new CheckinQueue();

// A fresh id for a write (the database dedupes retries on it).
export const newClientId = () => uuid();
