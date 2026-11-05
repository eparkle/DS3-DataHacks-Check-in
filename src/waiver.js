// Liability waiver at the desk: whether someone's waiver is on file, and a
// "Sign now" sheet with a QR code to the waiver page of their portal. People
// sign on a DocuSign PowerForm linked from that page; if they show the desk
// DocuSign's completion email instead, the sheet's "Mark signed" records it
// (mark_waiver_seen, online only, hidden on a database without it).
//
// The site records a signed waiver in attendees.waiver_signed_at (and
// check_in_by_code returns it). A database without that column yet gives
// "unknown", and nothing waiver-related is shown.

// The site with the portal (where people sign). Override with VITE_PORTAL_URL.
const PORTAL_ORIGIN = String(import.meta.env.VITE_PORTAL_URL || "https://datahacks.ds3ucsd.com").replace(/\/+$/, "");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** "signed" | "missing" | "unknown" (the field isn't there: older database). */
export function waiverState(row) {
  if (!row || typeof row !== "object" || !("waiver_signed_at" in row)) return "unknown";
  return row.waiver_signed_at ? "signed" : "missing";
}

// The portal section for their roles: /portal/hacker|mentor|judge|hybrid.
function portalType(roles) {
  const list = Array.isArray(roles) ? roles : [];
  if (list.includes("mentor") && list.includes("judge")) return "hybrid";
  if (list.includes("judge")) return "judge";
  if (list.includes("mentor")) return "mentor";
  if (list.includes("hacker")) return "hacker";
  return null;
}

/** The waiver page in their portal. With no known role, the portal home (it opens their section). */
export function waiverUrl(roles) {
  const type = portalType(roles);
  return type ? `${PORTAL_ORIGIN}/portal/${type}/waiver` : `${PORTAL_ORIGIN}/portal`;
}

/**
 * The waiver marker. On the scan card a missing waiver is a button that opens
 * the QR sheet (data-waiver-sign = the code); in roster rows it's just a label.
 */
export function waiverBadge(state, { code = "", name = "", button = false } = {}) {
  if (state === "signed") {
    return `<span class="wv wv-ok">Waiver <span aria-hidden="true">✓</span><span class="visually-hidden">on file</span></span>`;
  }
  if (state !== "missing") return "";
  if (button) {
    return `<button class="wv wv-no wv-btn" type="button" data-waiver-sign="${esc(code)}" aria-label="No waiver. Sign now: show a QR code for ${esc(name)}">No waiver<span class="wv-sep" aria-hidden="true"> · </span><span class="wv-cta">Sign now</span></button>`;
  }
  return `<span class="wv wv-no"><span class="wv-dot" aria-hidden="true"></span>No waiver</span>`;
}

// ---------- QR code (zxing-wasm's writer, already a dependency; loaded on first use) ----------

let writer = null;
function loadWriter() {
  writer ??= Promise.all([import("zxing-wasm/writer"), import("zxing-wasm/writer/zxing_writer.wasm?url")])
    .then(([mod, wasm]) => {
      // Serve the .wasm from this site, like the scanner's reader.
      mod.prepareZXingModule({
        overrides: {
          locateFile: (path, prefix) => (path.endsWith(".wasm") ? new URL(wasm.default, location.origin).href : prefix + path),
        },
      });
      return mod;
    })
    .catch((err) => {
      writer = null;
      throw err;
    });
  return writer;
}

/** Start fetching the QR writer in the background (a missing waiver was just shown). */
export function prewarmWaiverQr() {
  loadWriter().catch(() => {});
}

// Dark modules on white with a 4-module quiet zone, as one crisp SVG path.
async function qrSvg(text) {
  const { writeBarcode } = await loadWriter();
  const result = await writeBarcode(text, { format: "QRCode", options: "ecLevel=M" });
  if (result.error) throw new Error(result.error);
  const { data, width, height } = result.symbol;
  const q = 4;
  let d = "";
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] === 0) d += `M${x + q} ${y + q}h1v1h-1z`;
    }
  }
  const w = width + q * 2;
  const h = height + q * 2;
  return `<svg viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" aria-hidden="true"><rect width="${w}" height="${h}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// ---------- The "Sign now" sheet ----------

let sheet = null;
let sheetCode = null;

function ensureSheet() {
  if (sheet) return sheet;
  sheet = document.createElement("dialog");
  sheet.className = "waiver-sheet";
  sheet.setAttribute("aria-labelledby", "ws-title");
  sheet.innerHTML = `
    <div class="ws-card">
      <div class="ws-head">
        <div class="ws-titles">
          <span class="ws-kicker">Liability waiver</span>
          <h2 id="ws-title" tabindex="-1" autofocus></h2>
        </div>
        <button class="ws-close" type="button" aria-label="Close">
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
        </button>
      </div>
      <p class="ws-lead">Scan with their phone camera, sign in with the account they applied with, and sign.</p>
      <div class="ws-qr" role="img"></div>
      <a class="ws-url" target="_blank" rel="noopener"></a>
      <p class="ws-status" role="status" aria-live="polite"></p>
      <div class="ws-mark" hidden>
        <button class="ws-mark-btn" type="button">They showed me the signed confirmation <span aria-hidden="true">→</span> Mark signed</button>
        <p class="ws-mark-msg" role="status" aria-live="polite"></p>
      </div>
    </div>`;
  document.body.appendChild(sheet);
  sheet.querySelector(".ws-close").addEventListener("click", closeWaiverSheet);
  sheet.querySelector(".ws-mark-btn").addEventListener("click", onMarkClick);
  // Tapping outside the card closes it.
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) closeWaiverSheet();
  });
  sheet.addEventListener("close", () => {
    sheetCode = null;
    sheetPerson = null;
  });
  return sheet;
}

export function isWaiverSheetOpen() {
  return !!sheet?.open;
}

export function closeWaiverSheet() {
  if (sheet?.open) sheet.close();
  sheetCode = null;
}

function setSheetStatus(state) {
  const status = sheet.querySelector(".ws-status");
  sheet.classList.toggle("is-signed", state === "signed");
  if (state === "signed") sheet.querySelector(".ws-mark").hidden = true;
  status.innerHTML =
    state === "signed"
      ? `<span aria-hidden="true">✓</span> Waiver on file. You're all set.`
      : `Not on file yet. A new DocuSign signature shows here once organizers import it.`;
}

// ---------- "They showed me the signed confirmation" ----------

// Set by main.js: { canMark(): Promise<boolean>, mark(person): Promise<{ ok, message }> }.
let markHandler = null;
let sheetPerson = null;

export function setWaiverMarkHandler(handler) {
  markHandler = handler;
}

function setMarkMessage(text, kind = "") {
  const msg = sheet.querySelector(".ws-mark-msg");
  msg.textContent = text;
  msg.dataset.kind = kind;
}

// Shows the button when the database has mark_waiver_seen and we're online.
async function refreshMarkButton(person) {
  const box = sheet.querySelector(".ws-mark");
  const btn = box.querySelector(".ws-mark-btn");
  box.hidden = true;
  btn.disabled = false;
  setMarkMessage("");
  if (!markHandler || person.waiver === "signed") return;
  let ok = false;
  try {
    ok = await markHandler.canMark();
  } catch (err) {
    console.error(err);
  }
  if (sheetCode !== person.code || !sheet.open || sheet.classList.contains("is-signed")) return;
  box.hidden = !ok;
}

async function onMarkClick() {
  const person = sheetPerson;
  if (!person || !markHandler) return;
  const ok = window.confirm(
    `Mark ${person.name || person.code}'s waiver as signed?\n\nOnly if they showed you DocuSign's "Completed" email for the DataHacks waiver.`
  );
  if (!ok) return;
  const btn = sheet.querySelector(".ws-mark-btn");
  btn.disabled = true;
  setMarkMessage("Marking…");
  let result;
  try {
    result = await markHandler.mark(person);
  } catch (err) {
    console.error(err);
    result = { ok: false, message: "Couldn't mark it. Try again." };
  }
  if (sheetCode !== person.code) return;
  btn.disabled = false;
  if (result.ok) {
    // The roster refresh flips the sheet (and the scan card) to "Waiver ✓".
    if (!sheet.classList.contains("is-signed")) setMarkMessage(result.message || "Marked. Updating…", "ok");
  } else {
    setMarkMessage(result.message || "Couldn't mark it.", "error");
  }
}

/** person: { code, name, roles, waiver } */
export function openWaiverSheet(person) {
  const el = ensureSheet();
  sheetPerson = person;
  const url = waiverUrl(person.roles);
  sheetCode = person.code;
  el.querySelector("#ws-title").textContent = person.name || person.code;
  const link = el.querySelector(".ws-url");
  link.href = url;
  // Line breaks only after a slash, never mid-word.
  link.innerHTML = esc(url.replace(/^https?:\/\//, "")).replace(/\//g, "/<wbr>");
  const qr = el.querySelector(".ws-qr");
  qr.setAttribute("aria-label", `QR code for ${url.replace(/^https?:\/\//, "")}`);
  qr.classList.remove("failed");
  qr.innerHTML = `<div class="pixel-spinner" aria-hidden="true"><i></i><i></i><i></i></div>`;
  setSheetStatus(person.waiver);
  if (!el.open) el.showModal();
  refreshMarkButton(person);
  const code = person.code;
  qrSvg(url)
    .then((svg) => {
      if (sheetCode === code) qr.innerHTML = svg;
    })
    .catch((err) => {
      console.error(err);
      if (sheetCode !== code) return;
      qr.classList.add("failed");
      qr.innerHTML = `<p>Couldn't draw the QR code. Open the link below on their phone instead.</p>`;
    });
}

/** A roster update arrived: if the sheet is open, show its person's waiver as it is now. */
export function syncWaiverSheet(lookup) {
  if (!sheet?.open || !sheetCode) return;
  const person = lookup(sheetCode);
  if (person && person.waiver !== "unknown") setSheetStatus(person.waiver);
}
