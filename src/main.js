import { supabase } from "./supabase.js";
import { QrScanner, prewarm as prewarmScanner } from "./scanner.js";
import { feedback, unlockAudio, isMuted, setMuted } from "./feedback.js";
import { searchIndex, searchPeople, compareAZ, compareNewestIn, VirtualList, LetterIndex } from "./roster.js";
import { waiverState, waiverBadge, openWaiverSheet, syncWaiverSheet, isWaiverSheetOpen, prewarmWaiverQr } from "./waiver.js";
import {
  queue,
  callRpc,
  timedQuery,
  isOffline,
  onNetChange,
  noteMaybeLanded,
  saveRosterCache,
  loadRosterCache,
  saveEventsCache,
  loadEventsCache,
  clearUserCache,
} from "./offline.js";
import { requestPersistence } from "./offline-store.js";
import { mountSyncUI, ICON_SAVED } from "./sync-ui.js";
import { registerServiceWorker } from "./pwa.js";
import "./style.css";

// ---------- Phone shell: no page zoom, no page scroll ----------
// iOS Safari ignores user-scalable=no, so block its pinch gestures directly.
// Double-tap zoom is handled by touch-action: manipulation in style.css.
["gesturestart", "gesturechange", "gestureend"].forEach((type) => {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
});
document.addEventListener(
  "touchmove",
  (e) => {
    if (e.touches.length > 1 || (typeof e.scale === "number" && e.scale !== 1)) e.preventDefault();
  },
  { passive: false }
);

// Size the app to the visible area. With the on-screen keyboard open, iOS
// shrinks only the visual viewport and pans the page; follow the visual
// viewport so the field being typed in and the list above it stay on screen.
function syncViewportHeight() {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", syncViewportHeight);
  window.visualViewport.addEventListener("scroll", syncViewportHeight);
}
window.addEventListener("resize", syncViewportHeight);
window.addEventListener("orientationchange", syncViewportHeight);
syncViewportHeight();

const ROLES = ["hacker", "judge", "mentor"];
const ROLE_LABELS = { hacker: "Hackers", judge: "Judges", mentor: "Mentors" };
const ROLE_SINGULAR = { hacker: "Hacker", judge: "Judge", mentor: "Mentor" };
const RECENT_MAX = 6;
// Not yet first: the desk's job is the people who haven't arrived.
const STATUS_FILTERS = [
  ["out", "Not yet"],
  ["in", "Checked in"],
  ["all", "All"],
];
// Only used when the organizer's events can't be loaded from event_roles.
const FALLBACK_EVENT_ID = (import.meta.env.VITE_EVENT_ID || "").trim();
const EVENT_STORAGE_PREFIX = "datahacks-checkin:event:";
const NOT_ORGANIZER_MESSAGE = "This Google account isn't an organizer. Ask a DataHacks organizer to add you.";
const NOT_ORGANIZER_PASSWORD_MESSAGE = "This account isn't an organizer. Ask a DataHacks organizer to add you.";

let roster = [];
// code -> person, rebuilt with the roster.
let rosterByCode = new Map();
// True while the roster for the selected event is being fetched (first load, event switch).
let rosterLoading = true;
const statusFilter = { hacker: "out", judge: "out", mentor: "out" };
let eventId = null;
let currentEvent = null;
let events = [];
let usingFallback = false;
let sessionUserId = null;
let lastScanId = null;
let lastScanTime = 0;
let scanner = null;
// The organizer turned the camera on (Start) and hasn't pressed Stop. The
// camera is released while the Scan tab or the page is hidden, and comes back
// when they return.
let cameraWanted = false;
let attendeesChannel = null;
let authUrlCleaned = false;
// The result on the status card, and the scans before it (newest first).
let currentScan = null;
let recentScans = [];
// When the roster on screen last came from the server (it may be the copy
// saved on this phone while offline).
let rosterSyncedAt = null;

// An OAuth error (e.g. the person closed the Google screen) comes back in the
// query string or hash. supabase-js only consumes successful sign-ins, so read
// the error here and show it on the sign-in screen.
const oauthError = (() => {
  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const description = params.get("error_description") || hash.get("error_description");
  const code = params.get("error") || hash.get("error");
  if (!description && !code) return null;
  return (description || code).replace(/\+/g, " ");
})();

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function formatTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatTimeSeconds(date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

// "9:41" for the narrow recent list and roster rows.
function formatTimeShort(iso) {
  const t = formatTime(iso);
  return t ? t.replace(/\s?[AP]\.?M\.?$/i, "") : null;
}

function roleList(person) {
  return Array.isArray(person.roles) ? person.roles.filter(Boolean) : [];
}

// Colour key for a person: mentor + judge (B codes) gets its own colour.
function roleKey(roles) {
  const list = Array.isArray(roles) ? roles : [];
  if (list.includes("mentor") && list.includes("judge")) return "both";
  return ROLES.find((r) => list.includes(r)) || "none";
}

function roleText(roles) {
  const list = (Array.isArray(roles) ? roles : []).filter((r) => ROLE_SINGULAR[r]);
  return list.length ? list.map((r) => ROLE_SINGULAR[r]).join(" + ") : "Attendee";
}

function initials(name) {
  const words = String(name || "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(dr|prof|mr|mrs|ms|mx)$/i.test(w));
  if (!words.length) return "?";
  const first = [...words[0]][0] || "";
  const last = words.length > 1 ? [...words[words.length - 1]][0] || "" : "";
  return (first + last).toUpperCase();
}

// DH27-H042 -> H042 inside an event where the prefix is implied.
function shortCode(code) {
  return String(code || "").replace(/^[^-]+-(?=.)/, "");
}

function showAuth() {
  document.getElementById("auth-screen").classList.remove("app-hidden");
  document.getElementById("boot-screen").classList.add("app-hidden");
  document.getElementById("app").classList.add("app-hidden");
}

function showBoot(message) {
  document.getElementById("auth-screen").classList.add("app-hidden");
  document.getElementById("boot-screen").classList.remove("app-hidden");
  document.getElementById("boot-screen").classList.remove("error");
  document.getElementById("boot-message").textContent = message || "Connecting to database…";
  document.getElementById("app").classList.add("app-hidden");
}

function showBootError(html) {
  const boot = document.getElementById("boot-screen");
  boot.classList.remove("app-hidden");
  boot.classList.add("error");
  document.getElementById("boot-message").innerHTML =
    html +
    `<div class="boot-actions"><button class="ghost" id="boot-sign-out-btn" type="button">Sign out</button></div>`;
  document.getElementById("boot-sign-out-btn").addEventListener("click", () => {
    supabase.auth.signOut({ scope: "local" });
  });
  document.getElementById("auth-screen").classList.add("app-hidden");
}

function setAuthError(message) {
  document.getElementById("auth-error").textContent = message || "";
}

// After supabase-js has read the sign-in result from the URL, drop what is
// left of it (an empty "#", or an OAuth error) so a reload starts clean.
function cleanAuthUrl() {
  if (authUrlCleaned) return;
  authUrlCleaned = true;
  const url = new URL(window.location.href);
  ["error", "error_code", "error_description", "code", "state"].forEach((key) => url.searchParams.delete(key));
  url.hash = "";
  if (url.href !== window.location.href) {
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
  }
}

function setSessionEmail(email) {
  document.getElementById("session-email").textContent = email;
  const btn = document.getElementById("sign-out-btn");
  btn.title = email ? `Signed in as ${email}` : "";
  btn.setAttribute("aria-label", email ? `Sign out ${email}` : "Sign out");
}

function showApp() {
  document.getElementById("auth-screen").classList.add("app-hidden");
  document.getElementById("boot-screen").classList.add("app-hidden");
  document.getElementById("app").classList.remove("app-hidden");
}

function normalizeRow(row) {
  const roles = Array.isArray(row.roles) ? row.roles : [];
  const person = {
    id: row.id,
    code: (row.code || "").toUpperCase(),
    name: row.name || row.email || row.code,
    email: row.email || "",
    roles,
    team: row.team || "",
    checked_in: !!row.checked_in_at,
    checked_in_at: row.checked_in_at,
    at: formatTime(row.checked_in_at),
    // "signed" | "missing" | "unknown" (database without attendees.waiver_signed_at yet).
    waiver: waiverState(row),
    // The row as the database sent it, for the copy saved on this phone.
    row,
  };
  person.search = searchIndex(person);
  return person;
}

function setRoster(rows) {
  roster = rows;
  rosterByCode = new Map(roster.map((p) => [p.code, p]));
  syncWaiverViews();
}

// Someone signed while their scan card (or the Sign now sheet) is up: show it.
function syncWaiverViews() {
  syncWaiverSheet((code) => rosterByCode.get(code));
  if (!currentScan || currentScan.kind === "error") return;
  // Only while the card still shows that scan (not "Looking up…" or an error).
  if (document.getElementById("status-card")?.dataset.scan !== currentScan.code) return;
  const p = rosterByCode.get(currentScan.code);
  if (!p) return;
  if (p.waiver !== currentScan.waiver && p.waiver !== "unknown") {
    currentScan.waiver = p.waiver;
    showScan(currentScan, { quiet: true });
  }
}

// Apply a check-in or undo locally so the list updates at once; the
// background reload (and realtime) reconcile with the database.
function patchPerson(code, checkedInAt) {
  const p = rosterByCode.get(String(code || "").toUpperCase());
  if (!p) return;
  setPersonIn(p, checkedInAt);
  persistRosterSoon();
}

function setPersonIn(p, checkedInAt) {
  p.checked_in = !!checkedInAt;
  p.checked_in_at = checkedInAt || null;
  p.at = formatTime(checkedInAt);
}

// ---------- Offline: saved roster + check-ins waiting to sync ----------

// The op saved on this phone for a code in this event, if any.
function savedOp(code) {
  return eventId ? queue.latestFor(eventId, code) : null;
}

function isSavedCheckIn(code) {
  return savedOp(code)?.op === "check_in";
}

// Check-ins / undos saved on this phone win over whatever roster we loaded.
function applyQueueOverlay() {
  queue.pending.forEach((i) => {
    if (i.eventId !== eventId) return;
    const p = rosterByCode.get(i.code);
    if (!p) return;
    if (i.op === "check_in" && !p.checked_in) setPersonIn(p, i.at);
    else if (i.op === "undo" && p.checked_in) setPersonIn(p, null);
  });
}

const rowForCache = (p) => ({ ...p.row, checked_in_at: p.checked_in_at || null });

let cacheTimer = null;
function persistRosterSoon(delay = 800) {
  clearTimeout(cacheTimer);
  const userId = sessionUserId;
  const ev = eventId;
  if (!userId || !ev || rosterLoading) return;
  cacheTimer = setTimeout(() => {
    if (userId !== sessionUserId || ev !== eventId || rosterLoading) return;
    saveRosterCache(userId, ev, roster.map(rowForCache), rosterSyncedAt);
  }, delay);
}

function queryError(res) {
  const err = new Error(res.message || "Request failed");
  err.transient = res.kind === "transient";
  return err;
}

function readStoredEventId(userId) {
  try {
    return localStorage.getItem(EVENT_STORAGE_PREFIX + userId);
  } catch {
    return null;
  }
}

function storeEventId(userId, id) {
  try {
    localStorage.setItem(EVENT_STORAGE_PREFIX + userId, id);
  } catch {
    /* ignore */
  }
}

// Newest event first: starts_at desc (events without a date last), then the
// most recent organizer grant. events has no created_at column.
function compareEvents(a, b) {
  const aStart = a.starts_at ? Date.parse(a.starts_at) : -Infinity;
  const bStart = b.starts_at ? Date.parse(b.starts_at) : -Infinity;
  if (aStart !== bStart) return bStart - aStart;
  return Date.parse(b.role_created_at || 0) - Date.parse(a.role_created_at || 0);
}

async function loadOrganizerEvents(userId) {
  const res = await timedQuery(() =>
    supabase.from("event_roles").select("created_at, events(id, name, code, starts_at)").eq("user_id", userId).eq("role", "organizer")
  );
  if (res.kind !== "ok") throw queryError(res);
  const data = res.data;
  const byId = new Map();
  (data || []).forEach((row) => {
    const event = row.events;
    if (!event?.id || !event.code || byId.has(event.id)) return;
    byId.set(event.id, { ...event, role_created_at: row.created_at });
  });
  const list = [...byId.values()].sort(compareEvents);
  saveEventsCache(userId, list);
  return list;
}

// The pre-picker behaviour: VITE_EVENT_ID if set, else the newest event with a code.
async function loadFallbackEvent() {
  const res = await timedQuery(() => {
    const query = supabase.from("events").select("id, name, starts_at, code");
    return FALLBACK_EVENT_ID ? query.eq("id", FALLBACK_EVENT_ID) : query.order("starts_at", { ascending: false, nullsFirst: false });
  });
  if (res.kind !== "ok") throw queryError(res);
  const data = res.data;
  if (!data?.length) {
    throw new Error(
      FALLBACK_EVENT_ID ? `No event with id ${FALLBACK_EVENT_ID} (VITE_EVENT_ID).` : 'No rows in the "events" table.'
    );
  }
  const event = data.find((row) => row.code) || data[0];
  if (!event.code) {
    throw new Error("This event has no code. Run the check-in SQL and set events.code (e.g. DH26).");
  }
  return event;
}

function renderEventPicker() {
  const select = document.getElementById("event-select");
  select.innerHTML = events
    .map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.code)} · ${escapeHtml(e.name)}</option>`)
    .join("");
  select.value = eventId;
  select.disabled = events.length < 2;

  document.querySelectorAll(".current-event-code").forEach((el) => {
    el.textContent = currentEvent.code;
  });
  // "DataHacks 2027" from the event name, else from its start date.
  const year =
    (String(currentEvent.name || "").match(/\b(20\d\d)\b/) || [])[1] ||
    (currentEvent.starts_at ? new Date(currentEvent.starts_at).getUTCFullYear() : null);
  document.getElementById("brand-kicker").textContent = year ? `DataHacks ${year}` : "DataHacks";
  const chip = document.querySelector(".event-chip");
  chip.classList.toggle("fallback", usingFallback);
  chip.classList.toggle("single", events.length < 2);
  chip.title = `Checking in to ${currentEvent.code} · ${currentEvent.name}. Every check-in, undo and roster on this page uses this event.`;
  const banner = document.getElementById("fallback-banner");
  banner.hidden = !usingFallback;
  banner.textContent = usingFallback
    ? `Checking in to ${currentEvent.code} · ${currentEvent.name} (fallback: couldn't load the events you organize)`
    : "";
  document.title = `${currentEvent.code} · DataHacks Check-In`;
}

// Resolves to null when the person is signed in but isn't an organizer of any
// event. Nothing is rendered or loaded for them in that case.
async function loadEvent(userId) {
  let list = [];
  let listLoaded = false;
  // No connection: the events this organizer had last time, straight away.
  if (isOffline()) {
    const cached = await loadEventsCache(userId);
    if (cached) {
      list = cached;
      listLoaded = true;
    }
  }
  if (!listLoaded) {
    try {
      list = await loadOrganizerEvents(userId);
      listLoaded = true;
    } catch (err) {
      const cached = err.transient ? await loadEventsCache(userId) : null;
      if (cached) {
        list = cached;
        listLoaded = true;
      } else {
        console.error("Couldn't load organizer events; using fallback event", err);
      }
    }
  }

  if (listLoaded && !list.length) return null;

  if (list.length) {
    usingFallback = false;
    events = list;
    const stored = readStoredEventId(userId);
    currentEvent = list.find((e) => e.id === stored) || list[0];
  } else {
    usingFallback = true;
    currentEvent = await loadFallbackEvent();
    events = [currentEvent];
  }
  eventId = currentEvent.id;
  renderEventPicker();
  return currentEvent;
}

async function switchEvent(nextId) {
  const select = document.getElementById("event-select");
  const next = events.find((e) => e.id === nextId);
  if (!next || next.id === eventId) {
    select.value = eventId;
    return;
  }
  const ok = window.confirm(
    `Switch check-in from ${currentEvent.code} to ${next.code}?\n\n${next.name}\n\nEvery scan, check-in and undo after this goes to ${next.code}.`
  );
  if (!ok) {
    select.value = eventId;
    return;
  }

  currentEvent = next;
  eventId = next.id;
  storeEventId(sessionUserId, next.id);
  setRoster([]);
  rosterLoading = true;
  lastScanId = null;
  currentScan = null;
  recentScans = [];
  renderRecent();
  renderEventPicker();
  renderActiveRoleView();
  select.disabled = true;
  setInfo(`Switched to ${next.code}. Loading roster…`, "Loading");

  try {
    await loadRoster();
    await subscribeAttendees();
    clearCard();
  } catch (err) {
    rosterLoading = false;
    renderActiveRoleView();
    setFailure(`Couldn't load ${next.code}`, err.message || err);
  } finally {
    select.disabled = events.length < 2;
  }
}

const ROSTER_COLUMNS = "id, event_id, code, name, email, roles, team, checked_in_at";
// False once the database says attendees has no waiver_signed_at (the site's
// waivers migration isn't on it yet): the roster then loads without it.
let waiverColumn = true;
const isMissingWaiverColumn = (error) =>
  error?.code === "42703" || error?.code === "PGRST204" || /waiver_signed_at/.test(error?.message || "");

// Resolves to timedQuery's { kind: "ok" | "transient" | "error", ... }.
async function fetchRoster(id) {
  if (waiverColumn) {
    const res = await timedQuery(() => supabase.from("attendees").select(`${ROSTER_COLUMNS}, waiver_signed_at`).eq("event_id", id).order("code"));
    if (res.kind !== "error" || !isMissingWaiverColumn(res)) return res;
    waiverColumn = false;
  }
  return timedQuery(() => supabase.from("attendees").select(ROSTER_COLUMNS).eq("event_id", id).order("code"));
}

async function loadRoster() {
  const requestedEventId = eventId;
  const userId = sessionUserId;
  const res = await fetchRoster(requestedEventId);
  // The organizer switched events while this was in flight.
  if (requestedEventId !== eventId) return;

  if (res.kind === "ok") {
    rosterSyncedAt = new Date().toISOString();
    setRoster((res.data || []).map(normalizeRow));
    applyQueueOverlay();
    saveRosterCache(userId, requestedEventId, roster.map(rowForCache), rosterSyncedAt);
  } else {
    // A refresh that failed keeps the roster on screen.
    if (!rosterLoading) throw queryError(res);
    // First load with no connection: the roster saved on this phone.
    const cached = res.kind === "transient" ? await loadRosterCache(userId, requestedEventId) : null;
    if (requestedEventId !== eventId) return;
    if (!cached) throw queryError(res);
    rosterSyncedAt = cached.syncedAt;
    setRoster(cached.rows.map(normalizeRow));
    applyQueueOverlay();
  }
  rosterLoading = false;
  renderActiveRoleView();
  renderRecent();
  syncUI.render();
}

// One roster fetch at a time; calls while one is in flight run once after it.
let rosterRequest = null;
let rosterAgain = false;
function reloadRoster() {
  if (rosterRequest) {
    rosterAgain = true;
    return rosterRequest;
  }
  rosterRequest = loadRoster()
    .catch((err) => console.error(err))
    .finally(() => {
      rosterRequest = null;
      if (rosterAgain) {
        rosterAgain = false;
        reloadRoster();
      }
    });
  return rosterRequest;
}
let reloadTimer = null;
function scheduleReload(delay = 400) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reloadRoster, delay);
}

function renderActiveRoleView(opts) {
  ROLES.forEach((role) => {
    if (document.getElementById("view-" + role).classList.contains("active")) {
      renderRoleView(role, opts);
    }
  });
}

let renderFrame = 0;
function scheduleRosterRender() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    renderActiveRoleView();
    renderRecent();
  });
}

// A change from another desk: update that one person in place (no refetch of
// the whole roster). Anything unexpected falls back to a reload.
function applyRealtime(payload) {
  const type = payload?.eventType;
  const row = payload?.new;
  if ((type === "INSERT" || type === "UPDATE") && row?.id && row.code && row.event_id === eventId) {
    const next = normalizeRow(row);
    const i = roster.findIndex((p) => p.id === next.id);
    if (i >= 0) roster[i] = next;
    else roster.push(next);
    setRoster(roster);
    // Another desk's update doesn't undo a check-in saved on this phone.
    applyQueueOverlay();
    scheduleRosterRender();
    persistRosterSoon();
  } else if (type === "DELETE" && payload.old?.id) {
    setRoster(roster.filter((p) => p.id !== payload.old.id));
    scheduleRosterRender();
    persistRosterSoon();
  } else {
    scheduleReload();
  }
}

async function subscribeAttendees() {
  if (attendeesChannel) {
    await supabase.removeChannel(attendeesChannel);
    attendeesChannel = null;
  }
  let dropped = false;
  attendeesChannel = supabase
    .channel(`attendees:${eventId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "attendees",
        filter: `event_id=eq.${eventId}`,
      },
      (payload) => applyRealtime(payload)
    )
    .subscribe((status) => {
      // Back after a drop: changes from other desks may have been missed.
      if (status === "SUBSCRIBED") {
        if (dropped) {
          dropped = false;
          scheduleReload(200);
        }
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        dropped = true;
      }
    });
}

function resolveCode(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  const match =
    rosterByCode.get(upper) ||
    roster.find((p) => (p.email || "").toLowerCase() === lower) ||
    roster.find((p) => (p.name || "").toLowerCase() === lower);
  return match ? match.code : upper;
}

// ---------- Scan result card ----------
// One fixed-height card under the camera: a coloured band (state + time) over
// an end-stone body (role tile, name, code · role · team, Undo).

const BAND = {
  success: { icon: "✓", label: "Checked in" },
  warning: { icon: "↺", label: "Already in" },
  error: { icon: "✕", label: "Not on roster" },
  // Offline, and the code isn't in the roster saved on this phone.
  unverified: { icon: "?", label: "Can't verify offline", card: "warning" },
  // ...and the organizer saved it anyway.
  "saved-unverified": { icon: "?", label: "Saved · will verify", card: "warning" },
};

function renderCard(kind, html, { quiet = false } = {}) {
  const card = document.getElementById("status-card");
  card.className = kind;
  card.innerHTML = html;
  delete card.dataset.scan;
  if (quiet) return;
  // Restart the entrance animation for every new result.
  card.classList.remove("enter");
  void card.offsetWidth;
  card.classList.add("enter");
}

// Idle: no hint card. The space stays reserved so the camera never jumps.
function clearCard() {
  const card = document.getElementById("status-card");
  card.className = "idle";
  card.innerHTML = "";
}

function setInfo(text, label = "Ready") {
  renderCard(
    "info",
    `<div class="band"><span class="band-title"><span class="sq" aria-hidden="true"></span>${escapeHtml(label)}</span><span class="band-time">${escapeHtml(currentEvent?.code || "")}</span></div>
     <div class="body"><p class="info-text">${escapeHtml(text)}</p></div>`
  );
}

function setFailure(title, detail) {
  renderCard(
    "error",
    `<div class="band"><span class="band-title"><span aria-hidden="true">✕</span> ${escapeHtml(title)}</span></div>
     <div class="body"><div class="avatar role-none" aria-hidden="true">!</div><div class="who"><div class="name">${escapeHtml(title)}</div><div class="meta">${escapeHtml(detail)}</div></div></div>`
  );
}

function showScan(scan, { quiet = false } = {}) {
  const band = BAND[scan.kind];
  const unknown = scan.kind === "error" || scan.kind === "unverified" || scan.kind === "saved-unverified";
  let action = "";
  if (scan.kind === "success" || scan.kind === "saved-unverified") {
    action = `<button class="undo-btn" type="button" data-card-undo="${escapeHtml(scan.code)}" aria-label="Undo check-in for ${escapeHtml(scan.name)}">Undo</button>`;
  } else if (scan.kind === "unverified") {
    action = `<button class="undo-btn" type="button" data-card-save="${escapeHtml(scan.code)}" aria-label="Save ${escapeHtml(scan.code)} anyway; it's checked against the roster when back online">Save anyway</button>`;
  }
  const metaParts = unknown
    ? [scan.hint]
    : [scan.roleText, scan.team, scan.kind === "warning" ? (scan.otherDesk ? "checked in at another desk" : "no action taken") : ""].filter(Boolean);
  // Waiver on file or not (nothing when the database can't say). It sits at the
  // end of the meta line and never truncates; the code goes short to make room.
  // Offline, it comes from the roster saved on this phone.
  const waiver = unknown ? "" : waiverBadge(scan.waiver, { code: scan.code, name: scan.name, button: true });
  const code = waiver ? shortCode(scan.code) : scan.code;
  // Saved on this phone: a quiet cloud-and-clock mark instead of the time.
  const bandRight = scan.pending
    ? `<span class="band-saved">${ICON_SAVED}<span class="band-saved-long">Saved on phone · will sync</span><span class="band-saved-short">Will sync</span></span>`
    : escapeHtml(scan.bandRight);
  const savedNote = scan.pending ? `<span class="visually-hidden">Saved on this phone, will sync.</span>` : "";
  renderCard(
    band.card || scan.kind,
    `<div class="band"><span class="band-title"><span aria-hidden="true">${band.icon}</span> ${band.label}</span><span class="band-time">${bandRight}</span>${savedNote}</div>
     <div class="body">
       <div class="avatar role-${unknown ? "none" : scan.role}" aria-hidden="true">${escapeHtml(unknown ? "?" : initials(scan.name))}</div>
       <div class="who">
         <div class="name">${escapeHtml(scan.kind === "error" ? "Unknown code" : unknown ? "Not found" : scan.name)}</div>
         <div class="meta"><code title="${escapeHtml(scan.code)}">${escapeHtml(code)}</code><span class="meta-text">${metaParts.map((p) => ` · ${escapeHtml(p)}`).join("")}</span>${waiver}</div>
       </div>
       ${action}
     </div>`,
    { quiet }
  );
  document.getElementById("status-card").dataset.scan = scan.code;
  if (scan.waiver === "missing") prewarmWaiverQr();
}

// The previous result moves into the recent list when a new one arrives.
function pushScan(scan) {
  if (currentScan) recentScans = [currentScan, ...recentScans].slice(0, RECENT_MAX);
  currentScan = scan;
  showScan(scan);
  renderRecent();
}

function renderRecent() {
  const list = document.getElementById("recent-list");
  if (!list) return;
  document.getElementById("recent").classList.toggle("empty", !recentScans.length);
  list.innerHTML = recentScans
    .map((scan) => {
      const person = rosterByCode.get(scan.code);
      const unknown = scan.kind === "error" || scan.kind === "unverified" || scan.kind === "saved-unverified";
      const undone =
        (scan.kind === "saved-unverified" && !savedOp(scan.code)) || (!unknown && person && !person.checked_in);
      const kind = undone ? "undone" : unknown && scan.kind !== "error" ? "warning" : scan.kind;
      const status =
        kind === "undone"
          ? `<span class="t">undone</span>`
          : kind === "error"
            ? `<span class="t"><span aria-hidden="true">✕</span><span class="visually-hidden">Unknown code,</span> ${escapeHtml(scan.timeShort)}</span>`
            : unknown
              ? `<span class="t">${scan.kind === "saved-unverified" ? ICON_SAVED : `<span aria-hidden="true">?</span>`}<span class="visually-hidden">${scan.kind === "saved-unverified" ? "Saved on this phone, not verified," : "Couldn't verify offline,"}</span> ${escapeHtml(scan.timeShort)}</span>`
              : kind === "warning"
                ? `<span class="t"><span aria-hidden="true">↺</span><span class="visually-hidden">Already in since</span> ${escapeHtml(scan.inShort || scan.timeShort)}</span>`
                : scan.pending
                  ? `<span class="t">${ICON_SAVED}<span class="visually-hidden">Saved on this phone, will sync, checked in</span> ${escapeHtml(scan.inShort || scan.timeShort)}</span>`
                  : `<span class="t"><span aria-hidden="true">✓</span><span class="visually-hidden">Checked in</span> ${escapeHtml(scan.inShort || scan.timeShort)}</span>`;
      return `<li class="recent-row is-${kind}${scan.pending ? " is-pending" : ""}">
        <span class="sq role-${unknown ? "none" : scan.role}" aria-hidden="true"></span>
        <span class="nm">${escapeHtml(scan.kind === "error" ? "Unknown code" : unknown ? "Not verified" : scan.name)}</span>
        <code>${escapeHtml(shortCode(scan.code))}</code>${status}</li>`;
    })
    .join("");
}

// Soft colour glow on the camera frame (~1.1 s), then back to the quiet edge.
let flashTimer = null;
function flashFrame(kind) {
  const frame = document.getElementById("reader-frame");
  delete frame.dataset.flash;
  void frame.offsetWidth;
  frame.dataset.flash = kind;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => delete frame.dataset.flash, 1200);
}

function announce(kind) {
  flashFrame(kind);
  feedback(kind);
}

function scanBase(code, person, at) {
  return {
    code,
    name: person?.name || code,
    role: roleKey(person?.roles),
    roleText: roleText(person?.roles),
    team: person?.team || "",
    timeShort: formatTimeShort(new Date().toISOString()),
    inShort: formatTimeShort(at),
    roles: Array.isArray(person?.roles) ? person.roles : [],
    // Offline: waiver from the roster saved on this phone.
    waiver: person?.waiver || "unknown",
  };
}

function eventCodeHint(code) {
  const prefix = (code.match(/^([A-Z0-9]{2,10})-[HJMB]\d+$/) || [])[1] || "";
  const eventCode = (currentEvent?.code || "").toUpperCase();
  return { prefix, eventCode, wrongEvent: !!(prefix && eventCode && prefix !== eventCode) };
}

// No answer from the server: decide with the roster saved on this phone.
// maybeSentAt: when the request that failed went out (it may have landed).
async function checkInOffline(raw, code, maybeSentAt = null) {
  const p = rosterByCode.get(code);
  if (!p) {
    const { prefix, eventCode, wrongEvent } = eventCodeHint(code);
    const hint = wrongEvent ? `this pass is for ${prefix}, not ${eventCode}` : rosterSyncedAt ? `roster saved ${formatTime(rosterSyncedAt)}` : "no saved roster";
    pushScan({ ...scanBase(code, null), kind: "unverified", hint, bandRight: eventCode, maybeSentAt });
    announce("warning");
    return { status: "unverified", message: `Can't verify "${raw}" offline` };
  }
  if (p.checked_in) {
    const since = formatTime(p.checked_in_at);
    pushScan({ ...scanBase(code, p, p.checked_in_at), kind: "warning", pending: isSavedCheckIn(code), bandRight: since ? `since ${since}` : "" });
    announce("warning");
    return { status: "dupe", name: p.name, code, checked_in_at: p.checked_in_at };
  }
  const fields = { op: "check_in", eventId, code, name: p.name, roles: p.roles, team: p.team || "" };
  if (maybeSentAt) noteMaybeLanded(fields, maybeSentAt);
  const item = await queue.add(fields);
  patchPerson(code, item.at);
  pushScan({ ...scanBase(code, p, item.at), kind: "success", pending: true, bandRight: formatTimeSeconds(new Date(item.at)) });
  announce("success");
  return { status: "ok", queued: true, name: p.name, code, checked_in_at: item.at };
}

// "Save anyway" on a code that isn't in the saved roster: the server decides later.
async function saveUnverified(code) {
  const scan = currentScan?.code === code && currentScan.kind === "unverified" ? currentScan : null;
  if (!scan || savedOp(code)) return;
  const fields = { op: "check_in", eventId, code, name: code, roles: [], team: "", unverified: true };
  if (scan.maybeSentAt) noteMaybeLanded(fields, scan.maybeSentAt);
  await queue.add(fields);
  Object.assign(scan, { kind: "saved-unverified", hint: "checked against the roster once online" });
  showScan(scan);
  renderRecent();
}

async function processCode(rawText) {
  const raw = String(rawText || "").trim();
  const code = resolveCode(raw);
  const now = Date.now();
  if (!code) return;
  if (code === lastScanId && now - lastScanTime < 3000) return { status: "throttled" };
  lastScanId = code;
  lastScanTime = now;

  // Something for this code is already saved on this phone: settle it here,
  // in order, rather than racing the queue to the server.
  const saved = savedOp(code);
  if (saved?.op === "check_in") return checkInOffline(raw, code);
  if (saved?.op === "undo" && saved.id !== queue.inFlight) {
    // Checked in on the server, undone on this phone, back again: drop the undo.
    await queue.remove(saved.id);
    const p = rosterByCode.get(code);
    patchPerson(code, saved.prevAt || new Date().toISOString());
    pushScan({ ...scanBase(code, p, saved.prevAt), kind: "success", bandRight: formatTimeSeconds(new Date()) });
    announce("success");
    renderActiveRoleView();
    return { status: "ok", name: p?.name || code, code };
  }
  if (saved || isOffline()) return checkInOffline(raw, code);

  setInfo(`Looking up ${code}…`, "Checking");

  const sentAt = new Date().toISOString();
  const result = await callRpc("check_in_by_code", { p_event_id: eventId, p_code: code });

  if (result.kind === "transient") return checkInOffline(raw, code, result.maybeSent ? sentAt : null);
  if (result.kind === "error") {
    setFailure("Check-in failed", result.message);
    announce("error");
    return { status: "error", message: result.message };
  }

  const data = result.data;
  const status = data?.status;
  const scannedAt = new Date();
  const base = {
    code: (data?.code || code).toUpperCase(),
    name: data?.name || code,
    role: roleKey(data?.roles),
    roleText: roleText(data?.roles),
    team: data?.team || "",
    timeShort: formatTimeShort(scannedAt.toISOString()),
    inShort: formatTimeShort(data?.checked_in_at),
    roles: Array.isArray(data?.roles) ? data.roles : [],
    // From check_in_by_code when the database has waivers, else the roster's copy.
    waiver: data && "waiver_signed_at" in data ? waiverState(data) : rosterByCode.get((data?.code || code).toUpperCase())?.waiver || "unknown",
  };

  if (status === "unknown") {
    const { prefix, eventCode, wrongEvent } = eventCodeHint(code);
    const hint = wrongEvent ? `this pass is for ${prefix}, not ${eventCode}` : `not on the ${eventCode} roster`;
    pushScan({ ...base, kind: "error", code, role: "none", hint, bandRight: eventCode });
    announce("error");
    return { status: "unknown", message: wrongEvent ? `This code is for ${prefix}, but you're checking in to ${eventCode}.` : `"${raw}" is not on the ${eventCode} attendees roster` };
  }

  if (status === "dupe") {
    const since = formatTime(data.checked_in_at);
    pushScan({ ...base, kind: "warning", bandRight: since ? `since ${since}` : "" });
    announce("warning");
  } else if (status === "ok") {
    pushScan({ ...base, kind: "success", bandRight: formatTimeSeconds(data.checked_in_at ? new Date(data.checked_in_at) : scannedAt) });
    announce("success");
  } else {
    setFailure("Unexpected response", JSON.stringify(data));
    announce("error");
  }

  if (status === "ok" || status === "dupe") patchPerson(base.code, data.checked_in_at || scannedAt.toISOString());
  reloadRoster();
  return data || {};
}

async function undoCode(code) {
  const person = rosterByCode.get(code);
  const name = person?.name || code;
  const saved = savedOp(code);

  // Not synced yet: just take it off this phone.
  if (saved?.op === "check_in" && saved.id !== queue.inFlight) {
    await queue.remove(saved.id);
    patchPerson(code, null);
    if (currentScan?.code === code) currentScan = null;
    setInfo(`Undid check-in for ${name}. It hadn't synced yet.`, "Undone");
    renderRecent();
    return { status: "ok", name, code, local: true };
  }
  if (saved?.op === "undo") return { status: "ok", name, code, queued: true };

  const queueUndo = async (maybeSentAt) => {
    const fields = { op: "undo", eventId, code, name, roles: person?.roles || [], team: person?.team || "", prevAt: person?.checked_in_at || null };
    if (maybeSentAt) noteMaybeLanded(fields, maybeSentAt);
    await queue.add(fields);
    patchPerson(code, null);
    if (currentScan?.code === code) currentScan = null;
    setInfo(`Undid check-in for ${name}. Saved on this phone, will sync.`, "Undone");
    renderRecent();
    return { status: "ok", name, code, queued: true };
  };
  if (saved || isOffline()) return queueUndo(null);

  const sentAt = new Date().toISOString();
  const result = await callRpc("undo_check_in", { p_event_id: eventId, p_code: code });
  if (result.kind === "transient") return queueUndo(result.maybeSent ? sentAt : null);
  if (result.kind === "error") {
    setFailure("Undo failed", result.message);
    return { status: "error", message: result.message };
  }
  const data = result.data;
  if (data?.status === "ok") {
    // An undone scan doesn't belong in the recent list.
    if (currentScan?.code === data.code) currentScan = null;
    setInfo(`Undid check-in for ${data.name || data.code}.`, "Undone");
    patchPerson(data.code || code, null);
    renderRecent();
  }
  reloadRoster();
  return data || {};
}

// ---------- Roster tabs ----------
// Search first; below it Not yet (default) · Checked in · All. A–Z views are
// grouped by letter with a pinned header and an A–Z index on the right edge.
// The list is virtualized: only the rows on screen exist in the DOM.

// person id -> "checking" | "done" | "leaving" while a roster check-in plays out.
const rowState = new Map();
const rosterUI = {};

function roleLabelFor(p, role) {
  const otherRoles = roleList(p).filter((r) => r !== role && ROLE_SINGULAR[r]);
  if (role === "hacker" && !otherRoles.length) return "";
  return [role, ...otherRoles].map((r) => ROLE_SINGULAR[r]).join(" + ");
}

function rowSignature(it) {
  const p = it.person;
  return `${p.id}|${p.name}|${p.team}|${p.checked_in_at || ""}|${p.waiver}|${rowState.get(p.id) || ""}|${isSavedCheckIn(p.code) ? "saved" : ""}`;
}

function renderPersonRow(el, it, role) {
  const p = it.person;
  const state = rowState.get(p.id);
  const isIn = p.checked_in && state !== "checking";
  const details = [role === "hacker" ? p.team : "", roleLabelFor(p, role)].filter(Boolean);
  const time = formatTimeShort(p.checked_in_at);
  let action;
  if (state === "checking") {
    action = `<button class="primary row-checkin" type="button" disabled>Checking…</button>`;
  } else if (isIn && (state === "done" || state === "leaving")) {
    action = `<span class="in-badge"><span aria-hidden="true">✓</span> Checked in</span>`;
  } else if (isIn && isSavedCheckIn(p.code)) {
    action = `<span class="in-time is-saved" title="Saved on this phone, will sync">${ICON_SAVED}<span class="visually-hidden">Saved on this phone, will sync. Checked in at</span> ${escapeHtml(time || "")}</span>
       <button class="row-undo" type="button" data-undo="${escapeHtml(p.code)}" aria-label="Undo check-in for ${escapeHtml(p.name)}">Undo</button>`;
  } else if (isIn) {
    action = `<span class="in-time" title="Checked in ${escapeHtml(p.checked_in_at ? new Date(p.checked_in_at).toLocaleString() : "")}"><span aria-hidden="true">✓</span><span class="visually-hidden">Checked in at</span> ${escapeHtml(time || "")}</span>
       <button class="row-undo" type="button" data-undo="${escapeHtml(p.code)}" aria-label="Undo check-in for ${escapeHtml(p.name)}">Undo</button>`;
  } else {
    action = `<button class="primary row-checkin" type="button" data-code="${escapeHtml(p.code)}" aria-label="Check in ${escapeHtml(p.name)}">Check in</button>`;
  }
  el.className = `person ${isIn ? "is-in" : "is-out"}${state ? ` is-${state}` : ""}`;
  el.setAttribute("role", "listitem");
  el.innerHTML = `
    <div class="person-main">
      <div class="person-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
      <div class="person-sub"><code title="${escapeHtml(p.code)}">${escapeHtml(shortCode(p.code))}</code>${details.length ? `<span class="sub-d">${details.map(escapeHtml).join(" · ")}</span>` : ""}${waiverBadge(p.waiver)}</div>
    </div>
    <div class="person-action">${action}</div>`;
}

function renderHeadRow(el, it) {
  el.className = "vhead";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<span>${it.letter}</span>`;
}

function rolePeople(role) {
  return roster.filter((r) => roleList(r).includes(role));
}

function showStatic(ui, html) {
  ui.list.setItems([], { keepAnchor: false });
  ui.staticEl.innerHTML = html;
  ui.staticEl.hidden = false;
  ui.wrap.classList.remove("has-index");
  ui.sticky.hidden = true;
  ui.mode = null;
}

function emptyState(title, detail = "", button = "") {
  return `<div class="empty-state"><span class="empty-glyph" aria-hidden="true"></span><b>${title}</b>${detail ? `<span>${detail}</span>` : ""}${button}</div>`;
}

// The A–Z index only helps on a long, unfiltered A–Z list with room to drag.
function syncLetterIndex(role) {
  const ui = rosterUI[role];
  const h = ui.scroller.clientHeight;
  const show = ui.grouped && !ui.search.value.trim() && document.activeElement !== ui.search && ui.list.total > h * 2.5 && h >= 27 * 11;
  ui.wrap.classList.toggle("has-index", show);
  if (show) {
    const head = ui.list.currentHead();
    ui.index.setCurrent(head == null ? null : ui.list.items[ui.list.headIdx[head]].letter);
  }
}

function renderRoleView(role, { animate = false, restore = false } = {}) {
  const ui = rosterUI[role];
  const filter = statusFilter[role];
  const query = ui.search.value.trim();
  const label = ROLE_LABELS[role].toLowerCase();

  ui.view.querySelectorAll(".chip").forEach((chip) => {
    const active = chip.dataset.filter === filter;
    chip.classList.toggle("active", active && !query);
    chip.setAttribute("aria-pressed", String(active && !query));
  });
  ui.clear.hidden = !query;
  ui.scroller.setAttribute("aria-busy", String(rosterLoading));

  if (rosterLoading) {
    showStatic(
      ui,
      Array.from({ length: 6 }, () => `<div class="person skeleton" aria-hidden="true"><div></div><div></div></div>`).join("") +
        `<span class="visually-hidden">Loading ${label}…</span>`
    );
    return;
  }

  const all = rolePeople(role);
  if (!all.length) {
    showStatic(ui, emptyState(`No ${label} on the ${escapeHtml(currentEvent?.code || "")} roster yet.`, "People appear here once their application is accepted."));
    return;
  }

  let people;
  let grouped = false;
  if (query) {
    people = searchPeople(all, query);
  } else if (filter === "in") {
    people = all.filter((p) => p.checked_in).sort(compareNewestIn);
  } else {
    // A row stays in Not yet while its check-in plays out, then slides away.
    people = (filter === "out" ? all.filter((p) => !p.checked_in || rowState.has(p.id)) : all).sort(compareAZ);
    // Letter groups only pay off on a long list; ~20 mentors read better plain.
    grouped = people.length > 30;
  }

  if (!people.length) {
    const html = query
      ? emptyState(
          `No ${label} match “${escapeHtml(query)}”`,
          `Try the code on their pass, like <code>H042</code> or just <code>42</code>.`,
          `<button class="ghost small" type="button" data-clear>Clear search</button>`
        )
      : filter === "out"
        ? emptyState("Everyone's checked in.", `Every ${ROLE_SINGULAR[role].toLowerCase()} on the roster is here.`)
        : emptyState(`No ${label} checked in yet.`, "Check-ins show up here, newest first.");
    showStatic(ui, html);
    return;
  }

  const items = [];
  let letter = null;
  for (const p of people) {
    if (grouped && p.search.letter !== letter) {
      letter = p.search.letter;
      items.push({ key: `h:${letter}`, type: "head", letter });
    }
    items.push({ key: p.id, type: "row", person: p });
  }

  const mode = `${filter}|${query}`;
  const modeChanged = ui.mode !== mode;
  ui.mode = mode;
  ui.grouped = grouped;
  ui.staticEl.hidden = true;
  ui.staticEl.innerHTML = "";
  ui.scroller.dataset.mode = query ? "search" : filter;
  ui.list.setItems(items, { grouped, animate: animate && !modeChanged, resetScroll: modeChanged && !restore });
  if (restore && !modeChanged && ui.savedScroll) {
    ui.scroller.scrollTop = ui.savedScroll;
    ui.list.render();
  }
  if (grouped) ui.index.setLetters([...new Set(people.map((p) => p.search.letter))]);
  syncLetterIndex(role);
}

let toastTimer = null;
function toast(message, kind = "", action = null) {
  const el = document.getElementById("toast");
  el.innerHTML = `<span class="toast-msg"></span>`;
  el.firstChild.textContent = message;
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      el.hidden = true;
      action.run();
    });
    el.appendChild(btn);
  }
  el.className = `toast ${kind}${action ? " has-action" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, action ? 5000 : 3200);
}

function refreshRosterRows() {
  ROLES.forEach((role) => rosterUI[role].list.refresh());
}

// Check in from the list: the row turns green for a moment, then leaves the
// Not yet view; the toast offers Undo.
async function rosterCheckIn(code) {
  const p = rosterByCode.get(code);
  if (!p || rowState.has(p.id)) return;
  rowState.set(p.id, "checking");
  refreshRosterRows();
  const result = await processCode(code);
  if (result?.status === "ok" || result?.status === "dupe") {
    rowState.set(p.id, "done");
    renderActiveRoleView();
    if (result.status === "ok") {
      const who = result.name || p.name;
      toast(result.queued ? `Checked in ${who} · saved on phone` : `Checked in ${who}`, "success", { label: "Undo", run: () => toastUndo(code) });
    } else {
      toast(`${result.name || p.name} was already checked in`, "warning");
    }
    setTimeout(() => {
      if (rowState.get(p.id) !== "done") return;
      rowState.set(p.id, "leaving");
      refreshRosterRows();
      setTimeout(() => {
        if (rowState.get(p.id) !== "leaving") return;
        rowState.delete(p.id);
        renderActiveRoleView({ animate: true });
      }, 240);
    }, 650);
    return;
  }
  rowState.delete(p.id);
  renderActiveRoleView();
  if (result?.status === "throttled") toast("Just checked that code. Give it a second.");
  else toast(result?.message || "Check-in failed", "error");
}

async function toastUndo(code) {
  const p = rosterByCode.get(code);
  if (p) rowState.delete(p.id);
  // The same code can't go through processCode again for 3 s; undo resets that.
  if (lastScanId === code) lastScanId = null;
  const result = await undoCode(code);
  renderActiveRoleView({ animate: true });
  toastUndoResult(result);
}

function toastUndoResult(result) {
  if (result?.status === "ok") toast(`Undid check-in for ${result.name || result.code}${result.queued ? " · will sync" : ""}`);
  else toast(result?.message || "Undo failed", "error");
}

async function rosterUndo(btn) {
  const code = btn.dataset.undo;
  const person = rosterByCode.get(code);
  const who = person ? `${person.name} (${person.code})` : code;
  if (!window.confirm(`Undo check-in for ${who}?\n\nThey'll be marked as not checked in.`)) return;
  btn.disabled = true;
  if (lastScanId === code) lastScanId = null;
  const result = await undoCode(code);
  renderActiveRoleView({ animate: true });
  toastUndoResult(result);
  if (btn.isConnected) btn.disabled = false;
}

function exportRole(role) {
  const rows = rolePeople(role).sort(compareAZ);
  const withWaiver = rows.some((p) => p.waiver !== "unknown");
  const out = [["Name", "Code", "Email", "Team", "Checked In", "Time", ...(withWaiver ? ["Waiver"] : [])]];
  rows.forEach((p) =>
    out.push([
      p.name,
      p.code,
      p.email || "",
      p.team,
      p.checked_in ? "yes" : "no",
      p.at || "",
      ...(withWaiver ? [p.waiver === "signed" ? "yes" : p.waiver === "missing" ? "no" : ""] : []),
    ])
  );
  const csv = out.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `datahacks-${(currentEvent?.code || "event").toLowerCase()}-${role}s-export.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const ICON_DOWNLOAD =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5M4 14.5V16h12v-1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_SEARCH =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m13.2 13.2 3.3 3.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

ROLES.forEach((role) => {
  const view = document.getElementById("view-" + role);
  const label = ROLE_LABELS[role];
  view.innerHTML = `
    <div class="roster-panel">
      <div class="roster-top">
        <div class="search">
          ${ICON_SEARCH}
          <input id="${role}-search" type="search" placeholder="Name, code or team" aria-label="Search ${label.toLowerCase()} by name, code, email or team"
                 autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
          <button class="search-clear" id="${role}-search-clear" type="button" aria-label="Clear search" hidden>
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>
        <button class="icon-btn glass csv-btn" id="${role}-export-btn" type="button" aria-label="Export ${label.toLowerCase()} as CSV" title="Export CSV">${ICON_DOWNLOAD}</button>
      </div>
      <div class="chips" role="group" aria-label="Show ${label.toLowerCase()}">
        ${STATUS_FILTERS.map(
          ([key, text]) =>
            `<button class="chip${key === "out" ? " active" : ""}" type="button" data-filter="${key}" aria-pressed="${key === "out"}">${text}</button>`
        ).join("")}
      </div>
      <div class="vwrap">
        <div class="person-list" id="${role}-list" role="list" aria-label="${label}">
          <div class="vstatic" hidden></div>
          <div class="vsizer"></div>
        </div>
        <div class="vhead vsticky" aria-hidden="true" hidden></div>
        <div class="az" aria-label="Jump to letter"></div>
        <div class="az-bubble" aria-hidden="true"></div>
      </div>
    </div>
  `;
  const scroller = view.querySelector(".person-list");
  const ui = {
    view,
    scroller,
    wrap: view.querySelector(".vwrap"),
    staticEl: view.querySelector(".vstatic"),
    sticky: view.querySelector(".vsticky"),
    search: document.getElementById(`${role}-search`),
    clear: document.getElementById(`${role}-search-clear`),
    mode: null,
    grouped: false,
    savedScroll: 0,
  };
  ui.list = new VirtualList({
    scroller,
    sizer: view.querySelector(".vsizer"),
    sticky: ui.sticky,
    renderRow: (el, it) => renderPersonRow(el, it, role),
    renderHead: renderHeadRow,
    rowSignature,
  });
  ui.list.onScrollExtra = () => {
    if (view.classList.contains("active")) ui.savedScroll = scroller.scrollTop;
    if (ui.wrap.classList.contains("has-index")) {
      const head = ui.list.currentHead();
      ui.index.setCurrent(head == null ? null : ui.list.items[ui.list.headIdx[head]].letter);
    }
  };
  ui.index = new LetterIndex({
    root: view.querySelector(".az"),
    bubble: view.querySelector(".az-bubble"),
    onJump: (letter) => ui.list.scrollToKey(`h:${letter}`),
  });
  rosterUI[role] = ui;

  const search = ui.search;
  search.addEventListener("input", () => renderRoleView(role));
  // Enter / "Search" on the phone keyboard only closes it: never checks anyone in.
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      search.blur();
    }
  });
  search.addEventListener("focus", () => syncLetterIndex(role));
  search.addEventListener("blur", () => setTimeout(() => syncLetterIndex(role), 50));
  ui.clear.addEventListener("click", () => {
    search.value = "";
    renderRoleView(role);
    search.focus();
  });
  view.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      // While searching the chips don't apply; tapping one leaves the search.
      const hadQuery = !!search.value.trim();
      search.value = "";
      if (statusFilter[role] === chip.dataset.filter && !hadQuery) {
        scroller.scrollTop = 0;
        return;
      }
      statusFilter[role] = chip.dataset.filter;
      renderRoleView(role);
    });
  });
  document.getElementById(`${role}-export-btn`).addEventListener("click", () => exportRole(role));
  scroller.addEventListener("click", (e) => {
    const checkIn = e.target.closest("button[data-code]");
    const undo = e.target.closest("button[data-undo]");
    if (checkIn) rosterCheckIn(checkIn.dataset.code);
    else if (undo) rosterUndo(undo);
    else if (e.target.closest("button[data-clear]")) {
      search.value = "";
      renderRoleView(role);
      search.focus();
    }
  });
  new ResizeObserver(() => {
    if (view.classList.contains("active")) syncLetterIndex(role);
  }).observe(scroller);
});

document.querySelectorAll(".tab-btn").forEach((btn, index) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("active");
      b.removeAttribute("aria-current");
    });
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    btn.setAttribute("aria-current", "page");
    // Slides the selection pill under the tab.
    document.querySelector(".tabs").style.setProperty("--tab-i", String(index));
    const view = document.getElementById("view-" + btn.dataset.view);
    view.classList.add("active");
    if (ROLES.includes(btn.dataset.view)) renderRoleView(btn.dataset.view, { restore: true });
    syncCameraToVisibility();
  });
});

document.getElementById("event-select").addEventListener("change", (e) => {
  switchEvent(e.target.value);
});

document.getElementById("manual-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("manual-input");
  unlockAudio();
  if (!input.value.trim()) return;
  processCode(input.value);
  input.value = "";
});

const SCANNER_MESSAGES = {
  idle: "Camera is off. Start it to scan passes.",
  starting: "Starting camera…",
  paused: "Camera paused. It comes back when you return to this tab.",
};

function setScannerState(state, detail) {
  const frame = document.getElementById("reader-frame");
  const message = document.getElementById("scanner-message");
  const retry = document.getElementById("scanner-retry");
  const startBtn = document.getElementById("start-btn");
  const stopBtn = document.getElementById("stop-btn");

  if (state === "stopped") state = cameraWanted ? "paused" : "idle";
  frame.dataset.state = state;
  if (state === "scanning") frame.dataset.engine = detail?.engine || "";
  message.textContent = state === "error" ? detail?.message || String(detail) : SCANNER_MESSAGES[state] || "";
  retry.hidden = state !== "error";

  const live = state === "starting" || state === "scanning";
  startBtn.disabled = live;
  stopBtn.disabled = !live && !cameraWanted;
  document.getElementById("live-label").textContent = state === "scanning" ? "Scanning" : "Starting";
  syncTorchButton();
  if (state === "error") {
    cameraWanted = false;
    stopBtn.disabled = true;
  }
}

// The preview is a square crop of the camera (decoding still reads the whole
// frame). Pass the stream's aspect ratio to CSS so the video always covers the
// square, portrait (iOS) or landscape, even where object-fit is ignored.
function syncVideoAspect() {
  const video = document.getElementById("scanner-video");
  const frame = document.getElementById("reader-frame");
  // The frame can be taller than wide on roomy screens, so CSS needs both shapes.
  if (frame.clientWidth && frame.clientHeight) frame.style.setProperty("--frame-ar", String(frame.clientWidth / frame.clientHeight));
  if (!video.videoWidth || !video.videoHeight) return;
  frame.style.setProperty("--video-ar", String(video.videoWidth / video.videoHeight));
}
new ResizeObserver(syncVideoAspect).observe(document.getElementById("reader-frame"));
["loadedmetadata", "resize", "playing"].forEach((type) => {
  document.getElementById("scanner-video").addEventListener(type, syncVideoAspect);
});

function getScanner() {
  if (!scanner) {
    const video = document.getElementById("scanner-video");
    video.muted = true;
    scanner = new QrScanner(video, {
      onDecode: (text) => {
        // The Sign now sheet covers the card: don't check anyone in behind it.
        if (isWaiverSheetOpen()) return;
        processCode(text);
      },
      onState: setScannerState,
    });
  }
  return scanner;
}

function scanTabVisible() {
  return document.getElementById("view-scan").classList.contains("active") && document.visibilityState === "visible";
}

function startCamera() {
  cameraWanted = true;
  unlockAudio();
  getScanner().start();
}

// Flashlight button: only shown while scanning on a camera that has a torch.
let torchOn = false;
function syncTorchButton() {
  const btn = document.getElementById("torch-btn");
  const scanning = document.getElementById("reader-frame").dataset.state === "scanning";
  const supported = scanning && !!scanner?.torchSupported;
  if (!supported) torchOn = false;
  btn.hidden = !supported;
  btn.setAttribute("aria-pressed", String(torchOn));
}

document.getElementById("torch-btn").addEventListener("click", async () => {
  if (!scanner) return;
  const next = !torchOn;
  if (await scanner.setTorch(next)) torchOn = next;
  syncTorchButton();
});

function syncSoundButton() {
  const btn = document.getElementById("sound-btn");
  const on = !isMuted();
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? "Scan sounds on" : "Scan sounds off";
}
document.getElementById("sound-btn").addEventListener("click", () => {
  setMuted(!isMuted());
  syncSoundButton();
});
syncSoundButton();

document.getElementById("status-card").addEventListener("click", async (e) => {
  const sign = e.target.closest("button[data-waiver-sign]");
  if (sign) {
    const code = sign.dataset.waiverSign;
    const scan = currentScan?.code === code ? currentScan : null;
    const p = rosterByCode.get(code);
    openWaiverSheet({ code, name: scan?.name || p?.name || code, roles: scan?.roles?.length ? scan.roles : p?.roles || [], waiver: p?.waiver || scan?.waiver || "missing" });
    return;
  }
  const save = e.target.closest("button[data-card-save]");
  if (save) {
    save.disabled = true;
    await saveUnverified(save.dataset.cardSave);
    return;
  }
  const btn = e.target.closest("button[data-card-undo]");
  if (!btn) return;
  btn.disabled = true;
  const code = btn.dataset.cardUndo;
  if (lastScanId === code) lastScanId = null;
  await undoCode(code);
  renderActiveRoleView();
  if (btn.isConnected) btn.disabled = false;
});

function stopCamera() {
  cameraWanted = false;
  if (scanner) scanner.stop();
  else setScannerState("idle");
}

// Release the camera while it can't be seen; bring it back on return.
function syncCameraToVisibility() {
  if (!scanner) return;
  if (cameraWanted && scanTabVisible()) {
    if (!scanner.active) scanner.start();
  } else if (scanner.active) {
    scanner.stop();
  }
}

document.getElementById("start-btn").addEventListener("click", startCamera);
document.getElementById("scanner-retry").addEventListener("click", startCamera);
document.getElementById("stop-btn").addEventListener("click", stopCamera);
document.addEventListener("visibilitychange", syncCameraToVisibility);
window.addEventListener("pagehide", () => {
  if (scanner?.active) scanner.stop();
});

function resetGoogleButton() {
  document.getElementById("google-btn").disabled = false;
  document.getElementById("google-btn-label").textContent = "Sign in with Google";
}

document.getElementById("google-btn").addEventListener("click", async () => {
  const btn = document.getElementById("google-btn");
  setAuthError("");
  btn.disabled = true;
  document.getElementById("google-btn-label").textContent = "Opening Google…";
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    // Always show Google's account picker: phones are often signed in to a
    // personal Google account, which isn't an organizer.
    options: { redirectTo: window.location.origin + window.location.pathname, queryParams: { prompt: "select_account" } },
  });
  // On success the browser is already leaving for Google.
  if (error) {
    resetGoogleButton();
    setAuthError(error.message);
  }
});

// Coming back with the browser's Back button from Google restores the page
// from the back/forward cache with the button still disabled.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) {
    resetGoogleButton();
    syncCameraToVisibility();
  }
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("login-btn");
  const errEl = document.getElementById("auth-error");
  errEl.textContent = "";
  btn.disabled = true;
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  if (error) {
    errEl.textContent = error.message;
    return;
  }
});

document.getElementById("sign-out-btn").addEventListener("click", async () => {
  const unsynced = queue.items.length;
  if (
    unsynced &&
    !window.confirm(
      `${unsynced === 1 ? "1 check-in" : `${unsynced} check-ins`} on this phone ${unsynced === 1 ? "hasn't" : "haven't"} synced yet.\n\nSigning out deletes ${unsynced === 1 ? "it" : "them"}. Sign out anyway?`
    )
  ) {
    return;
  }
  stopCamera();
  const userId = sessionUserId;
  if (attendeesChannel) {
    await supabase.removeChannel(attendeesChannel);
    attendeesChannel = null;
  }
  // Nothing of this organizer's stays on the phone.
  await queue.clear(userId);
  queue.unload();
  await clearUserCache(userId);
  const { error } = await supabase.auth.signOut();
  if (error) {
    // Offline: end the session on this phone only.
    const { error: localError } = await supabase.auth.signOut({ scope: "local" });
    if (localError) {
      try {
        localStorage.removeItem(supabase.auth.storageKey);
      } catch {
        /* ignore */
      }
      signedOut();
    }
  }
});

// Signed in, but not an organizer of any event: sign out on this device only
// (a global sign-out would also end their session on the DataHacks site).
async function rejectNonOrganizer(session) {
  const viaGoogle =
    session.user.app_metadata?.provider === "google" ||
    (session.user.identities || []).some((identity) => identity.provider === "google");
  await supabase.auth.signOut({ scope: "local" });
  setAuthError(viaGoogle ? NOT_ORGANIZER_MESSAGE : NOT_ORGANIZER_PASSWORD_MESSAGE);
}

async function startSession(session) {
  const userId = session.user.id;
  showBoot("Checking organizer access…");
  try {
    const event = await loadEvent(userId);
    // Signed out (or switched account) while this was loading.
    if (sessionUserId !== userId) return;
    if (!event) {
      await rejectNonOrganizer(session);
      return;
    }
    setSessionEmail(session.user.email || "");
    showBoot("Loading roster…");
    requestPersistence();
    // Check-ins saved on this phone apply over the roster as it loads.
    await queue.load(userId);
    if (sessionUserId !== userId) return;
    await loadRoster();
    await subscribeAttendees();
    showApp();
    syncUI.render();
    if (queue.pending.length) queue.flushSoon();
    // Fetch the QR decoder in the background so Start camera is instant.
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 200)))(() => prewarmScanner());
    if (isOffline() && rosterSyncedAt) {
      setInfo(`No connection. Using the roster saved at ${formatTime(rosterSyncedAt)}; check-ins sync when it's back.`, "Offline");
    } else if (roster.length === 0) {
      setInfo("Connected, but the attendees roster is empty. Accept applications after setting events.code so upsert_attendee can fill the table.", "Empty roster");
    } else {
      clearCard();
    }
  } catch (err) {
    sessionUserId = null;
    showBootError(
      `Couldn't reach Supabase.<br><span style="font-size:0.7rem">${escapeHtml(err.message || err)}</span><br><br>Sign in as an organizer, and confirm the check-in SQL has been applied.`
    );
  }
}

// ---------- Offline: sync pill, queue results, reconnect ----------

const syncUI = mountSyncUI({
  onSyncNow: () => queue.flushSoon(),
  onRetry: (id) => queue.retry(id),
  onDismiss: async (id) => {
    const item = queue.items.find((i) => i.id === id);
    await queue.remove(id);
    if (item) toast(`Dismissed ${item.name || item.code}`);
  },
  getRosterSavedAt: () => rosterSyncedAt,
  shortCode,
});

// The server answered a check-in / undo that was saved on this phone.
queue.onSettled = (item, outcome, data) => {
  if (item.eventId !== eventId) return;
  const scans = [currentScan, ...recentScans].filter((s) => s && s.code === item.code && (s.pending || s.kind === "saved-unverified"));
  if (item.op === "check_in") {
    if (outcome === "synced") {
      patchPerson(item.code, data?.checked_in_at || item.at);
      scans.forEach((s) => {
        if (s.kind === "saved-unverified") {
          Object.assign(s, {
            kind: "success",
            name: data?.name || s.name,
            role: roleKey(data?.roles),
            roleText: roleText(data?.roles),
            roles: Array.isArray(data?.roles) ? data.roles : [],
            team: data?.team || "",
            waiver: data && "waiver_signed_at" in data ? waiverState(data) : rosterByCode.get(item.code)?.waiver || "unknown",
          });
        }
        s.pending = false;
        s.inShort = formatTimeShort(data?.checked_in_at) || s.inShort;
        if (s.kind === "success" && data?.checked_in_at) s.bandRight = formatTimeSeconds(new Date(data.checked_in_at));
      });
    } else if (outcome === "already") {
      // Another desk got them first: nothing to do but say so in Recent.
      patchPerson(item.code, data?.checked_in_at || null);
      const since = formatTime(data?.checked_in_at);
      const already = { kind: "warning", pending: false, otherDesk: true, bandRight: since ? `since ${since}` : "", inShort: formatTimeShort(data?.checked_in_at) };
      if (scans.length) {
        scans.forEach((s) => Object.assign(s, already, { name: data?.name || s.name, role: roleKey(data?.roles), roleText: roleText(data?.roles) }));
      } else {
        const p = rosterByCode.get(item.code);
        recentScans = [{ ...scanBase(item.code, p || { name: data?.name || item.name, roles: data?.roles }, data?.checked_in_at), ...already }, ...recentScans].slice(0, RECENT_MAX);
      }
    } else if (outcome === "attention") {
      const p = rosterByCode.get(item.code);
      if (p && p.checked_in_at === item.at) patchPerson(item.code, null);
      scans.forEach((s) => Object.assign(s, { kind: "error", pending: false, role: "none", hint: "server says not on the roster" }));
    }
  } else if (outcome === "undone") {
    const p = rosterByCode.get(item.code);
    if (p && !savedOp(item.code)) patchPerson(item.code, null);
  }
  if (currentScan && scans.includes(currentScan)) showScan(currentScan, { quiet: true });
  renderRecent();
  scheduleRosterRender();
};

queue.onDrained = (synced) => {
  if (synced) syncUI.flashSynced();
  reloadRoster();
};

// Back online (or the server answered again): resubscribe to other desks'
// changes, refetch the roster so everything converges, send what's waiting.
let reconnectTimer = null;
function reconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!sessionUserId || !eventId || rosterLoading) return;
    queue.flushSoon();
    subscribeAttendees().catch((err) => console.error(err));
    reloadRoster();
  }, 250);
}

onNetChange((reason) => {
  syncUI.render();
  if (reason === "online" || reason === "reconnected") reconnect();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !sessionUserId) return;
  if (queue.pending.length) queue.flushSoon();
  else if (isOffline()) reloadRoster();
});

// Connected to Wi-Fi but the server isn't answering, nothing waiting: check
// every 15 s so the pill clears (and the roster catches up) once it's back.
// With items waiting, the queue's own retries do this.
setInterval(() => {
  if (!sessionUserId || !eventId || rosterLoading || queue.pending.length) return;
  if (isOffline() && navigator.onLine !== false) reloadRoster();
}, 15000);

registerServiceWorker({
  onUpdateReady: (apply) => toast("A new version of Check-In is ready.", "", { label: "Reload", run: apply }),
});

function signedOut() {
  eventId = null;
  currentEvent = null;
  events = [];
  setRoster([]);
  rosterLoading = true;
  rosterSyncedAt = null;
  currentScan = null;
  recentScans = [];
  renderRecent();
  clearCard();
  sessionUserId = null;
  queue.unload();
  syncUI.close();
  setSessionEmail("");
  resetGoogleButton();
  showAuth();
}

// supabase-js reports no session at startup when the access token has
// expired and it can't refresh it (no network), but it keeps the session in
// storage for later. Use it so an organizer can keep checking people in; the
// token refreshes once the connection is back.
function storedSession() {
  try {
    const stored = JSON.parse(localStorage.getItem(supabase.auth.storageKey) || "null");
    return stored?.user?.id && stored.refresh_token ? stored : null;
  } catch {
    return null;
  }
}

// With an expired token and no network, supabase-js keeps retrying the
// refresh for ~30 s before it reports anything. Don't make the desk wait:
// after a moment, carry on with the stored session.
let authReported = false;
if (storedSession()) {
  showBoot("Restoring your session…");
  const stored = storedSession();
  if (!stored.expires_at || stored.expires_at * 1000 < Date.now() + 60000) {
    setTimeout(() => {
      const again = storedSession();
      if (authReported || sessionUserId || !again) return;
      sessionUserId = again.user.id;
      startSession(again);
    }, 2500);
  }
}

supabase.auth.onAuthStateChange((event, session) => {
  authReported = true;
  // The first event (INITIAL_SESSION) comes after supabase-js has finished
  // reading any sign-in result from the URL.
  cleanAuthUrl();
  if (!session && event === "INITIAL_SESSION") session = storedSession();
  if (!session) {
    signedOut();
    return;
  }
  // Token refreshes and tab refocus re-emit the session; keep the selected event.
  if (session.user.id === sessionUserId) return;
  sessionUserId = session.user.id;
  startSession(session);
});

if (oauthError) setAuthError(`Google sign-in didn't finish: ${oauthError}`);

