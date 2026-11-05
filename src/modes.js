// What the Scan tab records: check-ins (the default) or a meal / swag scan
// type ("Lunch · Sat"), plus the bits of data the desk keeps for them:
//
//   - the event's active scan types (public.scan_types), saved on this phone
//   - per scan type, who already had it (public.checkin_events, kind 'scan'),
//     saved on this phone so a second lunch is caught offline too
//   - organizers' first names for "by Evan" (public.profiles)
//
// A database without scan_types / checkin_events yet (the site's migration
// isn't on it) just means no mode switch: Check-in only.

import { supabase } from "./supabase.js";
import { timedQuery, isMissingApi, saveUserCache, loadUserCache } from "./offline.js";

export const CHECK_IN = "check_in";
const MODE_KEY = "datahacks-checkin:mode:";

const state = {
  userId: null,
  eventId: null,
  types: [],
  // false once the database says there's no scan_types table.
  available: true,
  mode: CHECK_IN,
  // scanTypeId -> Map(code -> { at, by })
  scans: new Map(),
  names: new Map(),
};

export const scanTypes = () => state.types;
export const currentMode = () => state.mode;
export const isScanMode = () => state.mode !== CHECK_IN && !!scanType(state.mode);
export const scanType = (id) => state.types.find((t) => t.id === id) || null;
export const currentScanType = () => (isScanMode() ? scanType(state.mode) : null);

function readStoredMode(userId) {
  try {
    return JSON.parse(localStorage.getItem(MODE_KEY + userId) || "null");
  } catch {
    return null;
  }
}

function storeMode() {
  if (!state.userId) return;
  try {
    localStorage.setItem(MODE_KEY + state.userId, JSON.stringify({ eventId: state.eventId, mode: state.mode }));
  } catch {
    /* ignore */
  }
}

export function setMode(mode) {
  state.mode = mode && mode !== CHECK_IN && scanType(mode) ? mode : CHECK_IN;
  storeMode();
  return state.mode;
}

/**
 * A new session or event. Check-in unless this phone was last on a scan type
 * of this same event (switching events always goes back to Check-in).
 */
export function resetForEvent(userId, eventId, { keepStored = true } = {}) {
  state.userId = userId;
  state.eventId = eventId;
  state.types = [];
  state.scans = new Map();
  const stored = keepStored ? readStoredMode(userId) : null;
  state.mode = stored && stored.eventId === eventId && stored.mode ? stored.mode : CHECK_IN;
  if (!keepStored) storeMode();
}

const TYPE_COLUMNS = "id, label, kind, active, sort, opens_at, closes_at";

/** Loads the event's active scan types (the saved copy when offline). Keeps the mode if its type is still there. */
export async function loadScanTypes() {
  const { userId, eventId } = state;
  if (!userId || !eventId || !state.available) return state.types;
  const res = await timedQuery(() =>
    supabase.from("scan_types").select(TYPE_COLUMNS).eq("event_id", eventId).eq("active", true).order("sort").order("label")
  );
  if (eventId !== state.eventId) return state.types;
  if (res.kind === "ok") {
    state.types = (res.data || []).filter((t) => t?.id && t.label);
    saveUserCache(userId, `scantypes:${eventId}`, state.types);
  } else if (isMissingApi(res)) {
    state.available = false;
    state.types = [];
  } else {
    const cached = await loadUserCache(userId, `scantypes:${eventId}`);
    if (eventId !== state.eventId) return state.types;
    if (Array.isArray(cached)) state.types = cached;
  }
  // The stored mode's type was switched off: back to check-in (the mode
  // is kept in storage in case it comes back).
  if (state.mode !== CHECK_IN && !scanType(state.mode)) state.mode = CHECK_IN;
  return state.types;
}

// ---------- Who already had each scan type ----------

const scanMap = (typeId) => {
  let m = state.scans.get(typeId);
  if (!m) state.scans.set(typeId, (m = new Map()));
  return m;
};

/** The first scan of this person for this type that this phone knows of: { at, by, byName? } or null. */
export const knownScan = (typeId, code) => state.scans.get(typeId)?.get(code) || null;

export function rememberScan(typeId, code, at, by, byName) {
  const m = scanMap(typeId);
  if (!m.has(code)) m.set(code, { at, by: by || null, ...(byName ? { byName } : {}) });
  persistScans(typeId);
}

let scanTimer = null;
function persistScans(typeId) {
  clearTimeout(scanTimer);
  const { userId, eventId } = state;
  scanTimer = setTimeout(() => {
    const m = state.scans.get(typeId);
    if (m && userId === state.userId && eventId === state.eventId) saveUserCache(userId, `scans:${eventId}:${typeId}`, [...m]);
  }, 500);
}

/** Loads who had this scan type (checkin_events), or the copy saved on this phone. */
export async function loadScanLog(typeId) {
  const { userId, eventId } = state;
  if (!userId || !eventId || !typeId) return;
  const res = await timedQuery(() =>
    supabase.from("checkin_events").select("code, scanned_at, by_user").eq("event_id", eventId).eq("kind", "scan").eq("scan_type_id", typeId).range(0, 9999)
  );
  if (eventId !== state.eventId) return;
  const m = scanMap(typeId);
  if (res.kind === "ok") {
    (res.data || []).forEach((r) => {
      if (r?.code) m.set(String(r.code).toUpperCase(), { at: r.scanned_at, by: r.by_user || null });
    });
    persistScans(typeId);
    ensureNames((res.data || []).map((r) => r.by_user));
  } else {
    const cached = await loadUserCache(userId, `scans:${eventId}:${typeId}`);
    if (eventId !== state.eventId || !Array.isArray(cached)) return;
    cached.forEach(([code, v]) => {
      if (!m.has(code)) m.set(code, v);
    });
  }
}

// ---------- Organizers' names ----------

/** "Evan" (first name), else the email's local part. */
export function shortName(profile) {
  const first = String(profile?.first_name || "").trim().split(/\s+/)[0];
  if (first) return first;
  return String(profile?.email || "").split("@")[0] || null;
}

export const nameOf = (id) => (id ? state.names.get(id) || null : null);

let namesLoaded = false;
async function loadSavedNames() {
  if (namesLoaded || !state.userId) return;
  namesLoaded = true;
  const saved = await loadUserCache(state.userId, "names");
  if (Array.isArray(saved)) saved.forEach(([id, n]) => state.names.has(id) || state.names.set(id, n));
}

const asked = new Set();
let namesQueue = new Set();
let namesTimer = null;
let onNames = () => {};
export const onNamesChanged = (fn) => {
  onNames = fn;
};

/** Looks up names for these profile ids (in the background, batched). */
export function ensureNames(ids) {
  loadSavedNames();
  (ids || []).forEach((id) => {
    if (id && !state.names.has(id) && !asked.has(id)) namesQueue.add(id);
  });
  if (!namesQueue.size || namesTimer) return;
  namesTimer = setTimeout(fetchNames, 150);
}

async function fetchNames() {
  namesTimer = null;
  const ids = [...namesQueue].slice(0, 100);
  ids.forEach((id) => {
    namesQueue.delete(id);
    asked.add(id);
  });
  if (!ids.length) return;
  const userId = state.userId;
  const res = await timedQuery(() => supabase.from("profiles").select("id, first_name, last_name, email").in("id", ids));
  if (res.kind !== "ok") {
    // Try again later (offline): forget we asked.
    ids.forEach((id) => asked.delete(id));
  } else {
    (res.data || []).forEach((p) => {
      const n = shortName(p);
      if (p?.id && n) state.names.set(p.id, n);
    });
    if (userId === state.userId) saveUserCache(userId, "names", [...state.names]);
    onNames();
  }
  if (namesQueue.size) ensureNames([]);
}

/** Sign-out. */
export function clearModes() {
  state.userId = null;
  state.eventId = null;
  state.types = [];
  state.scans = new Map();
  state.names = new Map();
  state.mode = CHECK_IN;
  state.available = true;
  namesLoaded = false;
  asked.clear();
  namesQueue = new Set();
}
