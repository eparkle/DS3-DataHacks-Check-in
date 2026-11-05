import { supabase } from "./supabase.js";
import { QrScanner, prewarm as prewarmScanner } from "./scanner.js";
import { feedback, unlockAudio, isMuted, setMuted } from "./feedback.js";
import { searchIndex, searchPeople, compareAZ, compareNewestIn, VirtualList, LetterIndex } from "./roster.js";
import { waiverState, waiverBadge, openWaiverSheet, syncWaiverSheet, isWaiverSheetOpen, prewarmWaiverQr, setWaiverMarkHandler } from "./waiver.js";
import {
  queue,
  callRpc,
  callRpcCompat,
  isMissingApi,
  newClientId,
  timedQuery,
  isOffline,
  onNetChange,
  saveRosterCache,
  loadRosterCache,
  saveEventsCache,
  loadEventsCache,
  clearUserCache,
} from "./offline.js";
import { requestPersistence } from "./offline-store.js";
import { mountSyncUI, ICON_SAVED } from "./sync-ui.js";
import {
  CHECK_IN,
  scanTypes,
  currentMode,
  currentScanType,
  isScanMode,
  setMode,
  resetForEvent,
  loadScanTypes,
  loadScanLog,
  knownScan,
  rememberScan,
  ensureNames,
  nameOf,
  onNamesChanged,
  clearModes,
} from "./modes.js";
import { describeLookup, walkInOutcome } from "./walkin.js";
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
let lastScanKey = null;
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
    checked_in_by: row.checked_in_by || null,
    // School / organization and the 18+ check, when the database has them.
    idc: idInfo(row, roles),
    // The row as the database sent it, for the copy saved on this phone.
    row,
  };
  person.search = searchIndex(person);
  return person;
}

// What the desk shows for an ID check: { affiliation, age } where age is
// "ok" (18+ on the event day), "under", "unknown" (no birthdate on file), or
// null (not a hacker, or a database without the column yet).
function idInfo(src, roles) {
  if (!src || typeof src !== "object") return null;
  const hasAge = "is_18_plus_on_event_day" in src;
  if (!hasAge && !("affiliation" in src)) return null;
  const affiliation = String(src.affiliation || "").trim();
  const hacker = Array.isArray(roles) && roles.includes("hacker");
  const v = src.is_18_plus_on_event_day;
  const age = !hasAge || !hacker ? null : v === true ? "ok" : v === false ? "under" : "unknown";
  return affiliation || age ? { affiliation, age } : null;
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
// by: who checked them in (undefined keeps what's there).
function patchPerson(code, checkedInAt, by) {
  const p = rosterByCode.get(String(code || "").toUpperCase());
  if (!p) return;
  setPersonIn(p, checkedInAt, by);
  persistRosterSoon();
}

function setPersonIn(p, checkedInAt, by) {
  p.checked_in = !!checkedInAt;
  p.checked_in_at = checkedInAt || null;
  p.at = formatTime(checkedInAt);
  if (!checkedInAt) p.checked_in_by = null;
  else if (by !== undefined) p.checked_in_by = by;
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
    if (i.op === "check_in" && !p.checked_in) setPersonIn(p, i.at, sessionUserId);
    else if (i.op === "undo" && p.checked_in) setPersonIn(p, null);
  });
}

const rowForCache = (p) => ({ ...p.row, checked_in_at: p.checked_in_at || null, ...("checked_in_by" in p.row ? { checked_in_by: p.checked_in_by || null } : {}) });

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
  // A new event always starts on Check-in.
  resetForEvent(sessionUserId, next.id, { keepStored: false });
  renderModeControl();
  setRoster([]);
  rosterLoading = true;
  lastScanKey = null;
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
    await refreshScanTypes();
    clearCard();
  } catch (err) {
    rosterLoading = false;
    renderActiveRoleView();
    setFailure(`Couldn't load ${next.code}`, err.message || err);
  } finally {
    select.disabled = events.length < 2;
  }
}

const ROSTER_COLUMNS = "id, event_id, code, name, email, roles, team, checked_in_at, checked_in_by";
// Columns newer site migrations add. When the database says one isn't there
// (42703 / PGRST204), the roster loads without that group, and remembers.
const OPTIONAL_COLUMNS = [
  ["affiliation", "is_18_plus_on_event_day"], // check-in log + scans migration
  ["waiver_signed_at"], // waivers migration
];
let optionalColumns = OPTIONAL_COLUMNS.map((g) => g.slice());
const isMissingColumn = (error) => error?.code === "42703" || error?.code === "PGRST204";

// Resolves to timedQuery's { kind: "ok" | "transient" | "error", ... }.
async function fetchRoster(id) {
  for (;;) {
    const columns = [ROSTER_COLUMNS, ...optionalColumns.flat()].join(", ");
    const res = await timedQuery(() => supabase.from("attendees").select(columns).eq("event_id", id).order("code"));
    if (res.kind !== "error" || !isMissingColumn(res) || !optionalColumns.length) return res;
    const i = optionalColumns.findIndex((g) => g.some((c) => (res.message || "").includes(c)));
    optionalColumns.splice(i >= 0 ? i : 0, 1);
  }
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
    ensureNames(roster.map((p) => p.checked_in_by));
    refreshScanTypesSoon();
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
    ensureNames([next.checked_in_by]);
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

// ---------- Mode: Check-in or a meal / swag scan type ----------

function renderModeControl() {
  const types = scanTypes();
  const chip = document.getElementById("mode-chip");
  const select = document.getElementById("mode-select");
  const frame = document.getElementById("reader-frame");
  const type = currentScanType();
  chip.hidden = !types.length;
  frame.classList.toggle("has-modes", types.length > 0);
  frame.dataset.mode = type ? "scan" : "checkin";
  document.querySelector(".scan-panel").dataset.mode = type ? "scan" : "checkin";
  select.innerHTML =
    `<option value="${CHECK_IN}">Check-in</option>` +
    types.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`).join("");
  select.value = type ? type.id : CHECK_IN;
  const label = type ? type.label : "Check-in";
  document.getElementById("mode-label").textContent = label;
  chip.title = type ? `Scans record ${label} (not check-ins). Tap to change.` : "Scans check people in. Tap to record a meal or swag instead.";
  document.getElementById("manual-btn").textContent = type ? "Record" : "Check in";
}

// Scan types (and, in a scan mode, who already had it) from the server, or
// the copies saved on this phone. At most once a minute from roster reloads.
async function refreshScanTypes() {
  lastTypesRefresh = Date.now();
  await loadScanTypes();
  renderModeControl();
  const type = currentScanType();
  if (type) await loadScanLog(type.id);
}
let lastTypesRefresh = 0;
function refreshScanTypesSoon() {
  if (Date.now() - lastTypesRefresh < 60000) return;
  refreshScanTypes().catch((err) => console.error(err));
}

document.getElementById("mode-select").addEventListener("change", (e) => {
  const mode = setMode(e.target.value);
  lastScanKey = null;
  renderModeControl();
  const type = currentScanType();
  if (type) {
    loadScanLog(type.id).catch((err) => console.error(err));
    setInfo(`Scans now record ${type.label}, not check-ins. Switch back to Check-in for arrivals.`, type.label);
  } else if (mode === CHECK_IN) {
    setInfo("Scans check people in.", "Check-in");
  }
});

onNamesChanged(() => scheduleRosterRender());

// ---------- Scan result card ----------
// One fixed-height card under the camera: a coloured band (state + time) over
// an end-stone body (role tile, name, code · role · team, Undo). A meal /
// swag scan (mode) gets an indigo accent and names the scan type in the band,
// so it can't be read as a check-in.

const BAND = {
  success: { icon: "✓", label: "Checked in" },
  warning: { icon: "↺", label: "Already in" },
  error: { icon: "✕", label: "Not on roster" },
  // Offline, and the code isn't in the roster saved on this phone.
  unverified: { icon: "?", label: "Can't verify offline", card: "warning" },
  // ...and the organizer saved it anyway.
  "saved-unverified": { icon: "?", label: "Saved · will verify", card: "warning" },
  // Meal / swag scans: the band names the scan type.
  "scan-ok": { icon: "✓", card: "scan" },
  "scan-already": { icon: "↺", card: "warning" },
  "scan-nci": { icon: "!", label: "Not checked in yet", card: "warning" },
  // Not on the roster, with the reason (lookup_not_on_roster).
  lookup: { icon: "!" },
};

const UNKNOWN_KINDS = new Set(["error", "unverified", "saved-unverified", "lookup"]);

function bandLabel(scan) {
  if (scan.kind === "scan-ok") return scan.mode.label;
  if (scan.kind === "scan-already") return `Already had ${scan.mode.label}`;
  if (scan.kind === "lookup") return scan.lookup.band;
  return BAND[scan.kind].label;
}

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

// "18+" / "Check ID · age unknown" / "Under 18", then school or organization.
function idLine(idc) {
  if (!idc) return "";
  const age =
    idc.age === "ok"
      ? `<span class="age age-ok"><span class="visually-hidden">Age: </span>18+</span>`
      : idc.age === "under"
        ? `<span class="age age-under">Under 18</span>`
        : idc.age === "unknown"
          ? `<span class="age age-unk">Check ID: age unknown</span>`
          : "";
  const aff = idc.affiliation ? `<span class="aff" title="${escapeHtml(idc.affiliation)}">${escapeHtml(idc.affiliation)}</span>` : "";
  return age || aff ? `<div class="idl">${age}${aff}</div>` : "";
}

function showScan(scan, { quiet = false } = {}) {
  const band = BAND[scan.kind];
  const unknown = UNKNOWN_KINDS.has(scan.kind);
  const isScanMode = !!scan.mode;
  let action = "";
  if (!isScanMode && (scan.kind === "success" || scan.kind === "saved-unverified")) {
    action = `<button class="undo-btn" type="button" data-card-undo="${escapeHtml(scan.code)}" aria-label="Undo check-in for ${escapeHtml(scan.name)}">Undo</button>`;
  } else if (scan.kind === "unverified") {
    action = `<button class="undo-btn" type="button" data-card-save="${escapeHtml(scan.code)}" aria-label="Save ${escapeHtml(scan.code)} anyway; it's checked against the roster when back online">Save anyway</button>`;
  } else if (scan.kind === "lookup" && scan.lookup.walkIn && scan.applicationId) {
    const label = scan.lookup.reason === "no_show" ? "Let in" : "Accept walk-in";
    action = `<button class="undo-btn walkin-btn" type="button" data-walkin="${escapeHtml(scan.applicationId)}" aria-label="${label}: ${escapeHtml(scan.name)}">${label}</button>`;
  }
  let metaParts;
  if (unknown) metaParts = [scan.hint];
  else if (scan.kind === "scan-already") metaParts = [scan.byText, scan.roleText];
  else if (scan.kind === "scan-nci") metaParts = ["recorded"];
  else metaParts = [scan.roleText, scan.team, scan.kind === "warning" ? (scan.otherDesk ? "checked in at another desk" : "no action taken") : ""];
  metaParts = metaParts.filter(Boolean);
  // Waiver on file or not (check-ins only; nothing when the database can't
  // say). It sits at the end of the meta line and never truncates; the code
  // goes short to make room. Offline, it comes from the roster saved on this phone.
  const waiver = unknown || isScanMode ? "" : waiverBadge(scan.waiver, { code: scan.code, name: scan.name, button: true });
  const code = waiver || scan.kind === "lookup" ? shortCode(scan.code) : scan.code;
  // Who to check ID for: a fresh check-in only.
  const id = !isScanMode && scan.kind === "success" ? idLine(scan.idc) : "";
  // Saved on this phone: a quiet cloud-and-clock mark instead of the time.
  const bandRight = scan.pending
    ? `<span class="band-saved">${ICON_SAVED}<span class="band-saved-long">Saved on phone · will sync</span><span class="band-saved-short">Will sync</span></span>`
    : escapeHtml(scan.bandRight);
  const savedNote = scan.pending ? `<span class="visually-hidden">Saved on this phone, will sync.</span>` : "";
  const modeNote = isScanMode && scan.kind !== "scan-ok" && scan.kind !== "scan-already" ? `<span class="visually-hidden">${escapeHtml(scan.mode.label)} scan.</span>` : "";
  const cardKind = (scan.kind === "lookup" ? scan.lookup.card : band.card || scan.kind) + (isScanMode ? " mode-scan" : "");
  const name = scan.kind === "error" ? "Unknown code" : scan.kind === "lookup" ? scan.name : unknown ? "Not found" : scan.name;
  renderCard(
    cardKind,
    `<div class="band"><span class="band-title"><span aria-hidden="true">${band.icon}</span> ${escapeHtml(bandLabel(scan))}</span><span class="band-time">${bandRight}</span>${savedNote}${modeNote}</div>
     <div class="body${id ? " has-id" : ""}">
       <div class="avatar role-${unknown ? "none" : scan.role}" aria-hidden="true">${escapeHtml(unknown && scan.kind !== "lookup" ? "?" : initials(name))}</div>
       <div class="who">
         <div class="name">${escapeHtml(name)}</div>
         <div class="meta">${scan.code ? `<code title="${escapeHtml(scan.code)}">${escapeHtml(code)}</code>` : ""}<span class="meta-text">${metaParts.map((p, i) => `${i || scan.code ? " · " : ""}${escapeHtml(p)}`).join("")}</span>${waiver}</div>
         ${id}
       </div>
       ${action}
     </div>`,
    { quiet }
  );
  document.getElementById("status-card").dataset.scan = scan.code;
  if (scan.waiver === "missing" && !isScanMode) prewarmWaiverQr();
}

// The previous result moves into the recent list when a new one arrives.
function pushScan(scan) {
  if (currentScan) recentScans = [currentScan, ...recentScans].slice(0, RECENT_MAX);
  currentScan = scan;
  showScan(scan);
  renderRecent();
}

function recentStatus(scan, kind) {
  const vh = (t) => `<span class="visually-hidden">${escapeHtml(t)}</span>`;
  const t = (icon, hidden, time, extra = "") => `<span class="t">${icon}${vh(hidden)} ${escapeHtml(time || "")}${extra}</span>`;
  const mark = (c) => `<span aria-hidden="true">${c}</span>`;
  if (kind === "undone") return `<span class="t">undone</span>`;
  if (scan.mode) {
    const label = scan.mode.label;
    const what = scan.kind === "scan-ok" ? `${label},` : scan.kind === "scan-already" ? `Already had ${label} at` : scan.kind === "scan-nci" ? `${label} recorded, not checked in,` : scan.kind === "error" ? `${label}: not on roster,` : `${label}: not verified,`;
    const icon = scan.pending ? ICON_SAVED : mark(BAND[scan.kind]?.icon || "?");
    return `<span class="mt" aria-hidden="true">${escapeHtml(label)}</span>${t(icon, what, scan.kind === "scan-already" ? scan.inShort : scan.timeShort)}`;
  }
  if (scan.kind === "lookup") return t(mark("!"), `${scan.lookup.band},`, scan.timeShort);
  if (kind === "error") return t(mark("✕"), "Unknown code,", scan.timeShort);
  if (UNKNOWN_KINDS.has(scan.kind))
    return t(scan.kind === "saved-unverified" ? ICON_SAVED : mark("?"), scan.kind === "saved-unverified" ? "Saved on this phone, not verified," : "Couldn't verify offline,", scan.timeShort);
  if (kind === "warning") return t(mark("↺"), "Already in since", scan.inShort || scan.timeShort);
  if (scan.pending) return t(ICON_SAVED, "Saved on this phone, will sync, checked in", scan.inShort || scan.timeShort);
  return t(mark("✓"), "Checked in", scan.inShort || scan.timeShort);
}

function renderRecent() {
  const list = document.getElementById("recent-list");
  if (!list) return;
  document.getElementById("recent").classList.toggle("empty", !recentScans.length);
  list.innerHTML = recentScans
    .map((scan) => {
      const person = rosterByCode.get(scan.code);
      const unknown = UNKNOWN_KINDS.has(scan.kind);
      const undone =
        !scan.mode &&
        ((scan.kind === "saved-unverified" && !savedOp(scan.code)) || (!unknown && person && !person.checked_in));
      const kind = undone
        ? "undone"
        : scan.kind === "scan-ok"
          ? "scan"
          : scan.kind === "scan-already" || scan.kind === "scan-nci"
            ? "warning"
            : scan.kind === "lookup"
              ? scan.lookup.card
              : unknown && scan.kind !== "error"
                ? "warning"
                : scan.kind;
      const name = scan.kind === "error" ? "Unknown code" : scan.kind === "lookup" ? scan.name : unknown ? "Not verified" : scan.name;
      return `<li class="recent-row is-${kind}${scan.pending ? " is-pending" : ""}${scan.mode ? " is-mode" : ""}">
        <span class="sq role-${unknown ? "none" : scan.role}" aria-hidden="true"></span>
        <span class="nm">${escapeHtml(name)}</span>
        <code>${escapeHtml(shortCode(scan.code))}</code>${recentStatus(scan, kind)}</li>`;
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

// kind: success | warning | error | scan (a meal / swag recorded: indigo glow, success sound)
function announce(kind) {
  flashFrame(kind);
  feedback(kind === "scan" ? "success" : kind);
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
    // Offline: waiver and ID check from the roster saved on this phone.
    waiver: person?.waiver || "unknown",
    idc: person?.idc || null,
  };
}

// Fields from a check_in_by_code / record_scan answer.
function baseFromData(data, code) {
  const c = (data?.code || code).toUpperCase();
  const known = rosterByCode.get(c);
  return {
    code: c,
    name: data?.name || known?.name || code,
    role: roleKey(data?.roles || known?.roles),
    roleText: roleText(data?.roles || known?.roles),
    team: data?.team || known?.team || "",
    timeShort: formatTimeShort(new Date().toISOString()),
    inShort: formatTimeShort(data?.checked_in_at),
    roles: Array.isArray(data?.roles) ? data.roles : known?.roles || [],
    // From check_in_by_code when the database has waivers, else the roster's copy.
    waiver: data && "waiver_signed_at" in data ? waiverState(data) : known?.waiver || "unknown",
    idc: (data && idInfo(data, data.roles || known?.roles)) || known?.idc || null,
  };
}

function eventCodeHint(code) {
  const prefix = (code.match(/^([A-Z0-9]{2,10})-[HJMB]\d+$/) || [])[1] || "";
  const eventCode = (currentEvent?.code || "").toUpperCase();
  return { prefix, eventCode, wrongEvent: !!(prefix && eventCode && prefix !== eventCode) };
}

// Queue fields, with the client id of an attempt that may have landed (the
// database recognises it on the retry).
function withClientId(fields, clientId) {
  return clientId ? { ...fields, id: clientId } : fields;
}

// No answer from the server: decide with the roster saved on this phone.
// clientId: the id the failed request went out with (it may have landed).
async function checkInOffline(raw, code, clientId = null) {
  const p = rosterByCode.get(code);
  if (!p) {
    const { prefix, eventCode, wrongEvent } = eventCodeHint(code);
    const hint = wrongEvent ? `this pass is for ${prefix}, not ${eventCode}` : rosterSyncedAt ? `roster saved ${formatTime(rosterSyncedAt)}` : "no saved roster";
    pushScan({ ...scanBase(code, null), kind: "unverified", hint, bandRight: eventCode, clientId });
    announce("warning");
    return { status: "unverified", message: `Can't verify "${raw}" offline` };
  }
  if (p.checked_in) {
    const since = formatTime(p.checked_in_at);
    pushScan({ ...scanBase(code, p, p.checked_in_at), kind: "warning", pending: isSavedCheckIn(code), bandRight: since ? `since ${since}` : "" });
    announce("warning");
    return { status: "dupe", name: p.name, code, checked_in_at: p.checked_in_at };
  }
  const item = await queue.add(withClientId({ op: "check_in", eventId, code, name: p.name, roles: p.roles, team: p.team || "" }, clientId));
  patchPerson(code, item.at, sessionUserId);
  pushScan({ ...scanBase(code, p, item.at), kind: "success", pending: true, bandRight: formatTimeSeconds(new Date(item.at)) });
  announce("success");
  return { status: "ok", queued: true, name: p.name, code, checked_in_at: item.at };
}

// "Save anyway" on a code that isn't in the saved roster: the server decides later.
async function saveUnverified(code) {
  const scan = currentScan?.code === code && currentScan.kind === "unverified" ? currentScan : null;
  if (!scan) return;
  if (scan.mode) {
    if (queue.scanFor(eventId, code, scan.mode.id)) return;
    await queue.add(withClientId({ op: "scan", eventId, code, name: code, roles: [], team: "", scanTypeId: scan.mode.id, label: scan.mode.label, unverified: true }, scan.clientId));
  } else {
    if (savedOp(code)) return;
    await queue.add(withClientId({ op: "check_in", eventId, code, name: code, roles: [], team: "", unverified: true }, scan.clientId));
  }
  Object.assign(scan, { kind: "saved-unverified", hint: "checked against the roster once online" });
  showScan(scan);
  renderRecent();
}

// ---------- Meal / swag scans ----------

const modeOf = (t) => ({ id: t.id, label: t.label, kind: t.kind });

// "by Evan" / "by you" / "on this phone"
function byText(byId, byName) {
  if (byId && byId === sessionUserId) return "by you";
  const n = byName || nameOf(byId);
  return n ? `by ${n}` : "";
}

function showAlreadyScanned(code, person, mode, first) {
  const at = first?.at || null;
  pushScan({
    ...scanBase(code, person, at),
    mode,
    kind: "scan-already",
    pending: false,
    byText: first?.pending ? "saved on this phone" : byText(first?.by, first?.byName),
    bandRight: formatTime(at) || "",
  });
  announce("warning");
  return { status: "already", name: person?.name || code, code };
}

// Offline (or no answer): record it on this phone, deduped against what this phone knows.
async function scanOffline(raw, code, mode, clientId = null) {
  const p = rosterByCode.get(code);
  if (!p) {
    const { prefix, eventCode, wrongEvent } = eventCodeHint(code);
    const hint = wrongEvent ? `this pass is for ${prefix}, not ${eventCode}` : rosterSyncedAt ? `roster saved ${formatTime(rosterSyncedAt)}` : "no saved roster";
    pushScan({ ...scanBase(code, null), mode, kind: "unverified", hint, bandRight: mode.label, clientId });
    announce("warning");
    return { status: "unverified", message: `Can't verify "${raw}" offline` };
  }
  const item = await queue.add(withClientId({ op: "scan", eventId, code, name: p.name, roles: p.roles, team: p.team || "", scanTypeId: mode.id, label: mode.label }, clientId));
  const nci = !p.checked_in;
  pushScan({ ...scanBase(code, p, item.at), mode, kind: nci ? "scan-nci" : "scan-ok", pending: true, bandRight: nci ? mode.label : formatTimeSeconds(new Date(item.at)) });
  announce(nci ? "warning" : "scan");
  return { status: nci ? "not_checked_in" : "ok", queued: true, name: p.name, code };
}

async function processScan(raw, code, type) {
  const mode = modeOf(type);
  const person = rosterByCode.get(code);
  // Already had it, as far as this phone knows (a scan can't be undone, so this is final).
  const known = knownScan(type.id, code);
  if (known) return showAlreadyScanned(code, person, mode, known);
  const saved = queue.scanFor(eventId, code, type.id);
  if (saved) return showAlreadyScanned(code, person, mode, { at: saved.at, pending: true });
  if (isOffline()) return scanOffline(raw, code, mode);

  setInfo(`Looking up ${code}…`, mode.label);
  const clientId = newClientId();
  const result = await callRpc("record_scan", {
    p_event_id: eventId,
    p_code: code,
    p_scan_type_id: type.id,
    p_scanned_at: new Date().toISOString(),
    p_client_id: clientId,
    p_source: "online",
  });
  if (result.kind === "transient") return scanOffline(raw, code, mode, clientId);
  if (result.kind === "error") {
    const message = isMissingApi(result) ? "This database can't record meal or swag scans yet." : result.message;
    setFailure(`${mode.label} not recorded`, message);
    announce("error");
    return { status: "error", message };
  }
  const data = result.data || {};
  const base = baseFromData(data, code);
  if (data.status === "not_on_roster" || data.status === "unknown") {
    const { prefix, eventCode, wrongEvent } = eventCodeHint(code);
    pushScan({ ...base, code, mode, kind: "error", role: "none", hint: wrongEvent ? `this pass is for ${prefix}, not ${eventCode}` : `not on the ${eventCode} roster`, bandRight: mode.label });
    announce("error");
    return { status: "not_on_roster" };
  }
  if (data.status === "already") {
    rememberScan(type.id, base.code, data.first_scanned_at, null, data.by_name);
    return showAlreadyScanned(base.code, rosterByCode.get(base.code) || base, mode, { at: data.first_scanned_at, byName: data.by_name });
  }
  if (data.status === "ok" || data.status === "not_checked_in") {
    rememberScan(type.id, base.code, data.scanned_at, sessionUserId);
    const nci = data.status === "not_checked_in";
    pushScan({ ...base, mode, kind: nci ? "scan-nci" : "scan-ok", bandRight: nci ? mode.label : formatTimeSeconds(data.scanned_at ? new Date(data.scanned_at) : new Date()) });
    announce(nci ? "warning" : "scan");
    return data;
  }
  setFailure("Unexpected response", JSON.stringify(data));
  announce("error");
  return data;
}

// ---------- Not on the roster: why, and walk-ins ----------

// Asks lookup_not_on_roster why this didn't check in, and shows it. Falls
// back to the plain "not on roster" card (older database, or no answer).
async function showNotOnRoster(raw, code, fallback) {
  const { eventCode } = eventCodeHint(code);
  const res = await callRpc("lookup_not_on_roster", { p_event_id: eventId, p_code_or_email: raw.includes("@") ? raw : code });
  if (res.kind !== "ok" || !res.data?.reason) return fallback();
  const info = res.data;
  if (info.reason === "unknown_code") return fallback();
  const lookup = { ...describeLookup(info, eventCode), reason: info.reason };
  const shown = (info.code || code).toUpperCase();
  pushScan({
    ...scanBase(shown, null),
    code: info.code ? shown : raw.includes("@") ? "" : shown,
    name: info.name || raw,
    kind: "lookup",
    lookup,
    applicationId: info.application_id || null,
    hint: lookup.line,
    bandRight: eventCode,
  });
  announce(lookup.card === "error" ? "error" : "warning");
  return { status: "unknown", message: `${info.name || raw}: ${lookup.line}` };
}

// ---------- Waiver: "They showed me the signed confirmation" ----------
// mark_waiver_seen (site migration *_waiver_powerform) records a waiver the
// desk saw DocuSign's completion email for. Online only. Whether this database
// has it is asked once per event: a call without a person changes nothing and
// answers 22004; an older database answers PGRST202 and the button stays hidden.
const waiverMarkSupport = new Map(); // eventId -> true | false

async function canMarkWaiver() {
  const id = eventId;
  if (!id || isOffline()) return false;
  if (waiverMarkSupport.has(id)) return waiverMarkSupport.get(id);
  const res = await callRpc("mark_waiver_seen", { p_event_id: id, p_person_id: null, p_note: null });
  if (res.kind === "transient") return false; // ask again next time
  const ok = res.kind === "error" && res.code === "22004";
  waiverMarkSupport.set(id, ok);
  return ok;
}

const MARK_REFUSED = {
  not_found: "They aren't on this event's roster.",
  not_accepted: "Their application isn't accepted.",
  no_account: "They have no portal account, so there's nothing to attach a waiver to. Ask an organizer.",
};

async function markWaiverSigned(person) {
  const p = rosterByCode.get(person.code);
  if (!p?.id) return { ok: false, message: "They aren't on the roster loaded on this phone." };
  if (isOffline()) return { ok: false, message: "Marking a waiver needs a connection. Try again once you're back online." };
  const res = await callRpc("mark_waiver_seen", {
    p_event_id: eventId,
    p_person_id: p.id,
    p_note: "Showed DocuSign completion email at check-in",
  });
  if (res.kind === "transient") return { ok: false, message: "Couldn't reach the server. Try again." };
  if (isMissingApi(res)) {
    waiverMarkSupport.set(eventId, false);
    return { ok: false, message: "This database can't mark waivers yet." };
  }
  if (res.kind === "error") return { ok: false, message: res.message };
  const status = res.data?.status;
  if (status !== "marked" && status !== "already_on_file") return { ok: false, message: MARK_REFUSED[status] || "Couldn't mark it." };
  reloadRoster();
  return { ok: true, message: status === "already_on_file" ? "Already on file. Updating…" : "Marked. Updating…" };
}

setWaiverMarkHandler({ canMark: canMarkWaiver, mark: markWaiverSigned });

async function acceptWalkIn(btn) {
  const applicationId = btn.dataset.walkin;
  const scan = currentScan?.kind === "lookup" && currentScan.applicationId === applicationId ? currentScan : null;
  const name = scan?.name || "this person";
  if (isOffline()) {
    toast("Walk-ins need a connection. Try again once you're back online.", "warning");
    return;
  }
  const readmit = scan?.lookup?.reason === "no_show";
  const ok = window.confirm(
    readmit
      ? `Let ${name} in?\n\nThey were marked a no-show. This takes one open hacker spot, then checks them in.`
      : `Accept ${name} as a walk-in?\n\nThis accepts their application into one open hacker spot, then checks them in.`
  );
  if (!ok) return;
  btn.disabled = true;
  const res = await callRpc("accept_walk_in", { p_event_id: eventId, p_application_id: applicationId });
  if (btn.isConnected) btn.disabled = false;
  if (res.kind === "transient") {
    toast("Walk-ins need a connection. Try again once you're back online.", "warning");
    return;
  }
  if (res.kind === "error") {
    setFailure("Walk-in failed", res.message);
    announce("error");
    return;
  }
  const outcome = walkInOutcome(res.data);
  if (!outcome.ok) {
    if (scan) {
      scan.lookup = { ...scan.lookup, band: outcome.title, card: "warning", walkIn: false };
      scan.hint = outcome.line;
      showScan(scan);
      renderRecent();
    } else setFailure(outcome.title, outcome.line);
    announce("warning");
    return;
  }
  const code = String(res.data.code || "").toUpperCase();
  if (!code) {
    setFailure("Walk-in accepted", "No check-in code yet. Reload the roster and check them in from the list.");
    reloadRoster();
    return;
  }
  // Accepted: check them in now (and the roster picks up their new row).
  if (currentScan === scan) currentScan = null;
  lastScanKey = null;
  await processCode(code, { mode: CHECK_IN });
  reloadRoster();
}

// ---------- Scan / type a code ----------

async function processCode(rawText, { mode = currentMode() } = {}) {
  const raw = String(rawText || "").trim();
  const code = resolveCode(raw);
  const now = Date.now();
  if (!code) return;
  const type = mode !== CHECK_IN ? currentScanType() : null;
  const key = `${type?.id || CHECK_IN}|${code}`;
  if (key === lastScanKey && now - lastScanTime < 3000) return { status: "throttled" };
  lastScanKey = key;
  lastScanTime = now;

  if (type) return processScan(raw, code, type);

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

  // The same id goes with the queued retry if this gets no answer, so the
  // database won't count it twice.
  const clientId = newClientId();
  const result = await callRpcCompat(
    "check_in_by_code",
    { p_event_id: eventId, p_code: code, p_client_id: clientId, p_source: "online" },
    { p_event_id: eventId, p_code: code }
  );

  if (result.kind === "transient") return checkInOffline(raw, code, clientId);
  if (result.kind === "error") {
    if (result.hint === "no_show") {
      return showNotOnRoster(raw, code, () => {
        setFailure("Marked no-show", result.message);
        announce("error");
        return { status: "error", message: result.message };
      });
    }
    setFailure("Check-in failed", result.message);
    announce("error");
    return { status: "error", message: result.message };
  }

  const data = result.data;
  const status = data?.status;
  const scannedAt = new Date();
  const base = baseFromData(data, code);

  if (status === "unknown") {
    const { prefix, eventCode, wrongEvent } = eventCodeHint(code);
    const plain = () => {
      const hint = wrongEvent ? `this pass is for ${prefix}, not ${eventCode}` : `not on the ${eventCode} roster`;
      pushScan({ ...base, kind: "error", code, role: "none", hint, bandRight: eventCode });
      announce("error");
      return { status: "unknown", message: wrongEvent ? `This code is for ${prefix}, but you're checking in to ${eventCode}.` : `"${raw}" is not on the ${eventCode} attendees roster` };
    };
    if (wrongEvent) return plain();
    setInfo(`Not on the roster. Looking up ${raw.includes("@") ? raw : code}…`, "Checking");
    return showNotOnRoster(raw, code, plain);
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

  if (status === "ok") patchPerson(base.code, data.checked_in_at || scannedAt.toISOString(), sessionUserId);
  else if (status === "dupe") patchPerson(base.code, data.checked_in_at || scannedAt.toISOString());
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

  // The check-in being undone: the database refuses if it has changed since
  // (someone checked them in again at another desk).
  const expected = person?.checked_in_at || null;
  const queueUndo = async () => {
    const fields = { op: "undo", eventId, code, name, roles: person?.roles || [], team: person?.team || "", prevAt: expected };
    await queue.add(fields);
    patchPerson(code, null);
    if (currentScan?.code === code) currentScan = null;
    setInfo(`Undid check-in for ${name}. Saved on this phone, will sync.`, "Undone");
    renderRecent();
    return { status: "ok", name, code, queued: true };
  };
  if (saved || isOffline()) return queueUndo();

  const result = await callRpcCompat(
    "undo_check_in",
    { p_event_id: eventId, p_code: code, ...(expected ? { p_expected_checked_in_at: expected } : {}), p_source: "online" },
    { p_event_id: eventId, p_code: code }
  );
  // A lost undo is safe to send again: the retry carries the same expected time.
  if (result.kind === "transient") return queueUndo();
  if (result.kind === "error") {
    if (result.hint === "checkin_changed") {
      const again = result.detail ? formatTime(result.detail) : null;
      const message = `${name} was checked in again${again ? ` at ${again}` : ""}, so this undo wasn't applied.`;
      setFailure("Not undone", message);
      if (result.detail) patchPerson(code, result.detail);
      reloadRoster();
      return { status: "error", message };
    }
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
  const result = await processCode(code, { mode: CHECK_IN });
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
  lastScanKey = null;
  const result = await undoCode(code);
  renderActiveRoleView({ animate: true });
  toastUndoResult(result);
}

function toastUndoResult(result) {
  if (result?.status === "ok") toast(`Undid check-in for ${result.name || result.code}${result.queued ? " · will sync" : ""}`);
  else toast(result?.message || "Undo failed", "error");
}

// "Checked in 10:42 by Evan" for the Undo confirm (nothing when unknown).
function whoCheckedIn(person) {
  if (!person?.checked_in_at) return "";
  const at = formatTime(person.checked_in_at);
  if (isSavedCheckIn(person.code)) return `Checked in ${at} on this phone (not synced yet)`;
  const by = byText(person.checked_in_by);
  return `Checked in ${at}${by ? ` ${by}` : ""}`;
}

async function rosterUndo(btn) {
  const code = btn.dataset.undo;
  const person = rosterByCode.get(code);
  const who = person ? `${person.name} (${person.code})` : code;
  const when = whoCheckedIn(person);
  if (!window.confirm(`Undo check-in for ${who}?\n\n${when ? `${when}. ` : ""}They'll be marked as not checked in.`)) return;
  btn.disabled = true;
  lastScanKey = null;
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
  const walkIn = e.target.closest("button[data-walkin]");
  if (walkIn) {
    await acceptWalkIn(walkIn);
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
  lastScanKey = null;
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
    resetForEvent(userId, eventId);
    await loadRoster();
    if (sessionUserId !== userId) return;
    await refreshScanTypes();
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
  const forItem = (s) => (item.op === "scan" ? s.mode?.id === item.scanTypeId : !s.mode);
  const scans = [currentScan, ...recentScans].filter((s) => s && s.code === item.code && forItem(s) && (s.pending || s.kind === "saved-unverified"));
  if (item.op === "scan") {
    settleScan(item, outcome, data, scans);
  } else if (item.op === "check_in") {
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
            idc: (data && idInfo(data, data.roles)) || rosterByCode.get(item.code)?.idc || null,
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
      scans.forEach((s) => Object.assign(s, { kind: "error", pending: false, role: "none", hint: item.error && item.error !== "Not on the roster" ? item.error : "server says not on the roster" }));
    }
  } else if (outcome === "undone") {
    const p = rosterByCode.get(item.code);
    if (p && !savedOp(item.code)) patchPerson(item.code, null);
  }
  if (currentScan && scans.includes(currentScan)) showScan(currentScan, { quiet: true });
  renderRecent();
  scheduleRosterRender();
};

// A meal / swag scan saved on this phone reached the server.
function settleScan(item, outcome, data, scans) {
  const mode = { id: item.scanTypeId, label: item.label || data?.label || "Scan" };
  if (outcome === "synced") {
    rememberScan(item.scanTypeId, item.code, data?.scanned_at || item.at, sessionUserId);
    const nci = data?.status === "not_checked_in";
    scans.forEach((s) => {
      const base = s.kind === "saved-unverified" ? baseFromData(data, item.code) : {};
      Object.assign(s, base, { kind: nci ? "scan-nci" : "scan-ok", pending: false, bandRight: nci ? mode.label : formatTimeSeconds(new Date(data?.scanned_at || item.at)) });
    });
  } else if (outcome === "already") {
    // Another desk scanned them first: say so in Recent.
    rememberScan(item.scanTypeId, item.code, data?.first_scanned_at, null, data?.by_name);
    const already = { kind: "scan-already", pending: false, mode, byText: byText(null, data?.by_name), bandRight: formatTime(data?.first_scanned_at) || "", inShort: formatTimeShort(data?.first_scanned_at) };
    if (scans.length) scans.forEach((s) => Object.assign(s, already));
    else {
      const p = rosterByCode.get(item.code);
      recentScans = [{ ...scanBase(item.code, p || { name: data?.name || item.name, roles: data?.roles }), ...already }, ...recentScans].slice(0, RECENT_MAX);
    }
  } else if (outcome === "attention") {
    scans.forEach((s) => Object.assign(s, { kind: "error", pending: false, role: "none", hint: item.error || "server says not on the roster", bandRight: mode.label }));
  }
}

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
    refreshScanTypes();
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
  clearModes();
  renderModeControl();
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

