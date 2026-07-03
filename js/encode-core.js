/* ============================================================================
   FreeCompressor — encode-core.js  (ES module)
   The single source of truth for image encoding. Runs verbatim in two places:
     • the encode worker  (platform = OffscreenCanvas + eval-loaded UPNG + AVIF)
     • the main thread     (fallback platform = <canvas> + window.UPNG + AVIF)
   Keeping ONE implementation means the target-size search, auto-format choice
   and crop/resize maths can never drift between the fast path and the fallback.

   A "platform" object abstracts the two environments:
     { makeCanvas(w,h), toBlob(canvas, mime, quality) -> Promise<Blob>,
       upng() -> Promise<UPNG>, avif() -> Promise<encodeAVIF> }

   Hooks (all optional):
     { shouldCancel() -> bool, onPhase(phase, pct) }
   ========================================================================== */

export const CANCELLED = "FC_CANCELLED";
const TOLERANCE = 0.05; // ±5% — stop the search once we're this close under target
const MAX_ITERS = 8;    // binary-search steps after the two boundary probes

/* ---- crop + resize geometry --------------------------------------------- */
// Given the source dimensions and the user's crop (normalized 0..1) + resize
// options, compute the source draw-rect and the output canvas size. Crop is
// applied first (it redefines the "base" image), then resize operates on it.
export function computeDims(sw, sh, opts) {
  const rz = opts.resize || { mode: "off" };
  let ox = 0, oy = 0, baseW = sw, baseH = sh;
  if (opts.crop && opts.crop.w > 0 && opts.crop.h > 0) {
    ox = Math.round(opts.crop.x * sw);
    oy = Math.round(opts.crop.y * sh);
    baseW = Math.max(1, Math.round(opts.crop.w * sw));
    baseH = Math.max(1, Math.round(opts.crop.h * sh));
    // Clamp so the draw-rect never spills past the source edges.
    ox = Math.min(ox, sw - baseW); oy = Math.min(oy, sh - baseH);
    ox = Math.max(0, ox); oy = Math.max(0, oy);
  }

  let outW = baseW, outH = baseH, fillCrop = null;
  if (rz.mode === "edge" && rz.edge > 0) {
    const scale = Math.min(1, rz.edge / Math.max(baseW, baseH)); // never upscale
    outW = Math.max(1, Math.round(baseW * scale));
    outH = Math.max(1, Math.round(baseH * scale));
  } else if (rz.mode === "custom" && (rz.w || rz.h)) {
    const W = rz.w || baseW, H = rz.h || baseH;
    if (rz.fill) {
      const cov = Math.max(W / baseW, H / baseH);
      const cw = W / cov, ch = H / cov;                 // source rect that covers
      fillCrop = { sx: ox + (baseW - cw) / 2, sy: oy + (baseH - ch) / 2, sw: cw, sh: ch };
      outW = W; outH = H;
    } else {
      const s = Math.min(W / baseW, H / baseH, 1);      // fit within, no upscale
      outW = Math.max(1, Math.round(baseW * s));
      outH = Math.max(1, Math.round(baseH * s));
    }
  }
  return { ox, oy, baseW, baseH, outW, outH, fillCrop };
}

function drawRender(canvas, bmp, dims) {
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (dims.fillCrop) {
    const f = dims.fillCrop;
    ctx.drawImage(bmp, f.sx, f.sy, f.sw, f.sh, 0, 0, dims.outW, dims.outH);
  } else {
    ctx.drawImage(bmp, dims.ox, dims.oy, dims.baseW, dims.baseH, 0, 0, dims.outW, dims.outH);
  }
}

/* ---- format resolution --------------------------------------------------- */
export function resolveConcrete(opts) {
  if (opts.fmt && opts.fmt !== "orig") return opts.fmt;
  const s = opts.srcType;
  if (s === "png" || s === "jpeg") return s;
  if (s === "webp" && opts.webpOK) return "webp";
  return opts.webpOK ? "webp" : "jpeg"; // gif/avif/heic/bmp → smallest re-encodable
}
export function isAuto(opts) { return opts.target > 0 && (!opts.fmt || opts.fmt === "orig"); }

function colorsForQ(q) { return q >= 100 ? 0 : Math.max(2, Math.round((q / 100) * 256)); }
function clampQ(q) { return Math.max(0.02, Math.min(1, q / 100)); }

/* ---- the encoder --------------------------------------------------------- */
// Returns { blob, size, width, height, fmt, quality, missed, mode }.
export async function encode(bmp, opts, platform, hooks) {
  hooks = hooks || {};
  const check = hooks.shouldCancel || (() => false);
  const phase = hooks.onPhase || (() => {});
  const bail = () => { if (check()) throw new Error(CANCELLED); };

  const sw = bmp.width, sh = bmp.height;
  const dims = computeDims(sw, sh, opts);
  bail();
  phase("compressing", 10);

  // Render once. Every quality probe re-encodes these pixels — never re-renders.
  const rc = platform.makeCanvas(dims.outW, dims.outH);
  drawRender(rc, bmp, dims);

  // Lazily-built shared intermediates, reused across every probe.
  let _id = null, _flat = null, _hasAlpha = null;
  function imageData() {
    if (!_id) _id = rc.getContext("2d").getImageData(0, 0, dims.outW, dims.outH);
    return _id;
  }
  function flattened() {
    if (!_flat) {
      _flat = platform.makeCanvas(dims.outW, dims.outH);
      const fx = _flat.getContext("2d");
      fx.fillStyle = "#ffffff"; fx.fillRect(0, 0, dims.outW, dims.outH);
      fx.drawImage(rc, 0, 0);
    }
    return _flat;
  }
  function hasAlpha() {
    if (_hasAlpha == null) {
      const d = imageData().data;
      _hasAlpha = false;
      for (let i = 3; i < d.length; i += 4) { if (d[i] < 255) { _hasAlpha = true; break; } }
    }
    return _hasAlpha;
  }

  async function encodeAt(fmt, q) {
    bail();
    if (fmt === "png") {
      const UPNG = await platform.upng();
      const id = imageData();
      const buf = UPNG.encode([id.data.buffer.slice(0)], dims.outW, dims.outH, colorsForQ(q));
      return new Blob([buf], { type: "image/png" });
    }
    if (fmt === "avif") {
      const enc = await platform.avif();
      return enc(imageData(), q);
    }
    if (fmt === "jpeg") return platform.toBlob(flattened(), "image/jpeg", clampQ(q));
    return platform.toBlob(rc, "image/webp", clampQ(q));
  }

  // Highest quality whose output is ≤ target; early-exit within TOLERANCE.
  async function search(fmt) {
    const top = await encodeAt(fmt, 100);
    if (top.size <= opts.target) return { blob: top, quality: 100, missed: false };
    const bottom = await encodeAt(fmt, 2);
    if (bottom.size > opts.target) return { blob: bottom, quality: 2, missed: true };
    let best = bottom, bestQ = 2, lo = 3, hi = 99;
    for (let i = 0; i < MAX_ITERS && lo <= hi; i++) {
      bail();
      phase("optimizing", 30 + Math.round((i / MAX_ITERS) * 60));
      const mid = Math.round((lo + hi) / 2);
      const b = await encodeAt(fmt, mid);
      if (b.size <= opts.target) {
        best = b; bestQ = mid; lo = mid + 1;
        if (b.size >= opts.target * (1 - TOLERANCE)) break; // close enough, keep quality
      } else { hi = mid - 1; }
    }
    return { blob: best, quality: bestQ, missed: false };
  }

  let result;
  if (opts.target > 0 && isAuto(opts)) {
    // Auto: lossless PNG if it fits, else the best-quality lossy that fits.
    phase("optimizing", 15);
    const png0 = await encodeAt("png", 100);
    if (png0.size <= opts.target) {
      result = { blob: png0, quality: 100, missed: false, fmt: "png" };
    } else {
      const alpha = hasAlpha();
      const cands = [];
      if (opts.webpOK) cands.push("webp");
      if (!alpha) cands.push("jpeg");
      cands.push("avif");   // strongest quality-per-byte for very tight targets
      cands.push("png");    // palette fallback, always works
      let best = null;
      result = null;
      for (const f of cands) {
        let r;
        try { r = await search(f); }
        catch (e) { if (e && e.message === CANCELLED) throw e; continue; } // e.g. AVIF wasm failed to load — skip it
        if (!r.missed) { result = { blob: r.blob, quality: r.quality, missed: false, fmt: f }; break; }
        if (!best || r.blob.size < best.blob.size) best = { blob: r.blob, quality: r.quality, fmt: f };
      }
      // Guaranteed fallback: the lossless PNG probe above always produced a blob.
      if (!result) result = best ? { blob: best.blob, quality: best.quality, missed: true, fmt: best.fmt }
        : { blob: png0, quality: 100, missed: true, fmt: "png" };
    }
  } else if (opts.target > 0) {
    const fmt = resolveConcrete(opts);
    const r = await search(fmt);
    result = { blob: r.blob, quality: r.quality, missed: r.missed, fmt };
  } else {
    const fmt = resolveConcrete(opts);
    const blob = await encodeAt(fmt, opts.quality);
    const q = fmt === "png" ? (opts.quality >= 100 ? 100 : opts.quality) : opts.quality;
    result = { blob, quality: q, missed: false, fmt };
  }

  phase("compressing", 100);
  return {
    blob: result.blob, size: result.blob.size,
    width: dims.outW, height: dims.outH,
    fmt: result.fmt, quality: result.quality, missed: result.missed,
    mode: isAuto(opts) ? "auto" : opts.target > 0 ? "target" : "quality",
  };
}
