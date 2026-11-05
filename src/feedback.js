// Scan feedback: a short sound and a vibration per result.
//
//   success   rising chirp 880 → 1320 Hz (2 × 70 ms)   vibrate 30
//   warning   two flat blips at 660 Hz (already in)    vibrate [40, 60, 40]
//   error     low 220 Hz square buzz (180 ms)          vibrate [120, 60, 120]
//
// Sounds use Web Audio (no files). iOS only lets a page make sound after a
// user gesture, so the AudioContext is created/resumed on the first tap
// (Start camera, Check in, anything). navigator.vibrate works on Android
// Chrome; iPhones rely on the sound and the camera-frame flash.

const MUTE_KEY = "datahacks-checkin:muted";

let ctx = null;
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
})();

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = !!value;
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (!muted) unlockAudio();
}

// Call from a user gesture.
export function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    if (!ctx) ctx = new AC();
    if (ctx.state === "suspended") ctx.resume();
    // A silent blip finishes the unlock on older iOS.
    const buffer = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    /* no audio on this device */
  }
}

// Any first tap or key unlocks audio; the listeners remove themselves once it runs.
function onFirstGesture() {
  unlockAudio();
  if (ctx && ctx.state === "running") {
    ["pointerdown", "keydown", "touchend"].forEach((t) => document.removeEventListener(t, onFirstGesture, true));
  }
}
["pointerdown", "keydown", "touchend"].forEach((t) => document.addEventListener(t, onFirstGesture, true));

function tone(freq, start, duration, { type = "sine", gain = 0.16, endFreq } = {}) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, start + duration);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.008);
  amp.gain.setValueAtTime(gain, start + duration - 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(amp).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function playSound(kind) {
  if (muted || !ctx || ctx.state !== "running") return;
  const t = ctx.currentTime + 0.01;
  if (kind === "success") {
    tone(880, t, 0.07);
    tone(1320, t + 0.08, 0.07);
  } else if (kind === "warning") {
    tone(660, t, 0.07, { type: "triangle", gain: 0.2 });
    tone(660, t + 0.13, 0.07, { type: "triangle", gain: 0.2 });
  } else if (kind === "error") {
    tone(220, t, 0.18, { type: "square", gain: 0.07 });
  }
}

const PATTERNS = { success: 30, warning: [40, 60, 40], error: [120, 60, 120] };

let hapticLabel = null;
function vibrate(kind) {
  const pattern = PATTERNS[kind];
  if (!pattern) return;
  try {
    if (typeof navigator.vibrate === "function" && navigator.vibrate(pattern)) return;
  } catch {
    /* fall through */
  }
  // iOS 18+ plays a haptic tick when an <input type="checkbox" switch> is
  // toggled through its label (only inside a user gesture, so manual entry).
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

export function feedback(kind) {
  playSound(kind);
  vibrate(kind);
}
