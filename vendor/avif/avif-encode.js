/* Minimal single-thread AVIF encoder wrapper around the vendored jSquash
   (Squoosh) libavif build. ESM — loaded on demand via dynamic import() only
   when the user actually picks AVIF output, so the 3.5 MB wasm never loads
   otherwise. Single-thread only: multithread needs cross-origin isolation
   (COOP/COEP) that a static host doesn't provide.
   Source: @jsquash/avif (Apache-2.0). */
import Module from "./avif_enc.js";

var modP = null;
var DEFAULTS = {
  quality: 50, qualityAlpha: -1, denoiseLevel: 0,
  tileColsLog2: 0, tileRowsLog2: 0, speed: 8, subsample: 1,
  chromaDeltaQ: false, sharpness: 0, tune: 0,
  enableSharpYUV: false, bitDepth: 8, lossless: false,
};

// imageData: { data: Uint8ClampedArray (RGBA), width, height }
// quality: 1..100  → returns a Blob (image/avif)
export async function encodeAVIF(imageData, quality) {
  if (!modP) modP = Module({ noInitialRun: true });
  var mod = await modP;
  var opts = Object.assign({}, DEFAULTS, { quality: Math.max(1, Math.min(100, Math.round(quality))) });
  var out = mod.encode(new Uint8Array(imageData.data.buffer), imageData.width, imageData.height, opts);
  if (!out) throw new Error("AVIF encode failed");
  return new Blob([out], { type: "image/avif" });
}
