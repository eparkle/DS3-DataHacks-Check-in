import { supabase } from "./supabase.js";
import { QrScanner, prewarm as prewarmScanner } from "./scanner.js";
import { feedback, unlockAudio, isMuted, setMuted } from "./feedback.js";
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
const STATUS_FILTERS = [
  ["all", "All"],
  ["out", "Not yet"],
  ["in", "Checked in"],
];
// Only used when the organizer's events can't be loaded from event_roles.
const FALLBACK_EVENT_ID = (import.meta.env.VITE_EVENT_ID || "").trim();
const EVENT_STORAGE_PREFIX = "datahacks-checkin:event:";
const NOT_ORGANIZER_MESSAGE = "This Google account isn't an organizer. Ask a DataHacks organizer to add you.";
const NOT_ORGANIZER_PASSWORD_MESSAGE = "This account isn't an organizer. Ask a DataHacks organizer to add you.";

let roster = [];
// True while the roster for the selected event is being fetched (first load, event switch).
let rosterLoading = true;
const statusFilter = { hacker: "all", judge: "all", mentor: "all" };
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
  return {
    id: row.id,
    code: (row.code || "").toUpperCase(),
    name: row.name || row.email || row.code,
    email: row.email || "",
    roles,
    team: row.team || "",
    checked_in: !!row.checked_in_at,
    checked_in_at: row.checked_in_at,
    at: formatTime(row.checked_in_at),
  };
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
  const { data, error } = await supabase
    .from("event_roles")
    .select("created_at, events(id, name, code, starts_at)")
    .eq("user_id", userId)
    .eq("role", "organizer");

  if (error) throw error;
  const byId = new Map();
  (data || []).forEach((row) => {
    const event = row.events;
    if (!event?.id || !event.code || byId.has(event.id)) return;
    byId.set(event.id, { ...event, role_created_at: row.created_at });
  });
  return [...byId.values()].sort(compareEvents);
}

// The pre-picker behaviour: VITE_EVENT_ID if set, else the newest event with a code.
async function loadFallbackEvent() {
  let query = supabase.from("events").select("id, name, starts_at, code");
  query = FALLBACK_EVENT_ID
    ? query.eq("id", FALLBACK_EVENT_ID)
    : query.order("starts_at", { ascending: false, nullsFirst: false });
  const { data, error } = await query;

  if (error) throw error;
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
  try {
    list = await loadOrganizerEvents(userId);
    listLoaded = true;
  } catch (err) {
    console.error("Couldn't load organizer events; using fallback event", err);
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
  roster = [];
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

async function loadRoster() {
  const requestedEventId = eventId;
  const { data, error } = await supabase
    .from("attendees")
    .select("id, event_id, code, name, email, roles, team, checked_in_at")
    .eq("event_id", requestedEventId)
    .order("code");

  if (error) throw error;
  // The organizer switched events while this was in flight.
  if (requestedEventId !== eventId) return;
  roster = (data || []).map(normalizeRow);
  rosterLoading = false;
  renderActiveRoleView();
  renderRecent();
}

function renderActiveRoleView() {
  ROLES.forEach((role) => {
    if (document.getElementById("view-" + role).classList.contains("active")) {
      renderRoleView(role);
    }
  });
}

async function subscribeAttendees() {
  if (attendeesChannel) {
    await supabase.removeChannel(attendeesChannel);
    attendeesChannel = null;
  }
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
      () => {
        loadRoster().catch((err) => console.error(err));
      }
    )
    .subscribe();
}

function resolveCode(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  const match =
    roster.find((p) => p.code === upper) ||
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
};

function renderCard(kind, html) {
  const card = document.getElementById("status-card");
  card.className = kind;
  card.innerHTML = html;
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

function showScan(scan) {
  const band = BAND[scan.kind];
  const undo =
    scan.kind === "success"
      ? `<button class="undo-btn" type="button" data-card-undo="${escapeHtml(scan.code)}" aria-label="Undo check-in for ${escapeHtml(scan.name)}">Undo</button>`
      : "";
  const metaParts =
    scan.kind === "error"
      ? [scan.hint]
      : [scan.roleText, scan.team, scan.kind === "warning" ? "no action taken" : ""].filter(Boolean);
  renderCard(
    scan.kind,
    `<div class="band"><span class="band-title"><span aria-hidden="true">${band.icon}</span> ${band.label}</span><span class="band-time">${escapeHtml(scan.bandRight)}</span></div>
     <div class="body">
       <div class="avatar role-${scan.role}" aria-hidden="true">${escapeHtml(scan.kind === "error" ? "?" : initials(scan.name))}</div>
       <div class="who">
         <div class="name">${escapeHtml(scan.kind === "error" ? "Unknown code" : scan.name)}</div>
         <div class="meta"><code>${escapeHtml(scan.code)}</code>${metaParts.map((p) => ` · ${escapeHtml(p)}`).join("")}</div>
       </div>
       ${undo}
     </div>`
  );
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
      const person = roster.find((p) => p.code === scan.code);
      const undone = scan.kind !== "error" && person && !person.checked_in;
      const kind = undone ? "undone" : scan.kind;
      const status =
        kind === "undone"
          ? `<span class="t">undone</span>`
          : kind === "error"
            ? `<span class="t"><span aria-hidden="true">✕</span><span class="visually-hidden">Unknown code,</span> ${escapeHtml(scan.timeShort)}</span>`
            : kind === "warning"
              ? `<span class="t"><span aria-hidden="true">↺</span><span class="visually-hidden">Already in since</span> ${escapeHtml(scan.inShort || scan.timeShort)}</span>`
              : `<span class="t"><span aria-hidden="true">✓</span><span class="visually-hidden">Checked in</span> ${escapeHtml(scan.inShort || scan.timeShort)}</span>`;
      return `<li class="recent-row is-${kind}">
        <span class="sq role-${scan.role}" aria-hidden="true"></span>
        <span class="nm">${escapeHtml(scan.kind === "error" ? "Unknown code" : scan.name)}</span>
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

async function processCode(rawText) {
  const raw = String(rawText || "").trim();
  const code = resolveCode(raw);
  const now = Date.now();
  if (!code) return;
  if (code === lastScanId && now - lastScanTime < 3000) return { status: "throttled" };
  lastScanId = code;
  lastScanTime = now;

  setInfo(`Looking up ${code}…`, "Checking");

  const { data, error } = await supabase.rpc("check_in_by_code", {
    p_event_id: eventId,
    p_code: code,
  });

  if (error) {
    setFailure("Check-in failed", error.message || error);
    announce("error");
    return { status: "error", message: error.message || String(error) };
  }

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
  };

  if (status === "unknown") {
    const prefix = (code.match(/^([A-Z0-9]{2,10})-[HJMB]\d+$/) || [])[1] || "";
    const eventCode = (currentEvent?.code || "").toUpperCase();
    const hint =
      prefix && eventCode && prefix !== eventCode
        ? `this pass is for ${prefix}, not ${eventCode}`
        : `not on the ${eventCode} roster`;
    pushScan({ ...base, kind: "error", code, role: "none", hint, bandRight: eventCode });
    announce("error");
    return { status: "unknown", message: prefix && prefix !== eventCode ? `This code is for ${prefix}, but you're checking in to ${eventCode}.` : `"${raw}" is not on the ${eventCode} attendees roster` };
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

  try {
    await loadRoster();
  } catch (err) {
    console.error(err);
  }
  return data || {};
}

async function undoCode(code) {
  const { data, error } = await supabase.rpc("undo_check_in", {
    p_event_id: eventId,
    p_code: code,
  });
  if (error) {
    setFailure("Undo failed", error.message || error);
    return { status: "error", message: error.message || String(error) };
  }
  if (data?.status === "ok") {
    // An undone scan doesn't belong in the recent list.
    if (currentScan?.code === data.code) currentScan = null;
    setInfo(`Undid check-in for ${data.name || data.code}.`, "Undone");
  }
  try {
    await loadRoster();
  } catch (err) {
    console.error(err);
  }
  return data || {};
}

// Not yet first (what the desk still has to do), then checked in; A–Z inside each group.
function compareByName(a, b) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.code.localeCompare(b.code);
}

function personRow(p, role) {
  const otherRoles = roleList(p).filter((r) => r !== role && ROLE_SINGULAR[r]);
  // Mentors and judges show their role label (e.g. "Mentor + Judge" for a B code).
  const roleLabel =
    role === "hacker" && !otherRoles.length
      ? ""
      : [role, ...otherRoles].map((r) => ROLE_SINGULAR[r]).join(" + ");
  const details = [p.team, roleLabel].filter(Boolean);
  const action = p.checked_in
    ? `<span class="in-time"><span aria-hidden="true">✓</span><span class="visually-hidden">Checked in</span>${p.at ? ` ${escapeHtml(formatTimeShort(p.checked_in_at))}` : ""}</span>
       <button class="row-undo" type="button" data-undo="${escapeHtml(p.code)}" aria-label="Undo check-in for ${escapeHtml(p.name)}">Undo</button>`
    : `<span class="visually-hidden">Not checked in yet.</span>
       <button class="primary row-checkin" type="button" data-code="${escapeHtml(p.code)}" aria-label="Check in ${escapeHtml(p.name)}">Check in</button>`;
  return `
    <li class="person ${p.checked_in ? "is-in" : "is-out"}">
      <div class="person-main">
        <div class="person-name">${escapeHtml(p.name)}</div>
        <div class="person-sub"><code title="${escapeHtml(p.code)}">${escapeHtml(shortCode(p.code))}</code>${details.map((d) => `<span>${escapeHtml(d)}</span>`).join("")}</div>
      </div>
      <div class="person-action">${action}</div>
    </li>`;
}

function renderRoleView(role) {
  const all = roster.filter((r) => roleList(r).includes(role));
  const searchEl = document.getElementById(`${role}-search`);
  const search = (searchEl?.value || "").trim().toLowerCase();
  const filter = statusFilter[role];
  const label = ROLE_LABELS[role].toLowerCase();

  document.querySelectorAll(`#view-${role} .chip`).forEach((chip) => {
    const active = chip.dataset.filter === filter;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", String(active));
  });
  document.getElementById(`${role}-search-clear`).hidden = !search;

  const list = document.getElementById(`${role}-list`);
  list.setAttribute("aria-busy", String(rosterLoading));

  if (rosterLoading) {
    list.innerHTML = Array.from({ length: 6 }, () => `<li class="person skeleton" aria-hidden="true"><div></div><div></div></li>`).join("") +
      `<li class="visually-hidden">Loading ${label}…</li>`;
    return;
  }

  if (all.length === 0) {
    list.innerHTML = `<li class="empty-state"><span class="empty-glyph" aria-hidden="true"></span><b>No ${label} on the ${escapeHtml(currentEvent?.code || "")} roster yet.</b><span>People appear here once their application is accepted.</span></li>`;
    return;
  }

  const matches = all.filter((p) => `${p.name} ${p.email || ""} ${p.code} ${p.team || ""}`.toLowerCase().includes(search));
  const groups = [
    { key: "out", title: "Not yet", people: matches.filter((p) => !p.checked_in).sort(compareByName) },
    { key: "in", title: "Checked in", people: matches.filter((p) => p.checked_in).sort(compareByName) },
  ].filter((g) => (filter === "all" || filter === g.key) && g.people.length);

  if (!groups.length) {
    const why = search
      ? `No ${label} match “${escapeHtml(searchEl.value.trim())}”${filter === "all" ? "" : " in this filter"}.`
      : filter === "in"
        ? `No ${label} checked in yet.`
        : `Everyone's checked in.`;
    list.innerHTML = `<li class="empty-state"><span class="empty-glyph" aria-hidden="true"></span><b>${why}</b>${
      search || filter !== "all" ? `<button class="ghost small" type="button" data-reset>Show all ${label}</button>` : ""
    }</li>`;
    return;
  }

  list.innerHTML = groups
    .map(
      (g) =>
        `<li class="group-head" role="presentation">${g.title}</li>` +
        g.people.map((p) => personRow(p, role)).join("")
    )
    .join("");
}

let toastTimer = null;
function toast(message, kind = "") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

async function rosterCheckIn(btn) {
  btn.disabled = true;
  btn.textContent = "Checking…";
  const result = await processCode(btn.dataset.code);
  if (result?.status === "ok") toast(`Checked in ${result.name || result.code}`, "success");
  else if (result?.status === "dupe") toast(`${result.name || result.code} was already checked in`, "warning");
  else if (result?.status === "throttled") toast("Just checked that code. Give it a second.");
  else toast(result?.message || "Check-in failed", "error");
  // A successful check-in re-renders the list; otherwise restore the button.
  if (btn.isConnected) {
    btn.disabled = false;
    btn.textContent = "Check in";
  }
}

async function rosterUndo(btn) {
  const person = roster.find((p) => p.code === btn.dataset.undo);
  const who = person ? `${person.name} (${person.code})` : btn.dataset.undo;
  if (!window.confirm(`Undo check-in for ${who}?\n\nThey'll be marked as not checked in.`)) return;
  btn.disabled = true;
  const result = await undoCode(btn.dataset.undo);
  if (result?.status === "ok") toast(`Undid check-in for ${result.name || result.code}`);
  else toast(result?.message || "Undo failed", "error");
  if (btn.isConnected) btn.disabled = false;
}

function exportRole(role) {
  const rows = roster.filter((r) => roleList(r).includes(role));
  const out = [["Name", "Code", "Email", "Team", "Checked In", "Time"]];
  rows.forEach((p) =>
    out.push([
      p.name,
      p.code,
      p.email || "",
      p.team,
      p.checked_in ? "yes" : "no",
      p.at || "",
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
      <div class="roster-head">
        <h2 class="roster-title">${label}</h2>
        <button class="icon-btn glass" id="${role}-export-btn" type="button" aria-label="Export ${label.toLowerCase()} as CSV" title="Export CSV">${ICON_DOWNLOAD}<span>CSV</span></button>
      </div>
      <div class="search">
        ${ICON_SEARCH}
        <input id="${role}-search" type="search" placeholder="Search name, code, team" aria-label="Search ${label.toLowerCase()}"
               autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
        <button class="search-clear" id="${role}-search-clear" type="button" aria-label="Clear search" hidden>
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="chips" role="group" aria-label="Filter ${label.toLowerCase()} by status">
        ${STATUS_FILTERS.map(
          ([key, text]) =>
            `<button class="chip${key === "all" ? " active" : ""}" type="button" data-filter="${key}" aria-pressed="${key === "all"}">${text}</button>`
        ).join("")}
      </div>
      <ul class="person-list" id="${role}-list" aria-label="${label}"></ul>
    </div>
  `;
  const search = document.getElementById(`${role}-search`);
  search.addEventListener("input", () => renderRoleView(role));
  // Enter on the phone keyboard closes it so the whole list is visible.
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") search.blur();
  });
  document.getElementById(`${role}-search-clear`).addEventListener("click", () => {
    search.value = "";
    renderRoleView(role);
    search.focus();
  });
  view.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      statusFilter[role] = chip.dataset.filter;
      renderRoleView(role);
      document.getElementById(`${role}-list`).scrollTop = 0;
    });
  });
  document.getElementById(`${role}-export-btn`).addEventListener("click", () => exportRole(role));
  document.getElementById(`${role}-list`).addEventListener("click", (e) => {
    const checkIn = e.target.closest("button[data-code]");
    const undo = e.target.closest("button[data-undo]");
    const reset = e.target.closest("button[data-reset]");
    if (checkIn) rosterCheckIn(checkIn);
    else if (undo) rosterUndo(undo);
    else if (reset) {
      search.value = "";
      statusFilter[role] = "all";
      renderRoleView(role);
    }
  });
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
    if (ROLES.includes(btn.dataset.view)) renderRoleView(btn.dataset.view);
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
  const btn = e.target.closest("button[data-card-undo]");
  if (!btn) return;
  btn.disabled = true;
  await undoCode(btn.dataset.cardUndo);
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
  stopCamera();
  if (attendeesChannel) {
    await supabase.removeChannel(attendeesChannel);
    attendeesChannel = null;
  }
  await supabase.auth.signOut();
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
    await loadRoster();
    await subscribeAttendees();
    showApp();
    // Fetch the QR decoder in the background so Start camera is instant.
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 200)))(() => prewarmScanner());
    if (roster.length === 0) {
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

supabase.auth.onAuthStateChange((_event, session) => {
  // The first event (INITIAL_SESSION) comes after supabase-js has finished
  // reading any sign-in result from the URL.
  cleanAuthUrl();
  if (!session) {
    eventId = null;
    currentEvent = null;
    events = [];
    roster = [];
    sessionUserId = null;
    setSessionEmail("");
    resetGoogleButton();
    showAuth();
    return;
  }
  // Token refreshes and tab refocus re-emit the session; keep the selected event.
  if (session.user.id === sessionUserId) return;
  sessionUserId = session.user.id;
  startSession(session);
});

if (oauthError) setAuthError(`Google sign-in didn't finish: ${oauthError}`);
