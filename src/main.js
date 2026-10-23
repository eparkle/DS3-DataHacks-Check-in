import { supabase } from "./supabase.js";
import "./style.css";

const ROLES = ["hacker", "judge", "mentor"];
const ROLE_LABELS = { hacker: "Hackers", judge: "Judges", mentor: "Mentors" };
// Only used when the organizer's events can't be loaded from event_roles.
const FALLBACK_EVENT_ID = (import.meta.env.VITE_EVENT_ID || "").trim();
const EVENT_STORAGE_PREFIX = "datahacks-checkin:event:";

let roster = [];
let eventId = null;
let currentEvent = null;
let events = [];
let usingFallback = false;
let sessionUserId = null;
let lastScanId = null;
let lastScanTime = 0;
let html5QrCode = null;
let attendeesChannel = null;

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function formatTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function roleList(person) {
  return Array.isArray(person.roles) ? person.roles.filter(Boolean) : [];
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
  document.getElementById("boot-message").innerHTML = html;
  document.getElementById("auth-screen").classList.add("app-hidden");
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
  document.querySelectorAll(".current-event-name").forEach((el) => {
    el.textContent = usingFallback
      ? `${currentEvent.name} (fallback: couldn't load the events you organize)`
      : currentEvent.name;
  });
  document.querySelectorAll(".event-banner").forEach((el) => el.classList.toggle("fallback", usingFallback));
  document.title = `${currentEvent.code} · DataHacks Check-In`;
}

async function loadEvent(userId) {
  let list = [];
  try {
    list = await loadOrganizerEvents(userId);
  } catch (err) {
    console.error("Couldn't load organizer events; using fallback event", err);
  }

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
  lastScanId = null;
  renderEventPicker();
  select.disabled = true;
  setStatus("", `<div class="placeholder">Switched to ${escapeHtml(next.code)}. Loading roster…</div>`);

  try {
    await loadRoster();
    await subscribeAttendees();
    setStatus(
      "",
      `<div class="placeholder">Now checking in to ${escapeHtml(next.code)} · ${roster.length} on the roster.</div>`
    );
  } catch (err) {
    setStatus(
      "error",
      `<div class="icon">🚫</div><div><div class="name">Couldn't load ${escapeHtml(next.code)}</div><div class="meta">${escapeHtml(err.message || err)}</div></div>`
    );
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

function setStatus(kind, html) {
  const card = document.getElementById("status-card");
  card.className = kind || "";
  card.innerHTML = html;
}

function personMeta(data) {
  const roles = Array.isArray(data?.roles) ? data.roles.join(", ").toUpperCase() : "ATTENDEE";
  const team = data?.team ? ` · ${data.team}` : "";
  const at = formatTime(data?.checked_in_at);
  return { roles, team, at };
}

async function processCode(rawText) {
  const raw = String(rawText || "").trim();
  const code = resolveCode(raw);
  const now = Date.now();
  if (!code) return;
  if (code === lastScanId && now - lastScanTime < 3000) return;
  lastScanId = code;
  lastScanTime = now;

  setStatus("", `<div class="placeholder">Looking up ${escapeHtml(code)}…</div>`);

  const { data, error } = await supabase.rpc("check_in_by_code", {
    p_event_id: eventId,
    p_code: code,
  });

  if (error) {
    setStatus(
      "error",
      `<div class="icon">🚫</div><div><div class="name">Check-in failed</div><div class="meta">${escapeHtml(error.message || error)}</div></div>`
    );
    return;
  }

  const status = data?.status;
  const meta = personMeta(data);

  if (status === "unknown") {
    const prefix = (code.match(/^([A-Z0-9]{2,10})-[HJMB]\d+$/) || [])[1] || "";
    const eventCode = (currentEvent?.code || "").toUpperCase();
    const hint =
      prefix && eventCode && prefix !== eventCode
        ? `This code is for ${prefix}, but you're checking in to ${eventCode}.`
        : `"${raw}" is not on the ${eventCode} attendees roster`;
    setStatus(
      "error",
      `<div class="icon">⚠️</div><div><div class="name">Unrecognized code</div><div class="meta">${escapeHtml(hint)}</div></div>`
    );
    return;
  }

  if (status === "dupe") {
    setStatus(
      "error",
      `<div class="icon">↩️</div><div><div class="name">${escapeHtml(data.name)} — already checked in</div><div class="meta">${escapeHtml(data.code)} · ${escapeHtml(meta.roles)}${meta.at ? " · at " + meta.at : ""}</div></div>`
    );
  } else if (status === "ok") {
    setStatus(
      "success",
      `<div class="icon">✅</div><div><div class="name">${escapeHtml(data.name)}</div><div class="meta">${escapeHtml(data.code)} · ${escapeHtml(meta.roles)}${escapeHtml(meta.team)} · checked in ${escapeHtml(meta.at || "")}</div></div>`
    );
  } else {
    setStatus(
      "error",
      `<div class="icon">🚫</div><div><div class="name">Unexpected response</div><div class="meta">${escapeHtml(JSON.stringify(data))}</div></div>`
    );
  }

  try {
    await loadRoster();
  } catch (err) {
    console.error(err);
  }
}

async function undoCode(code) {
  const { data, error } = await supabase.rpc("undo_check_in", {
    p_event_id: eventId,
    p_code: code,
  });
  if (error) {
    setStatus(
      "error",
      `<div class="icon">🚫</div><div><div class="name">Undo failed</div><div class="meta">${escapeHtml(error.message || error)}</div></div>`
    );
    return;
  }
  if (data?.status === "ok") {
    setStatus(
      "",
      `<div class="placeholder">Undid check-in for ${escapeHtml(data.name || data.code)}</div>`
    );
  }
  try {
    await loadRoster();
  } catch (err) {
    console.error(err);
  }
}

function renderRoleView(role) {
  const all = roster.filter((r) => roleList(r).includes(role));
  const searchEl = document.getElementById(`${role}-search`);
  const filterEl = document.getElementById(`${role}-status-filter`);
  const search = (searchEl?.value || "").toLowerCase();
  const statusFilter = filterEl?.value || "all";

  const checkedInCount = all.filter((r) => r.checked_in).length;
  document.getElementById(`${role}-count`).innerHTML =
    `<b>${checkedInCount}</b> / ${all.length} checked in`;

  const filtered = all
    .filter((p) =>
      statusFilter === "all" ? true : statusFilter === "in" ? p.checked_in : !p.checked_in
    )
    .filter((p) => {
      const hay = `${p.name} ${p.email || ""} ${p.code}`.toLowerCase();
      return hay.includes(search);
    });

  const body = document.getElementById(`${role}-body`);
  body.innerHTML = "";

  if (filtered.length === 0) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">No ${ROLE_LABELS[role].toLowerCase()} match this view.</td></tr>`;
    return;
  }

  filtered.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="dot ${p.checked_in ? "in" : "out"}"></span>${p.checked_in ? "Checked in" : "Not yet"}</td>
      <td>${escapeHtml(p.name)}</td>
      <td style="font-family:'IBM Plex Mono',monospace; font-size:0.75rem;">${escapeHtml(p.code)}</td>
      <td>${escapeHtml(p.team || "—")}</td>
      <td>${escapeHtml(p.at || "—")}</td>
      <td>${
        p.checked_in
          ? `<button class="ghost" data-undo="${p.code}" style="padding:5px 10px; font-size:0.75rem;">Undo</button>`
          : `<button class="ghost" data-code="${p.code}" style="padding:5px 10px; font-size:0.75rem;">Check in</button>`
      }</td>
    `;
    body.appendChild(tr);
  });

  body.querySelectorAll("button[data-code]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await processCode(btn.dataset.code);
    });
  });
  body.querySelectorAll("button[data-undo]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await undoCode(btn.dataset.undo);
    });
  });
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

ROLES.forEach((role) => {
  const view = document.getElementById("view-" + role);
  view.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>${ROLE_LABELS[role]}</h2>
        <div class="count-line" id="${role}-count">— / —</div>
      </div>
      <div class="toolbar">
        <input id="${role}-search" placeholder="Search by name, code, or email…">
        <select id="${role}-status-filter">
          <option value="all">All</option>
          <option value="in">Checked in</option>
          <option value="out">Not checked in</option>
        </select>
        <button class="ghost" id="${role}-export-btn" type="button">Export CSV</button>
      </div>
      <table>
        <thead><tr><th>Status</th><th>Name</th><th>Code</th><th>Team</th><th>Checked in at</th><th></th></tr></thead>
        <tbody id="${role}-body"></tbody>
      </table>
    </div>
  `;
  document.getElementById(`${role}-search`).addEventListener("input", () => renderRoleView(role));
  document.getElementById(`${role}-status-filter`).addEventListener("change", () => renderRoleView(role));
  document.getElementById(`${role}-export-btn`).addEventListener("click", () => exportRole(role));
});

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    const view = document.getElementById("view-" + btn.dataset.view);
    view.classList.add("active");
    if (ROLES.includes(btn.dataset.view)) renderRoleView(btn.dataset.view);
  });
});

document.getElementById("event-select").addEventListener("change", (e) => {
  switchEvent(e.target.value);
});

document.getElementById("manual-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.value.trim()) {
    processCode(e.target.value);
    e.target.value = "";
  }
});

document.getElementById("start-btn").addEventListener("click", async () => {
  const startBtn = document.getElementById("start-btn");
  const stopBtn = document.getElementById("stop-btn");
  try {
    const { Html5Qrcode } = await import("html5-qrcode");
    html5QrCode = new Html5Qrcode("reader");
    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      (decodedText) => processCode(decodedText),
      () => {}
    );
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } catch (err) {
    setStatus(
      "error",
      `<div class="icon">🚫</div><div><div class="name">Camera unavailable</div><div class="meta">${escapeHtml(err)}. Check camera permissions, or use manual entry below.</div></div>`
    );
  }
});

document.getElementById("stop-btn").addEventListener("click", async () => {
  if (html5QrCode) {
    await html5QrCode.stop();
    html5QrCode.clear();
    html5QrCode = null;
  }
  document.getElementById("start-btn").disabled = false;
  document.getElementById("stop-btn").disabled = true;
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
  if (html5QrCode) {
    try {
      await html5QrCode.stop();
      html5QrCode.clear();
    } catch {
      /* ignore */
    }
    html5QrCode = null;
  }
  if (attendeesChannel) {
    await supabase.removeChannel(attendeesChannel);
    attendeesChannel = null;
  }
  await supabase.auth.signOut();
});

async function startSession(session) {
  document.getElementById("session-email").textContent = session.user.email || "";
  showBoot("Loading event…");
  try {
    await loadEvent(session.user.id);
    await loadRoster();
    await subscribeAttendees();
    showApp();
    if (roster.length === 0) {
      setStatus(
        "",
        `<div class="placeholder">Connected, but the attendees roster is empty. Accept applications after setting events.code so upsert_attendee can fill the table.</div>`
      );
    }
  } catch (err) {
    sessionUserId = null;
    showBootError(
      `Couldn't reach Supabase.<br><span style="font-size:0.7rem">${escapeHtml(err.message || err)}</span><br><br>Sign in as an organizer, and confirm the check-in SQL has been applied.`
    );
  }
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (!session) {
    eventId = null;
    currentEvent = null;
    events = [];
    roster = [];
    sessionUserId = null;
    showAuth();
    return;
  }
  // Token refreshes and tab refocus re-emit the session; keep the selected event.
  if (session.user.id === sessionUserId) return;
  sessionUserId = session.user.id;
  startSession(session);
});
