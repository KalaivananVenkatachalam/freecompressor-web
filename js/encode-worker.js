/* ============================================================================
   FreeCompressor — encode-worker.js  (module worker)
   Runs the whole decode → render → encode pipeline off the main thread so the
   UI never freezes, even for big batches. One decoded ImageBitmap is cached per
   file (small bounded LRU) so live-preview re-encodes don't re-decode.

   UPNG + pako are classic globals; they're eval-loaded here (the site CSP grants
   'unsafe-eval') because a module worker can't importScripts(). AVIF is an ESM
   loaded via dynamic import(). Both load lazily, only when first needed.
   ========================================================================== */
import { encode, CANCELLED } from "./encode-core.js";

const post = (m, transfer) => self.postMessage(m, transfer || []);

/* ---- lazy library loading ------------------------------------------------ */
let upngP = null;
function ensureUPNG() {
  if (!upngP) upngP = (async () => {
    self.window = self; // upng.js does `window.UPNG = …` and reads `window.pako`
    const [pakoSrc, upngSrc] = await Promise.all([
      fetch("/vendor/pako.min.js").then((r) => r.text()),
      fetch("/vendor/upng.js").then((r) => r.text()),
    ]);
    (0, eval)(pakoSrc);
    (0, eval)(upngSrc);
    if (!self.UPNG) throw new Error("PNG encoder failed to load");
    return self.UPNG;
  })();
  return upngP;
}

let avifP = null;
function ensureAVIF() {
  if (!avifP) avifP = import("/vendor/avif/avif-encode.js").then((m) => m.encodeAVIF);
  return avifP;
}

const platform = {
  makeCanvas: (w, h) => new OffscreenCanvas(w, h),
  toBlob: (canvas, type, quality) => canvas.convertToBlob({ type, quality }),
  upng: ensureUPNG,
  avif: ensureAVIF,
};

/* ---- decoded-bitmap cache (LRU) ------------------------------------------ */
const cache = new Map(); // fileId -> ImageBitmap
const MAX_CACHE = 3;
async function getBitmap(fileId, blob) {
  const hit = cache.get(fileId);
  if (hit) { cache.delete(fileId); cache.set(fileId, hit); return hit; } // touch
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }); }
  catch (e) { bmp = await createImageBitmap(blob); }
  cache.set(fileId, bmp);
  while (cache.size > MAX_CACHE) {
    const k = cache.keys().next().value;
    const old = cache.get(k); cache.delete(k);
    try { old.close(); } catch (e) {}
  }
  return bmp;
}
function forget(fileId) {
  const b = cache.get(fileId);
  if (b) { try { b.close(); } catch (e) {} cache.delete(fileId); }
}

/* ---- job handling -------------------------------------------------------- */
const canceled = new Set();

async function handleEncode(m) {
  const { jobId, fileId, blob, opts } = m;
  // Workers run one job at a time, so any leftover cancel tokens are stale
  // (late cancels for already-finished jobs) — clearing them bounds the Set.
  canceled.clear();
  try {
    post({ type: "progress", jobId, phase: "decoding", pct: 0 });
    const bmp = await getBitmap(fileId, blob);
    if (canceled.has(jobId)) { canceled.delete(jobId); post({ type: "canceled", jobId }); return; }
    const out = await encode(bmp, opts, platform, {
      shouldCancel: () => canceled.has(jobId),
      onPhase: (phase, pct) => post({ type: "progress", jobId, phase, pct }),
    });
    canceled.delete(jobId);
    post({
      type: "done", jobId, blob: out.blob, size: out.size,
      width: out.width, height: out.height, fmt: out.fmt,
      quality: out.quality, missed: out.missed, mode: out.mode,
    });
  } catch (err) {
    canceled.delete(jobId);
    if (err && err.message === CANCELLED) post({ type: "canceled", jobId });
    else post({ type: "error", jobId, message: (err && err.message) || String(err) });
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "encode") handleEncode(m);
  else if (m.type === "cancel") canceled.add(m.jobId);
  else if (m.type === "forget") forget(m.fileId);
};

/* ---- capability handshake ------------------------------------------------ */
(async function ready() {
  const caps = { ok: false, webp: false, offscreen: typeof OffscreenCanvas !== "undefined" };
  try {
    const c = new OffscreenCanvas(2, 2);
    c.getContext("2d").fillRect(0, 0, 2, 2);
    const b = await c.convertToBlob({ type: "image/webp", quality: 0.5 });
    caps.ok = true;
    caps.webp = b.type === "image/webp";
  } catch (e) { caps.ok = false; }
  post({ type: "ready", caps });
})();
