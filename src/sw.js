// Service worker for the Check-In app shell. NOT bundled into the app: the
// offline-shell plugin in vite.config.js fills in BUILD, PRECACHE and
// FONT_CSS and writes the result to dist/sw.js on every build, so each deploy
// ships a byte-different sw.js and phones pick it up.
//
//   - Install: cache every built file (JS, CSS, the QR decoder worker + .wasm,
//     End art) and the Google Fonts this device uses, then take over at once
//     (skipWaiting + clients.claim).
//   - Pages: network first (3.5 s), else the cached app, so a reload with no
//     network still opens Check-In.
//   - Built files: cache first (they're content-hashed).
//   - Supabase is never touched here: the app handles offline writes itself.

const BUILD = "__BUILD_ID__";
const PRECACHE = __PRECACHE__;
const FONT_CSS = __FONT_CSS__;
const SHELL = `shell-${BUILD}`;
const FONTS = "fonts-v1";
const NAV_TIMEOUT_MS = 3500;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })));
      try {
        await cacheFonts();
      } catch {
        /* fonts fall back to system fonts offline */
      }
      await self.skipWaiting();
    })()
  );
});

async function cacheFonts() {
  const cache = await caches.open(FONTS);
  for (const href of FONT_CSS) {
    const res = await fetch(href, { mode: "cors", credentials: "omit" });
    if (!res.ok) continue;
    const css = await res.clone().text();
    await cache.put(href, res);
    const files = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/g)].map((m) => m[1]);
    await Promise.all(
      files.map(async (url) => {
        if (await cache.match(url)) return;
        const font = await fetch(url, { mode: "cors", credentials: "omit" });
        if (font.ok) await cache.put(url, font);
      })
    );
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Keep the previous build's files one more round: a page still running
      // it may lazy-load a chunk before it reloads.
      const old = (await caches.keys()).filter((k) => k.startsWith("shell-") && k !== SHELL).sort().reverse();
      await Promise.all(old.slice(1).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname === "/sw.js" || url.pathname === "/version.json") return;
    if (req.mode === "navigate") {
      event.respondWith(page(req));
      return;
    }
    event.respondWith(asset(req, url));
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(font(req));
  }
});

async function cachedShell() {
  const cache = await caches.open(SHELL);
  // ignoreVary: dev/preview servers send "Vary: Origin", and module scripts
  // carry an Origin header the precache requests didn't.
  return (await cache.match("/", { ignoreVary: true, ignoreSearch: true })) || (await caches.match("/", { ignoreVary: true, ignoreSearch: true }));
}

async function page(req) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NAV_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([fetch(req), timeout]);
    clearTimeout(timer);
    if (res && res.status < 500) return res;
  } catch {
    clearTimeout(timer);
  }
  return (await cachedShell()) || fetch(req);
}

async function asset(req, url) {
  const hit = await caches.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  // A newer build's chunk fetched before its worker took over: keep it too.
  if (res.ok && url.pathname.startsWith("/assets/")) {
    const cache = await caches.open(SHELL);
    cache.put(req, res.clone()).catch(() => {});
  }
  return res;
}

async function font(req) {
  const cache = await caches.open(FONTS);
  const hit = await cache.match(req, { ignoreVary: true });
  const update = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  return hit || (await update) || Response.error();
}
