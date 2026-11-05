// Registers the service worker (production builds only) and makes sure a
// phone that has the app open all day picks up new deploys.
//
// sw.js calls skipWaiting + clients.claim, so a new deploy's worker takes
// over as soon as it has cached the new build. A page still running the old
// build then offers "Reload" (or reloads on its own the next time it's in the
// background, where nobody is looking at it). /version.json is the source of
// truth for "is this page the current build"; it's never cached.

/* global __BUILD_ID__ */
const BUILD_ID = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";
const CHECK_EVERY_MS = 10 * 60 * 1000;

async function latestBuild() {
  if (navigator.onLine === false) return null;
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json())?.build || null;
  } catch {
    return null;
  }
}

export function registerServiceWorker({ onUpdateReady }) {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  let reg = null;
  let stale = false;
  let reloading = false;
  let offered = false;

  const apply = () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };

  async function check() {
    const build = await latestBuild();
    if (!build || build === BUILD_ID) return;
    stale = true;
    try {
      await reg?.update();
    } catch {
      /* try again next time */
    }
  }

  navigator.serviceWorker.addEventListener("controllerchange", async () => {
    // First install: this page already is the current build.
    if (!hadController) return;
    const build = await latestBuild();
    if (!build || build === BUILD_ID) return;
    stale = true;
    if (document.visibilityState === "hidden") apply();
    else if (!offered) {
      offered = true;
      onUpdateReady(apply);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // Nobody is looking: swap to the new build now. The check-in queue is
      // on disk, so nothing is lost.
      if (stale && navigator.serviceWorker.controller && !reloading) apply();
    } else {
      check();
    }
  });

  const start = async () => {
    try {
      reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    } catch (err) {
      console.warn("Service worker not registered", err);
      return;
    }
    check();
    setInterval(check, CHECK_EVERY_MS);
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}
