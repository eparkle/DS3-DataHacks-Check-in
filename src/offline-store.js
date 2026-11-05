// Small key-value store for the offline roster cache and the check-in queue.
// IndexedDB first (it survives better and holds a 550-person roster easily),
// localStorage if IndexedDB can't be opened (private mode, old WebKit), and
// memory as a last resort. Every call is wrapped: storage failing must never
// break a check-in.

const DB_NAME = "datahacks-checkin";
const STORE = "kv";
const LS_PREFIX = "datahacks-checkin:kv:";
const memory = new Map();

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let settled = false;
    const done = (db) => {
      if (settled) return;
      settled = true;
      resolve(db);
    };
    // Some private modes never answer the open request.
    setTimeout(() => done(null), 2500);
    try {
      if (typeof indexedDB === "undefined" || !indexedDB) return done(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        try {
          req.result.createObjectStore(STORE);
        } catch {
          /* already there */
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // iOS can drop the connection when the app is backgrounded; reopen next time.
        db.onclose = () => {
          dbPromise = null;
        };
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        done(db);
      };
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
  return dbPromise;
}

function idb(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (!db) return reject(new Error("IndexedDB unavailable"));
        let result;
        let tx;
        try {
          tx = db.transaction(STORE, mode);
          const req = run(tx.objectStore(STORE));
          if (req) req.onsuccess = () => (result = req.result);
        } catch (err) {
          dbPromise = null;
          return reject(err);
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error("IndexedDB error"));
        tx.onabort = () => reject(tx.error || new Error("IndexedDB aborted"));
      })
  );
}

// One retry after reopening: WebKit sometimes hands back a dead connection.
async function withIdb(mode, run) {
  try {
    return { ok: true, value: await idb(mode, run) };
  } catch {
    dbPromise = null;
    try {
      return { ok: true, value: await idb(mode, run) };
    } catch {
      return { ok: false };
    }
  }
}

function lsGet(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function lsDelete(key) {
  try {
    localStorage.removeItem(LS_PREFIX + key);
  } catch {
    /* ignore */
  }
}

export async function kvGet(key) {
  const r = await withIdb("readonly", (s) => s.get(key));
  if (r.ok && r.value !== undefined) return r.value;
  const ls = lsGet(key);
  if (ls !== undefined) return ls;
  return memory.get(key);
}

export async function kvSet(key, value) {
  const r = await withIdb("readwrite", (s) => s.put(value, key));
  if (r.ok) {
    // A copy written while IndexedDB was down would shadow nothing (IndexedDB
    // is read first) but would linger; drop it.
    lsDelete(key);
    memory.delete(key);
    return;
  }
  if (lsSet(key, value)) return;
  memory.set(key, value);
}

export async function kvDelete(key) {
  await withIdb("readwrite", (s) => s.delete(key));
  lsDelete(key);
  memory.delete(key);
}

// Delete every key starting with prefix (sign-out clears one organizer's data).
export async function kvDeletePrefix(prefix) {
  await withIdb("readwrite", (s) => {
    const range = IDBKeyRange.bound(prefix, prefix + "￿");
    return s.delete(range);
  });
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX + prefix)) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
  [...memory.keys()].forEach((k) => {
    if (k.startsWith(prefix)) memory.delete(k);
  });
}

// Ask the browser not to evict our data under storage pressure (best effort).
export function requestPersistence() {
  try {
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    /* ignore */
  }
}
