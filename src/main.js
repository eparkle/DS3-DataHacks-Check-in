import { supabase } from "./supabase.js";
import "./style.css";

const ROLES = ["hacker", "judge", "mentor"];
const ROLE_LABELS = { hacker: "Hackers", judge: "Judges", mentor: "Mentors" };
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let roster = [];
let eventId = null;
let lastScanId = null;
let lastScanTime = 0;
let html5QrCode = null;
let checkinsChannel = null;

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function formatTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function displayName(person) {
  const name = [person.first_name, person.last_name].filter(Boolean).join(" ").trim();
  return name || person.email || person.user_id;
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

async function loadEvent() {
  const { data, error } = await supabase
    .from("events")
    .select("id, name, starts_at")
    .order("starts_at", { ascending: false });

  if (error) throw error;
  if (!data?.length) {
    throw new Error('No rows in the "events" table.');
  }
  const event = data[0];
  eventId = event.id;
  document.getElementById("event-badge").textContent = event.name;
  return event;
}

async function loadTeamsByUser() {
  const map = new Map();
  const { data, error } = await supabase
    .from("team_members")
    .select("user_id, teams(name)")
    .eq("event_id", eventId);
  if (error || !data) return map;
  for (const row of data) {
    const name = row.teams?.name;
    if (name) map.set(row.user_id, name);
  }
  return map;
}

function normalizeRow(row, teamsByUser) {
  const roles = Array.isArray(row.roles) ? row.roles : [];
  return {
    user_id: row.user_id,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    roles,
    checked_in: !!row.checked_in,
    checked_in_at: row.checked_in_at,
    at: formatTime(row.checked_in_at),
    team: teamsByUser.get(row.user_id) || "",
  };
}

async function loadRoster() {
  const [{ data, error }, teamsByUser] = await Promise.all([
    supabase.from("v_checkin_list").select("*").eq("event_id", eventId),
    loadTeamsByUser(),
  ]);

  if (error) throw error;
  roster = (data || []).map((row) => normalizeRow(row, teamsByUser));

  ROLES.forEach((role) => {
    if (document.getElementById("view-" + role).classList.contains("active")) {
      renderRoleView(role);
    }
  });
}

async function subscribeCheckins() {
  if (checkinsChannel) {
    await supabase.removeChannel(checkinsChannel);
    checkinsChannel = null;
  }
  checkinsChannel = supabase
    .channel(`checkins:${eventId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "checkins",
        filter: `event_id=eq.${eventId}`,
      },
      () => {
        loadRoster().catch((err) => console.error(err));
      }
    )
    .subscribe();
}

function findPerson(raw) {
  const id = raw.trim();
  if (!id) return null;
  const lower = id.toLowerCase();

  if (UUID_RE.test(id)) {
    return roster.find((p) => p.user_id === id) || { user_id: id, roles: [], email: "" };
  }

  return (
    roster.find((p) => (p.email || "").toLowerCase() === lower) ||
    roster.find((p) => displayName(p).toLowerCase() === lower) ||
    null
  );
}

function setStatus(kind, html) {
  const card = document.getElementById("status-card");
  card.className = kind || "";
  card.innerHTML = html;
}

async function processCode(rawText) {
  const raw = String(rawText || "").trim();
  const now = Date.now();
  if (!raw) return;
  if (raw === lastScanId && now - lastScanTime < 3000) return;
  lastScanId = raw;
  lastScanTime = now;

  setStatus("", `<div class="placeholder">Looking up ${escapeHtml(raw)}…</div>`);

  const person = findPerson(raw);
  if (!person) {
    setStatus(
      "error",
      `<div class="icon">⚠️</div><div><div class="name">Unrecognized code</div><div class="meta">"${escapeHtml(raw)}" doesn't match a user UUID or roster email</div></div>`
    );
    return;
  }

  const { data, error } = await supabase.rpc("check_in_attendee", {
    p_event_id: eventId,
    p_user_id: person.user_id,
  });

  if (error) {
    const message = error.message || String(error);
    const unknown =
      /not accepted/i.test(message) || /not found/i.test(message);
    setStatus(
      "error",
      `<div class="icon">${unknown ? "⚠️" : "🚫"}</div><div><div class="name">${unknown ? "Not accepted for this event" : "Check-in failed"}</div><div class="meta">${escapeHtml(message)}</div></div>`
    );
    return;
  }

  const already = data?.already_checked_in;
  const at = formatTime(data?.checked_in_at);
  const name = displayName(person) || person.user_id;
  const roles = roleList(person).join(", ").toUpperCase() || "ATTENDEE";

  if (already) {
    setStatus(
      "error",
      `<div class="icon">↩️</div><div><div class="name">${escapeHtml(name)} — already checked in</div><div class="meta">${escapeHtml(roles)}${at ? " · at " + at : ""}</div></div>`
    );
  } else {
    setStatus(
      "success",
      `<div class="icon">✅</div><div><div class="name">${escapeHtml(name)}</div><div class="meta">${escapeHtml(roles)}${person.team ? " · " + escapeHtml(person.team) : ""} · checked in ${escapeHtml(at || "")}</div></div>`
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
      const hay = `${displayName(p)} ${p.email || ""} ${p.user_id}`.toLowerCase();
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
      <td>${escapeHtml(displayName(p))}</td>
      <td style="font-family:'IBM Plex Mono',monospace; font-size:0.75rem;">${escapeHtml(p.email || p.user_id)}</td>
      <td>${escapeHtml(p.team || "—")}</td>
      <td>${escapeHtml(p.at || "—")}</td>
      <td>${p.checked_in ? "" : `<button class="ghost" data-id="${p.user_id}" style="padding:5px 10px; font-size:0.75rem;">Check in</button>`}</td>
    `;
    body.appendChild(tr);
  });

  body.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await processCode(btn.dataset.id);
      renderRoleView(role);
    });
  });
}

function exportRole(role) {
  const rows = roster.filter((r) => roleList(r).includes(role));
  const out = [["Name", "Email", "User ID", "Team", "Checked In", "Time"]];
  rows.forEach((p) =>
    out.push([
      displayName(p),
      p.email || "",
      p.user_id,
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
  a.download = `datahacks-${role}s-export.csv`;
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
        <input id="${role}-search" placeholder="Search by name, email, or ID…">
        <select id="${role}-status-filter">
          <option value="all">All</option>
          <option value="in">Checked in</option>
          <option value="out">Not checked in</option>
        </select>
        <button class="ghost" id="${role}-export-btn" type="button">Export CSV</button>
      </div>
      <table>
        <thead><tr><th>Status</th><th>Name</th><th>Email</th><th>Team</th><th>Checked in at</th><th></th></tr></thead>
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
  if (checkinsChannel) {
    await supabase.removeChannel(checkinsChannel);
    checkinsChannel = null;
  }
  await supabase.auth.signOut();
});

async function startSession(session) {
  document.getElementById("session-email").textContent = session.user.email || "";
  showBoot("Loading event…");
  try {
    await loadEvent();
    await loadRoster();
    await subscribeCheckins();
    showApp();
    if (roster.length === 0) {
      setStatus(
        "",
        `<div class="placeholder">Connected, but nobody has an accepted hacker/mentor/judge role for this event yet.</div>`
      );
    }
  } catch (err) {
    showBootError(
      `Couldn't reach Supabase.<br><span style="font-size:0.7rem">${escapeHtml(err.message || err)}</span><br><br>Sign in as an organizer with an event_roles row of role <code>organizer</code>.`
    );
  }
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (!session) {
    eventId = null;
    roster = [];
    showAuth();
    return;
  }
  startSession(session);
});
