// Full-frame QR scanner: the whole camera frame is decoded (no scan box).
//
// Decoder, picked once and reused for every scan:
//   1. Native BarcodeDetector when it supports qr_code (Chrome on Android/macOS).
//   2. Otherwise ZXing (WebAssembly) in a Web Worker (iOS Safari, Firefox). The
//      worker and its .wasm are only fetched when needed, and prewarm() starts
//      that download before the camera is opened.

const MIN_FRAME_GAP_MS = 40; // at most ~25 decodes per second
const MAX_DECODE_SIDE = 1280; // larger frames are scaled down before decoding
const PAUSE_AFTER_HIT_MS = 1500; // no decoding right after a successful scan
const SAME_CODE_GAP_MS = 2500; // the same code must leave the frame this long before it counts again

export class CameraError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function describeCameraError(err) {
  const name = err?.name || "";
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return new CameraError("insecure", "The camera only works on an https:// page.");
  }
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    return new CameraError(
      "denied",
      ios
        ? "Camera access is blocked. Allow camera access in Settings → Safari → Camera (or tap “aA” → Website Settings → Camera → Allow), then tap Retry."
        : "Camera access is blocked. Allow the camera for this site (lock icon in the address bar → Camera → Allow), then tap Retry."
    );
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return new CameraError("missing", "No camera found on this device.");
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return new CameraError("busy", "The camera is in use by another app. Close it, then tap Retry.");
  }
  return new CameraError("other", `Couldn't start the camera (${name || err?.message || err}).`);
}

async function openCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw describeCameraError(null);
  }
  const preferred = {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  };
  try {
    return await navigator.mediaDevices.getUserMedia(preferred);
  } catch (err) {
    // Some cameras reject the size hints; any camera beats none.
    if (err?.name === "OverconstrainedError" || err?.name === "NotReadableError") {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "environment" } });
      } catch (err2) {
        throw describeCameraError(err2);
      }
    }
    throw describeCameraError(err);
  }
}

async function enableContinuousFocus(track) {
  try {
    const caps = track.getCapabilities?.() || {};
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    }
  } catch {
    /* focus control is optional */
  }
}

// ---------- Decoders ----------

async function nativeQrSupported() {
  try {
    if (!("BarcodeDetector" in window)) return false;
    const formats = await window.BarcodeDetector.getSupportedFormats();
    return formats.includes("qr_code");
  } catch {
    return false;
  }
}

function createNativeDecoder() {
  const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
  return {
    engine: "native",
    ready: Promise.resolve(),
    async decode(video) {
      const codes = await detector.detect(video);
      const hit = codes.find((c) => c.rawValue);
      return hit ? hit.rawValue : null;
    },
    destroy() {},
  };
}

function createWorkerDecoder() {
  const worker = new Worker(new URL("./qr-worker.js", import.meta.url), { type: "module" });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const pending = new Map();
  let nextId = 1;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === "ready") resolveReady();
    else if (msg.type === "error") rejectReady(new Error(msg.message));
    else if (msg.type === "result") {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (!p) return;
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.text);
    }
  };
  worker.onerror = (e) => {
    rejectReady(new Error(e.message || "QR decoder failed to load"));
    pending.forEach((p) => p.reject(new Error("QR decoder crashed")));
    pending.clear();
  };
  worker.postMessage({ type: "init" });

  return {
    engine: "zxing",
    ready,
    decode(video) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const scale = Math.min(1, MAX_DECODE_SIDE / Math.max(vw, vh));
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.drawImage(video, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: "decode", id, width: w, height: h, buffer: data.buffer }, [data.buffer]);
      });
    },
    destroy() {
      worker.terminate();
    },
  };
}

let decoderPromise = null;

// Picks and loads the decoder once per page. Safe to call early and often.
export function prewarm() {
  if (!decoderPromise) {
    decoderPromise = (async () => {
      const decoder = (await nativeQrSupported()) ? createNativeDecoder() : createWorkerDecoder();
      decoder.ready.catch(() => {}); // surfaced by start() instead
      return decoder;
    })();
  }
  return decoderPromise;
}

// After repeated native failures, fall back to the worker decoder.
function replaceDecoder(current) {
  current.destroy();
  const decoder = createWorkerDecoder();
  decoder.ready.catch(() => {});
  decoderPromise = Promise.resolve(decoder);
  return decoderPromise;
}

// ---------- Haptics ----------

let hapticLabel = null;
export function haptic() {
  try {
    if (typeof navigator.vibrate === "function" && navigator.vibrate(60)) return;
  } catch {
    /* fall through */
  }
  // iOS Safari has no Vibration API, but iOS 18+ plays a haptic tick when a
  // <input type="checkbox" switch> is toggled through its label.
  try {
    if (!hapticLabel) {
      hapticLabel = document.createElement("label");
      hapticLabel.setAttribute("aria-hidden", "true");
      hapticLabel.style.cssText = "position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-9999px;top:0;";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("switch", "");
      input.tabIndex = -1;
      hapticLabel.appendChild(input);
      document.body.appendChild(hapticLabel);
    }
    hapticLabel.click();
  } catch {
    /* no haptics on this device */
  }
}

// ---------- Scanner ----------

export class QrScanner {
  constructor(video, { onDecode, onState }) {
    this.video = video;
    this.onDecode = onDecode;
    this.onState = onState || (() => {});
    this.stream = null;
    this.decoder = null;
    this.running = false;
    this.busy = false;
    this.rafId = 0;
    this.lastDecodeAt = 0;
    this.pausedUntil = 0;
    this.lastText = null;
    this.lastSeenAt = 0;
    this.nativeFailures = 0;
    this.session = 0;
    this.tick = this.tick.bind(this);
  }

  get active() {
    return this.running || !!this.stream;
  }

  async start() {
    if (this.active) return;
    const session = ++this.session;
    this.onState("starting");
    performance.mark("scanner:start");

    // Open the camera and load the decoder at the same time.
    const decoderP = prewarm();
    let stream;
    try {
      stream = await openCamera();
    } catch (err) {
      if (session === this.session) this.onState("error", err);
      return;
    }
    if (session !== this.session) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    enableContinuousFocus(track);
    track.addEventListener("ended", () => {
      if (this.stream === stream) {
        this.stop();
        this.onState("error", new CameraError("busy", "The camera stopped. Tap Retry to start it again."));
      }
    });

    const video = this.video;
    video.srcObject = stream;
    try {
      await video.play();
    } catch (err) {
      if (session !== this.session) return;
      if (err?.name !== "AbortError") {
        this.stop();
        this.onState("error", new CameraError("other", `Couldn't play the camera (${err?.name || err}).`));
        return;
      }
    }
    if (session !== this.session) return;
    performance.mark("scanner:camera-ready");

    try {
      this.decoder = await decoderP;
      await this.decoder.ready;
    } catch (err) {
      if (session !== this.session) return;
      this.stop();
      this.onState("error", new CameraError("decoder", `Couldn't load the QR decoder (${err?.message || err}). Use manual entry.`));
      return;
    }
    if (session !== this.session) return;

    this.running = true;
    this.pausedUntil = 0;
    this.onState("scanning", { engine: this.decoder.engine });
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop() {
    this.session++;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.video.pause();
    this.video.srcObject = null;
    this.onState("stopped");
  }

  tick() {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);
    const now = performance.now();
    if (this.busy || now < this.pausedUntil || now - this.lastDecodeAt < MIN_FRAME_GAP_MS) return;
    const video = this.video;
    if (video.readyState < 2 || !video.videoWidth) return;

    this.busy = true;
    this.lastDecodeAt = now;
    const session = this.session;
    const decoder = this.decoder;
    decoder
      .decode(video)
      .then((text) => {
        this.nativeFailures = 0;
        if (session === this.session && this.running && text) this.handleText(text);
      })
      .catch(async (err) => {
        if (decoder.engine === "native" && ++this.nativeFailures >= 3 && session === this.session) {
          console.warn("BarcodeDetector failing; switching to the WebAssembly decoder", err);
          this.nativeFailures = 0;
          const next = await replaceDecoder(decoder);
          if (session === this.session) {
            this.decoder = next;
            this.onState("scanning", { engine: next.engine });
          }
        }
      })
      .finally(() => {
        this.busy = false;
      });
  }

  handleText(raw) {
    const text = String(raw).trim();
    if (!text) return;
    const now = performance.now();
    const repeat = text === this.lastText && now - this.lastSeenAt < SAME_CODE_GAP_MS;
    this.lastText = text;
    this.lastSeenAt = now;
    if (repeat) return; // still the same code in front of the camera
    if (!performance.getEntriesByName("scanner:first-decode").length) performance.mark("scanner:first-decode");
    this.pausedUntil = now + PAUSE_AFTER_HIT_MS;
    haptic();
    this.onDecode(text);
  }
}
