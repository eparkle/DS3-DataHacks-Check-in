// QR decoding off the main thread for browsers without a native
// BarcodeDetector (iOS Safari, Firefox). ZXing-C++ compiled to WebAssembly.
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

// Serve the .wasm from this site instead of the library's default CDN, and
// start compiling it as soon as the worker loads.
const ready = prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) => (path.endsWith(".wasm") ? new URL(wasmUrl, self.location.origin).href : prefix + path),
  },
  fireImmediately: true,
});

// Live video: one QR per frame. tryHarder stays on (about 1ms more per
// 1280x720 frame, better on blurry or angled codes); rotation passes are
// pointless for QR and inverted (light-on-dark) passes aren't needed.
const OPTIONS = {
  formats: ["QRCode"],
  maxNumberOfSymbols: 1,
  tryHarder: true,
  tryRotate: false,
  tryInvert: false,
};

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    try {
      await ready;
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err?.message || err) });
    }
    return;
  }
  if (msg.type === "decode") {
    let text = null;
    try {
      await ready;
      const image = new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
      const results = await readBarcodes(image, OPTIONS);
      const hit = results.find((r) => r.isValid && r.text);
      text = hit ? hit.text : null;
    } catch (err) {
      self.postMessage({ type: "result", id: msg.id, text: null, error: String(err?.message || err) });
      return;
    }
    self.postMessage({ type: "result", id: msg.id, text });
  }
};
