// The sync pill next to the event chip, and the sheet it opens.
//
//   hidden            online, nothing waiting
//   Offline · 3       amber: no connection (with or without waiting items)
//   Syncing 3…        sending the queue
//   3 waiting         amber: online, but the server isn't answering yet
//   1 needs attention red: the server said "not on roster" for a saved scan
//   Synced ✓          green for a moment after the queue empties, then hidden

import { queue, isOffline } from "./offline.js";

const ICONS = {
  offline:
    '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M6 15.5h7.8a3.2 3.2 0 0 0 .5-6.36A4.8 4.8 0 0 0 5.2 8 3.75 3.75 0 0 0 6 15.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m3 3 14 14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  waiting:
    '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 6v4.3l2.8 1.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  syncing:
    '<svg class="spin" viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M16 10a6 6 0 0 1-10.4 4.1M4 10a6 6 0 0 1 10.4-4.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M14.8 2.8v3.4h-3.4M5.2 17.2v-3.4h3.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  attention:
    '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M10 2.8 18 17H2Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10 8v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.4" r="1.05" fill="currentColor"/></svg>',
  synced:
    '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// Small "saved on this phone" mark for cards, recent rows and roster rows.
export const ICON_SAVED =
  '<svg class="saved-ico" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M6 15.5h7.8a3.2 3.2 0 0 0 .5-6.36A4.8 4.8 0 0 0 5.2 8 3.75 3.75 0 0 0 6 15.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10 9.2v2.6l1.7 1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function timeOf(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}


export function mountSyncUI({ onSyncNow, onRetry, onDismiss, getRosterSavedAt, shortCode }) {
  const pill = document.getElementById("sync-pill");
  const sheet = document.getElementById("sync-sheet");
  const list = document.getElementById("sync-sheet-list");
  const status = document.getElementById("sync-sheet-status");
  const syncNow = document.getElementById("sync-now-btn");
  let syncedUntil = 0;
  let syncedTimer = null;
  let lastState = "";

  function state() {
    const pending = queue.pending.length;
    const attention = queue.attention.length;
    if (queue.flushing && pending) return { key: "syncing", text: `Syncing ${pending}…`, short: `${pending}…` };
    if (isOffline()) {
      return pending
        ? { key: "offline", text: `Offline · ${pending} waiting`, short: `Offline · ${pending}` }
        : { key: "offline", text: "Offline", short: "Offline" };
    }
    if (pending) return { key: "waiting", text: `${pending} waiting`, short: `${pending} waiting` };
    if (Date.now() < syncedUntil) return { key: "synced", text: "Synced ✓", short: "Synced ✓" };
    if (attention) return { key: "attention", text: `${attention} ${attention === 1 ? "needs" : "need"} attention`, short: `${attention} to check` };
    return null;
  }

  function renderPill() {
    const s = state();
    pill.hidden = !s;
    if (!s) {
      lastState = "";
      return;
    }
    const sig = `${s.key}|${s.text}`;
    if (sig === lastState) return;
    lastState = sig;
    pill.dataset.state = s.key;
    pill.innerHTML = `${ICONS[s.key]}<span class="sync-pill-long">${esc(s.text)}</span><span class="sync-pill-short" aria-hidden="true">${esc(s.short)}</span>`;
    pill.setAttribute("aria-label", `${s.text.replace("✓", "").trim()}. Show check-ins saved on this phone.`);
  }

  function renderSheet() {
    if (!sheet.open) return;
    const pending = queue.pending;
    const attention = queue.attention;
    const saved = getRosterSavedAt();
    const savedText = saved ? ` Roster saved on this phone at ${timeOf(saved)}.` : "";
    let text;
    if (queue.flushing) text = "Sending to the server…";
    else if (isOffline()) text = pending.length ? "No connection. These are saved on this phone and sync on their own when it's back." : "No connection. Check-ins are saved on this phone and sync when it's back.";
    else if (pending.length) text = `The server isn't answering yet${queue.lastError ? ` (${queue.lastError})` : ""}. Trying again on its own.`;
    else if (attention.length) text = "Synced. The server couldn't match these: check the pass, then dismiss.";
    else text = "Everything on this phone is synced.";
    status.textContent = text + savedText;
    // Offline it couldn't do anything: the queue sends on its own once back.
    syncNow.hidden = !pending.length || isOffline();
    syncNow.disabled = queue.flushing;

    const rows = [...attention, ...pending];
    list.innerHTML = rows.length
      ? rows
          .map((i) => {
            const sending = i.id === queue.inFlight;
            const what = i.op === "undo" ? "Undo" : i.unverified ? "Check-in · not in saved roster" : "Check-in";
            const label = i.state === "attention" ? esc(i.error || "Needs attention") : sending ? "Sending…" : `${what} · ${timeOf(i.at)}`;
            const actions =
              i.state === "attention"
                ? `<div class="sheet-row-actions"><button class="ghost small" type="button" data-retry="${esc(i.id)}">Retry</button><button class="ghost small" type="button" data-dismiss="${esc(i.id)}">Dismiss</button></div>`
                : "";
            return `<li class="sheet-row is-${i.state}${sending ? " is-sending" : ""}">
              <span class="sheet-ico" aria-hidden="true">${i.state === "attention" ? ICONS.attention : sending ? ICONS.syncing : ICONS.waiting}</span>
              <div class="sheet-main"><div class="sheet-name">${esc(i.name || i.code)}</div><div class="sheet-sub"><code>${esc(shortCode(i.code))}</code> · ${label}</div></div>
              ${actions}
            </li>`;
          })
          .join("")
      : "";
    list.hidden = !rows.length;
  }

  function render() {
    renderPill();
    renderSheet();
  }

  queue.subscribe(render);

  pill.addEventListener("click", () => {
    if (!sheet.open) {
      try {
        sheet.showModal();
      } catch {
        sheet.setAttribute("open", "");
      }
    }
    renderSheet();
  });
  sheet.addEventListener("click", (e) => {
    // A tap on the backdrop (outside the panel) closes the sheet.
    if (e.target === sheet) sheet.close();
    const retry = e.target.closest("button[data-retry]");
    const dismiss = e.target.closest("button[data-dismiss]");
    if (retry) onRetry(retry.dataset.retry);
    if (dismiss) onDismiss(dismiss.dataset.dismiss);
    if (e.target.closest("[data-close]")) sheet.close();
  });
  syncNow.addEventListener("click", () => onSyncNow());

  return {
    render,
    // "Synced ✓" for a moment after the queue empties.
    flashSynced() {
      syncedUntil = Date.now() + 2500;
      clearTimeout(syncedTimer);
      syncedTimer = setTimeout(render, 2600);
      render();
    },
    close() {
      if (sheet.open) sheet.close();
    },
  };
}
