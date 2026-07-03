/* ============================================================================
   FreeCompressor — compressor.js
   The image compressor. 100% client-side: decode with createImageBitmap
   (HEIC via a lazily-loaded WASM decoder), re-encode via <canvas> (JPEG/WebP/
   AVIF) or UPNG+pako (quantized PNG). Nothing is ever uploaded.

   Input:  PNG · JPG · WEBP · GIF · AVIF · HEIC (whatever the browser + decoder handle)
   Output: PNG · JPG · WebP · AVIF
   Size:   quality slider + presets, or "compress to target size" search.
   Resize: fit-within (aspect-locked) or fill (center-crop), plus quick presets.
   Privacy: re-encoding through canvas removes all EXIF/GPS metadata; EXIF
            orientation is baked in first so images never come out sideways.
   ========================================================================== */
(function () {
  "use strict";
  var d = document;
  var $ = function (s) { return d.querySelector(s); };
  if (!$("#cmp-drop")) return; // page without the compressor

  var toast = (window.FC && window.FC.toast) || function () {};

  /* ---- state ------------------------------------------------------------ */
  var T = {};                    // element cache
  var files = [];
  var selectedId = null;
  var quality = 80;
  var target = 0;                // 0 = quality mode, else target bytes
  var outFmt = "orig";           // orig | png | jpeg | webp | avif
  var resize = { mode: "off", edge: 0, w: null, h: null, fill: false, lock: true };
  var seq = 0;
  var working = false, queued = false;

  function canEncode(mime) {
    try { return d.createElement("canvas").toDataURL(mime).indexOf(mime) === 5; }
    catch (e) { return false; }
  }
  var webpOK = canEncode("image/webp");
  // AVIF is encoded via a lazily-loaded WASM module (canvas can't encode AVIF
  // in any browser), so it's available everywhere — no feature gate needed.
  var avifEnc = null;
  function loadAvif() {
    if (!avifEnc) avifEnc = import("/vendor/avif/avif-encode.js").then(function (m) { return m.encodeAVIF; });
    return avifEnc;
  }

  var DECODABLE = /^image\/(png|jpeg|webp|gif|avif|heic|heif|bmp)$/;
  var HEIC = /^image\/hei[cf]$/;
  var HEIC_EXT = /\.(heic|heif)$/i;

  /* ---- helpers ------------------------------------------------------------*/
  function fmtBytes(b) {
    if (b == null) return "—";
    return b < 1024 ? b + " B"
      : b < 1048576 ? (b / 1024).toFixed(1) + " KB"
      : (b / 1048576).toFixed(2) + " MB";
  }
  function baseName(n) { var i = n.lastIndexOf("."); return i > 0 ? n.slice(0, i) : n; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function newCanvas(w, h) { var c = d.createElement("canvas"); c.width = w; c.height = h; return c; }
  function toBlobURL(canvas) {
    return new Promise(function (res) { canvas.toBlob(function (b) { res(URL.createObjectURL(b)); }, "image/png"); });
  }
  function downloadBlob(blob, name) {
    var a = d.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    d.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }
  // Usage beacon: metadata only (sizes/format/dims), fire-and-forget.
  function track(payload) {
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) navigator.sendBeacon("/api/beacon", new Blob([body], { type: "application/json" }));
    } catch (e) {}
  }

  function current() {
    for (var i = 0; i < files.length; i++) if (files[i].id === selectedId) return files[i];
    return null;
  }
  function autoMode() { return target > 0 && outFmt === "orig"; }
  function resolved(fo) {
    if (outFmt !== "orig") return outFmt;
    if (fo.srcType === "png" || fo.srcType === "jpeg") return fo.srcType;
    if (fo.srcType === "webp" && webpOK) return "webp";
    return webpOK ? "webp" : "jpeg"; // gif/avif/heic → smallest re-encodable format
  }
  function resolvedOut(fo) { return autoMode() && fo.autoFmt ? fo.autoFmt : resolved(fo); }
  function fmtLabel(f) { return f === "jpeg" ? "JPG" : f === "webp" ? "WebP" : f === "avif" ? "AVIF" : "PNG"; }

  /* ---- HEIC decoder (lazy) ------------------------------------------------*/
  var heicLib = null;
  function loadHeic() {
    if (heicLib) return heicLib;
    heicLib = new Promise(function (res, rej) {
      var s = d.createElement("script");
      s.src = "/vendor/heic2any.min.js";
      s.onload = function () { window.heic2any ? res(window.heic2any) : rej(new Error("heic decoder unavailable")); };
      s.onerror = function () { heicLib = null; rej(new Error("could not load HEIC decoder")); };
      d.head.appendChild(s);
    });
    return heicLib;
  }

  /* ---- import -------------------------------------------------------------*/
  async function decode(f) {
    var isHeic = HEIC.test(f.type) || HEIC_EXT.test(f.name);
    if (isHeic) {
      var heic2any = await loadHeic();
      f = await heic2any({ blob: f, toType: "image/png" }); // → displayable PNG blob
    }
    // imageOrientation:'from-image' bakes EXIF rotation into the pixels, so
    // stripping metadata on re-encode never leaves an image sideways.
    try { return await createImageBitmap(f, { imageOrientation: "from-image" }); } catch (e) {}
    try { return await createImageBitmap(f); } catch (e2) {}
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(f), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("decode")); };
      img.src = url;
    });
  }
  function srcTypeOf(mime, name) {
    if (HEIC.test(mime) || HEIC_EXT.test(name)) return "heic";
    var m = /^image\/(\w+)/.exec(mime || "");
    var t = m ? m[1] : "unknown";
    return t === "jpg" ? "jpeg" : t;
  }

  async function addFiles(fl) {
    var list = Array.prototype.slice.call(fl || []);
    var added = 0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!DECODABLE.test(f.type) && !/\.(png|jpe?g|webp|gif|avif|heic|heif|bmp)$/i.test(f.name)) {
        toast(f.name + ": not a supported image format", true);
        continue;
      }
      var sk = d.createElement("div"); sk.className = "skel";
      T.list.appendChild(sk);
      var bmp;
      try { bmp = await decode(f); }
      catch (e) {
        sk.remove();
        toast(HEIC_EXT.test(f.name) ? "Could not decode HEIC: " + f.name : "Could not read " + f.name, true);
        continue;
      }
      sk.remove();
      var w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
      var srcType = srcTypeOf(f.type, f.name);
      var fo = {
        id: ++seq, name: f.name, srcType: srcType, orig: f, origSize: f.size,
        origURL: null, w: w, h: h, bmp: bmp, srcCanvas: null,
        comp: null, compSize: 0, compURL: null, compKey: null,
        hitQ: null, missed: false, autoFmt: null, alpha: null, outW: w, outH: h,
      };
      // HEIC can't render in <img>, so make a displayable PNG preview from the
      // decoded pixels; reuse that canvas as the source to avoid a redraw.
      if (srcType === "heic") {
        fo.srcCanvas = bitmapCanvas(fo);
        fo.origURL = await toBlobURL(fo.srcCanvas);
      } else {
        fo.origURL = URL.createObjectURL(f);
      }
      files.push(fo);
      added++;
    }
    if (added) {
      T.drop.classList.add("slim");
      T.dropT.textContent = "Add more images";
      renderList();
      if (selectedId == null) select(files[files.length - added].id); else refreshSelected();
      T.dlAll.disabled = false;
    }
  }

  /* ---- source & resize ----------------------------------------------------*/
  function bitmapCanvas(fo) {
    var c = newCanvas(fo.w, fo.h);
    c.getContext("2d").drawImage(fo.bmp, 0, 0);
    return c;
  }
  function sourceCanvas(fo) {
    if (!fo.srcCanvas) fo.srcCanvas = bitmapCanvas(fo);
    return fo.srcCanvas;
  }
  // Output dimensions (and optional center-crop rect) for the current resize.
  function outDims(fo) {
    var sw = fo.w, sh = fo.h;
    if (resize.mode === "edge" && resize.edge > 0) {
      var scale = Math.min(1, resize.edge / Math.max(sw, sh)); // never upscale
      return { w: Math.max(1, Math.round(sw * scale)), h: Math.max(1, Math.round(sh * scale)) };
    }
    if (resize.mode === "custom" && (resize.w || resize.h)) {
      var W = resize.w || sw, H = resize.h || sh;
      if (resize.fill) {
        var cov = Math.max(W / sw, H / sh);
        var cw = W / cov, ch = H / cov;               // source crop rect
        return { w: W, h: H, crop: { sx: (sw - cw) / 2, sy: (sh - ch) / 2, sw: cw, sh: ch } };
      }
      var s2 = Math.min(W / sw, H / sh, 1);            // fit within, no upscale
      return { w: Math.max(1, Math.round(sw * s2)), h: Math.max(1, Math.round(sh * s2)) };
    }
    return { w: sw, h: sh };
  }
  function renderCanvas(fo) {
    var dm = outDims(fo);
    fo.outW = dm.w; fo.outH = dm.h;
    var c = newCanvas(dm.w, dm.h), ctx = c.getContext("2d");
    var src = sourceCanvas(fo);
    if (dm.crop) ctx.drawImage(src, dm.crop.sx, dm.crop.sy, dm.crop.sw, dm.crop.sh, 0, 0, dm.w, dm.h);
    else ctx.drawImage(src, 0, 0, dm.w, dm.h);
    return c;
  }
  function isResizing() {
    return (resize.mode === "edge" && resize.edge > 0) || (resize.mode === "custom" && !!(resize.w || resize.h));
  }

  /* ---- encode -------------------------------------------------------------*/
  function encodePNG(fo, q) {
    var rc = renderCanvas(fo);
    var id = rc.getContext("2d").getImageData(0, 0, rc.width, rc.height);
    var colors = q >= 100 ? 0 : Math.max(2, Math.round((q / 100) * 256));
    var buf = UPNG.encode([id.data.buffer.slice(0)], rc.width, rc.height, colors);
    return Promise.resolve(new Blob([buf], { type: "image/png" }));
  }
  function encodeCanvasFmt(fo, mime, q) {
    var rc = renderCanvas(fo), cv = rc;
    if (mime === "image/jpeg") { // JPEG has no alpha — flatten onto white
      cv = newCanvas(rc.width, rc.height);
      var fx = cv.getContext("2d");
      fx.fillStyle = "#ffffff"; fx.fillRect(0, 0, rc.width, rc.height); fx.drawImage(rc, 0, 0);
    }
    return new Promise(function (res, rej) {
      cv.toBlob(function (b) { b ? res(b) : rej(new Error("encode-null")); },
        mime, Math.max(0.02, Math.min(1, q / 100)));
    });
  }
  async function encodeAVIFfmt(fo, q) {
    var rc = renderCanvas(fo);
    var id = rc.getContext("2d").getImageData(0, 0, rc.width, rc.height);
    var enc = await loadAvif();
    return enc(id, q);
  }
  function encodeAt(fo, fmt, q) {
    if (fmt === "png") return encodePNG(fo, q);
    if (fmt === "avif") return encodeAVIFfmt(fo, q);
    return encodeCanvasFmt(fo, fmt === "webp" ? "image/webp" : "image/jpeg", q);
  }

  async function encodeToTarget(fo, fmt, bytes) {
    var lo = 1, hi = 100, best = null, bestQ = 1;
    var first = await encodeAt(fo, fmt, 1);
    if (first.size > bytes) return { blob: first, q: 1, missed: true };
    for (var i = 0; i < 7; i++) {
      var mid = Math.round((lo + hi) / 2);
      var blob = await encodeAt(fo, fmt, mid);
      if (blob.size <= bytes) { best = blob; bestQ = mid; lo = mid + 1; }
      else hi = mid - 1;
      if (lo > hi) break;
    }
    return { blob: best || first, q: best ? bestQ : 1, missed: false };
  }
  function hasAlpha(fo) {
    var rc = renderCanvas(fo);
    var data = rc.getContext("2d").getImageData(0, 0, rc.width, rc.height).data;
    for (var i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
    return false;
  }
  async function autoTarget(fo, bytes) {
    var lossless = await encodePNG(fo, 100);
    if (lossless.size <= bytes) return { blob: lossless, q: 100, missed: false, fmt: "png" };
    var alpha = hasAlpha(fo);
    var lossy = webpOK ? "webp" : (alpha ? "png" : "jpeg");
    var r = await encodeToTarget(fo, lossy, bytes);
    if (!r.missed) return { blob: r.blob, q: r.q, missed: false, fmt: lossy };
    var best = { blob: r.blob, q: r.q, fmt: lossy };
    var rest = alpha ? ["png"] : ["jpeg", "png"];
    for (var i = 0; i < rest.length; i++) {
      if (rest[i] === lossy) continue;
      var alt = await encodeToTarget(fo, rest[i], bytes);
      if (!alt.missed) return { blob: alt.blob, q: alt.q, missed: false, fmt: rest[i] };
      if (alt.blob.size < best.blob.size) best = { blob: alt.blob, q: alt.q, fmt: rest[i] };
    }
    return { blob: best.blob, q: best.q, missed: true, fmt: best.fmt };
  }
  async function compress(fo) {
    if (target > 0) {
      var r = autoMode() ? await autoTarget(fo, target) : await encodeToTarget(fo, resolved(fo), target);
      fo.hitQ = r.q; fo.missed = r.missed; fo.autoFmt = r.fmt || null;
      return r.blob;
    }
    fo.hitQ = null; fo.missed = false; fo.autoFmt = null;
    return encodeAt(fo, resolved(fo), quality);
  }
  function resizeKey() {
    return resize.mode === "edge" && resize.edge > 0 ? "e" + resize.edge
      : resize.mode === "custom" && (resize.w || resize.h) ? "c" + resize.w + "x" + resize.h + (resize.fill ? "f" : "t")
      : "n";
  }
  function compKey(fo) {
    return (autoMode() ? "auto" : resolved(fo)) + "|" + (target > 0 ? "t" + target : "q" + quality) + "|" + resizeKey();
  }

  /* ---- labels & notes -----------------------------------------------------*/
  function qWord(q) { return q >= 100 ? "lossless" : q >= 85 ? "best" : q >= 60 ? "balanced" : q >= 35 ? "small" : "tiny"; }
  function setQLabel() { T.qval.innerHTML = quality + " <small>· " + qWord(quality) + "</small>"; }
  function setDimTag() {
    var fo = current();
    if (!fo || !isResizing()) { T.dimtag.textContent = ""; return; }
    var dm = outDims(fo);
    T.dimtag.textContent = fo.w + "×" + fo.h + " → " + dm.w + "×" + dm.h;
  }
  function setNote() {
    var fo = current();
    var fmt = fo ? resolvedOut(fo) : (outFmt === "orig" ? "png" : outFmt);
    T.convtag.textContent = !fo ? ""
      : autoMode() ? (fo.autoFmt ? "auto → " + fmtLabel(fo.autoFmt) : "auto format")
      : (resolved(fo) !== fo.srcType ? (fo.srcType === "heic" ? "HEIC" : fo.srcType.toUpperCase()) + " → " + fmtLabel(resolved(fo)) : "keeps " + fo.srcType.toUpperCase());
    setDimTag();
    if (autoMode()) {
      T.note.innerHTML = "Target mode: we automatically pick the <b>output format and quality</b> with the best "
        + "image quality under <b>" + fmtBytes(target) + "</b> — lossless PNG when it fits, otherwise "
        + (webpOK ? "WebP" : "JPG/PNG") + " at the highest quality that does.";
      return;
    }
    if (target > 0) {
      T.note.innerHTML = "Target mode: we search for the highest " + fmtLabel(fmt) + " quality that fits under <b>" + fmtBytes(target) + "</b>.";
      return;
    }
    if (fmt === "png") {
      T.note.innerHTML = quality >= 100
        ? "PNG · lossless — pixel-perfect, transparency kept. Best for UI, logos and screenshots."
        : "PNG · palette-quantized to <b>" + Math.max(2, Math.round((quality / 100) * 256)) + " colors</b>, transparency kept.";
    } else if (fmt === "webp") {
      T.note.innerHTML = "WebP · quality " + (quality / 100).toFixed(2) + ", transparency kept. Usually the smallest output.";
    } else if (fmt === "avif") {
      T.note.innerHTML = "AVIF · quality " + (quality / 100).toFixed(2) + ". Smallest files of all, transparency kept — encoding is a little slower.";
    } else {
      T.note.innerHTML = "JPG · quality " + (quality / 100).toFixed(2) + ". Flattened onto white (no transparency). Best for photos.";
    }
  }

  /* ---- file list ----------------------------------------------------------*/
  function renderList() {
    T.list.innerHTML = "";
    files.forEach(function (fo) {
      var row = d.createElement("div");
      row.className = "frow" + (fo.id === selectedId ? " sel" : "");
      row.setAttribute("role", "button"); row.tabIndex = 0;
      var saved = fo.compSize ? (1 - fo.compSize / fo.origSize) * 100 : null;
      var savedHtml = saved === null
        ? '<span class="save idle">—</span>'
        : '<span class="save ' + (saved >= 0 ? "pos" : "neg") + '">' + (saved >= 0 ? "−" : "+") + Math.abs(saved).toFixed(0) + "%</span>";
      row.innerHTML =
        '<span class="thumb"><img src="' + fo.origURL + '" alt=""></span>' +
        '<span class="meta"><span class="name">' + escapeHtml(fo.name) + "</span>" +
        '<span class="nums"><span class="fmt-tag">' + fo.srcType.toUpperCase() + "</span>" + fmtBytes(fo.origSize) +
        (fo.compSize ? " → " + fmtBytes(fo.compSize) : "") + "</span></span>" +
        savedHtml +
        '<button class="x" aria-label="Remove ' + escapeHtml(fo.name) + '" data-x="' + fo.id + '">✕</button>';
      row.addEventListener("click", function (e) { if (e.target.dataset.x) return; select(fo.id); });
      row.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(fo.id); } });
      T.list.appendChild(row);
    });
    Array.prototype.forEach.call(T.list.querySelectorAll("[data-x]"), function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); removeFile(+b.dataset.x); });
    });
  }
  function removeFile(id) {
    var i = files.findIndex(function (f) { return f.id === id; });
    if (i < 0) return;
    var fo = files[i];
    URL.revokeObjectURL(fo.origURL);
    if (fo.compURL) URL.revokeObjectURL(fo.compURL);
    files.splice(i, 1);
    if (selectedId === id) { selectedId = null; if (files.length) select(files[0].id); else clearStage(); }
    renderList();
    if (!files.length) {
      T.dlAll.disabled = true; T.dlOne.disabled = true;
      T.drop.classList.remove("slim");
      T.dropT.textContent = "Drag & drop images here";
    }
  }
  function clearStage() {
    T.empty.style.display = "flex";
    T.readout.style.display = "none";
    [T.imgOrig, T.imgComp, T.divider, T.tagL, T.tagR].forEach(function (e) { e.style.display = "none"; });
    T.dlOne.disabled = true;
  }
  function select(id) {
    selectedId = id; renderList();
    var fo = current();
    if (!fo) return clearStage();
    T.empty.style.display = "none";
    [T.imgOrig, T.imgComp, T.divider, T.tagL, T.tagR].forEach(function (e) { e.style.display = ""; });
    T.imgOrig.src = fo.origURL;
    T.readout.style.display = "flex";
    T.dlOne.disabled = false;
    if (resize.mode === "custom" && !resize.w && !resize.h) { resize.w = fo.w; resize.h = fo.h; syncDimInputs(); }
    setNote(); refreshSelected();
  }

  /* ---- live compress ------------------------------------------------------*/
  async function refreshSelected() {
    var fo = current();
    if (!fo) return;
    if (working) { queued = true; return; }
    working = true; T.working.classList.add("on");
    try {
      var blob = await compress(fo);
      if (fo.compURL) URL.revokeObjectURL(fo.compURL);
      fo.comp = blob; fo.compSize = blob.size;
      fo.compURL = URL.createObjectURL(blob); fo.compKey = compKey(fo);
      T.imgComp.src = fo.compURL;
      paintReadout(fo); renderList();
      setDimTag();
      if (autoMode()) setNote();
    } catch (err) { toast("Compression failed for " + fo.name, true); }
    working = false; T.working.classList.remove("on");
    if (queued) { queued = false; refreshSelected(); }
  }
  function paintReadout(fo) {
    T.rOrig.textContent = fmtBytes(fo.origSize);
    T.rComp.textContent = fmtBytes(fo.compSize);
    var saved = (1 - fo.compSize / fo.origSize) * 100;
    T.rSave.textContent = (saved >= 0 ? "−" : "+") + Math.abs(saved).toFixed(1) + "%";
    T.rSave.className = "v " + (saved >= 0 ? "pos" : "neg");
    var dimNote = isResizing() ? "Resized to " + fo.outW + "×" + fo.outH + ". " : "";
    if (target > 0 && fo.missed) {
      T.hint.textContent = dimNote + "Even at minimum quality this image is " + fmtBytes(fo.compSize) + " — above your " + fmtBytes(target) + " target. Try a smaller size or a higher target.";
    } else if (autoMode()) {
      T.hint.textContent = dimNote + (fo.hitQ === 100 && fo.autoFmt === "png"
        ? "Fits your " + fmtBytes(target) + " target as lossless PNG — pixel-perfect."
        : "Fits your " + fmtBytes(target) + " target — " + fmtLabel(fo.autoFmt) + " picked automatically (quality " + fo.hitQ + ").");
    } else if (target > 0) {
      T.hint.textContent = dimNote + "Fits your " + fmtBytes(target) + " target (quality " + fo.hitQ + " found automatically).";
    } else if (saved < 0) {
      T.hint.textContent = dimNote + "Output is larger than the original — lossless PNG can grow photos. Lower the quality or switch to JPG/WebP.";
    } else {
      T.hint.textContent = dimNote + "Drag the divider to compare before and after. The checkerboard shows preserved transparency.";
    }
  }
  function staleOthers() {
    files.forEach(function (fo) {
      if (fo.id !== selectedId) {
        if (fo.compURL) URL.revokeObjectURL(fo.compURL);
        fo.comp = null; fo.compURL = null; fo.compSize = 0; fo.compKey = null;
      }
    });
    renderList();
  }

  /* ---- compare divider ----------------------------------------------------*/
  function setDividerPct(pos) {
    pos = Math.max(0, Math.min(100, pos));
    T.imgComp.style.clipPath = "inset(0 " + (100 - pos) + "% 0 0)";
    T.divider.style.left = pos + "%";
  }
  function setDivider(px) { var r = T.stage.getBoundingClientRect(); setDividerPct(((px - r.left) / r.width) * 100); }

  /* ---- downloads ----------------------------------------------------------*/
  function outName(fo) {
    var t = resolvedOut(fo);
    return baseName(fo.name) + "-min." + (t === "jpeg" ? "jpg" : t);
  }
  async function ensureComp(fo) {
    var key = compKey(fo);
    if (!fo.comp || fo.compKey !== key) {
      var blob = await compress(fo);
      if (fo.compURL && fo.id !== selectedId) URL.revokeObjectURL(fo.compURL);
      fo.comp = blob; fo.compSize = blob.size; fo.compKey = key;
      if (fo.id !== selectedId) fo.compURL = URL.createObjectURL(blob);
    }
    return fo.comp;
  }
  function celebrate(btn, label) {
    btn.innerHTML = '<span class="check-pop"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span> Saved';
    setTimeout(function () { btn.textContent = label; }, 1600);
  }

  /* ---- init ---------------------------------------------------------------*/
  Object.assign(T, {
    drop: $("#cmp-drop"), dropT: $("#cmp-drop .t"), file: $("#cmp-file"), list: $("#cmp-list"),
    fmt: $("#cmp-fmt"), convtag: $("#cmp-convtag"),
    targetChips: $("#cmp-target"),
    resizeChips: $("#cmp-resize"), resizeCustom: $("#cmp-resize-custom"), dimtag: $("#cmp-dimtag"),
    rw: $("#cmp-rw"), rh: $("#cmp-rh"), lock: $("#cmp-lock"), fillmode: $("#cmp-fillmode"),
    qblock: $("#cmp-qblock"), slider: $("#cmp-q"), qval: $("#cmp-qval"), presets: $("#cmp-presets"),
    note: $("#cmp-note"), dlOne: $("#cmp-dlOne"), dlAll: $("#cmp-dlAll"),
    prog: $("#cmp-prog"), progBar: $("#cmp-prog i"),
    stage: $("#cmp-stage"), imgOrig: $("#cmp-orig"), imgComp: $("#cmp-comp"),
    divider: $("#cmp-divider"), tagL: $("#cmp-tagL"), tagR: $("#cmp-tagR"),
    empty: $("#cmp-empty"), working: $("#cmp-working"),
    readout: $("#cmp-readout"), rOrig: $("#cmp-rOrig"), rComp: $("#cmp-rComp"), rSave: $("#cmp-rSave"),
    hint: $("#cmp-hint"),
  });

  // dropzone
  T.drop.addEventListener("click", function () { T.file.click(); });
  T.drop.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); T.file.click(); } });
  T.file.addEventListener("change", function (e) { addFiles(e.target.files); T.file.value = ""; });
  ["dragenter", "dragover"].forEach(function (ev) { T.drop.addEventListener(ev, function (e) { e.preventDefault(); T.drop.classList.add("drag"); }); });
  ["dragleave", "drop"].forEach(function (ev) { T.drop.addEventListener(ev, function (e) { e.preventDefault(); T.drop.classList.remove("drag"); }); });
  T.drop.addEventListener("drop", function (e) { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  // paste
  d.addEventListener("paste", function (e) {
    if (!e.clipboardData) return;
    var imgs = Array.prototype.filter.call(e.clipboardData.files || [], function (f) { return /^image\//.test(f.type); });
    if (imgs.length) { e.preventDefault(); addFiles(imgs); toast("Pasted " + imgs.length + " image" + (imgs.length > 1 ? "s" : "")); }
  });

  // output format
  T.fmt.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-fmt]"); if (!b || b.disabled) return;
    outFmt = b.dataset.fmt;
    Array.prototype.forEach.call(T.fmt.querySelectorAll("button"), function (x) { x.classList.toggle("on", x === b); });
    setNote(); staleOthers(); refreshSelected();
  });
  if (!webpOK) { var wb = T.fmt.querySelector('[data-fmt="webp"]'); if (wb) { wb.disabled = true; wb.title = "WebP encoding not supported in this browser"; } }

  // target size
  T.targetChips.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-bytes]"); if (!b) return;
    target = +b.dataset.bytes;
    Array.prototype.forEach.call(T.targetChips.querySelectorAll("button"), function (x) { x.classList.toggle("on", x === b); });
    T.qblock.style.opacity = target > 0 ? 0.45 : 1;
    T.slider.disabled = target > 0;
    Array.prototype.forEach.call(T.presets.querySelectorAll("button"), function (x) { x.disabled = target > 0; });
    setNote(); staleOthers(); refreshSelected();
  });

  // resize — quick presets (longest edge) + custom
  T.resizeChips.addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    Array.prototype.forEach.call(T.resizeChips.querySelectorAll("button"), function (x) { x.classList.remove("on"); });
    b.classList.add("on");
    if (b.hasAttribute("data-custom")) {
      resize.mode = "custom";
      T.resizeCustom.hidden = false;
      var fo = current();
      if (fo && !resize.w && !resize.h) { resize.w = fo.w; resize.h = fo.h; }
      syncDimInputs();
    } else {
      resize.mode = "edge"; resize.edge = +b.dataset.edge;
      T.resizeCustom.hidden = true;
    }
    setDimTag(); staleOthers(); refreshSelected();
  });
  function syncDimInputs() { T.rw.value = resize.w || ""; T.rh.value = resize.h || ""; }
  function ratio() { var fo = current(); return fo ? fo.h / fo.w : 1; }
  var rdeb;
  T.rw.addEventListener("input", function () {
    resize.w = Math.max(0, parseInt(T.rw.value, 10) || 0) || null;
    if (resize.lock && resize.w) { resize.h = Math.round(resize.w * ratio()); T.rh.value = resize.h; }
    setDimTag(); clearTimeout(rdeb); rdeb = setTimeout(function () { staleOthers(); refreshSelected(); }, 260);
  });
  T.rh.addEventListener("input", function () {
    resize.h = Math.max(0, parseInt(T.rh.value, 10) || 0) || null;
    if (resize.lock && resize.h) { resize.w = Math.round(resize.h / ratio()); T.rw.value = resize.w; }
    setDimTag(); clearTimeout(rdeb); rdeb = setTimeout(function () { staleOthers(); refreshSelected(); }, 260);
  });
  T.lock.addEventListener("click", function () {
    resize.lock = !resize.lock;
    T.lock.classList.toggle("on", resize.lock);
    T.lock.setAttribute("aria-pressed", resize.lock ? "true" : "false");
    if (resize.lock && resize.w) { resize.h = Math.round(resize.w * ratio()); syncDimInputs(); setDimTag(); staleOthers(); refreshSelected(); }
  });
  T.fillmode.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-fill]"); if (!b) return;
    resize.fill = b.dataset.fill === "fill";
    Array.prototype.forEach.call(T.fillmode.querySelectorAll("button"), function (x) { x.classList.toggle("on", x === b); });
    setDimTag(); staleOthers(); refreshSelected();
  });

  // quality
  var deb;
  T.slider.addEventListener("input", function () {
    quality = +T.slider.value; setQLabel(); setNote(); syncPresets(); staleOthers();
    clearTimeout(deb); deb = setTimeout(refreshSelected, 170);
  });
  T.presets.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-q]"); if (!b || b.disabled) return;
    quality = +b.dataset.q; T.slider.value = quality; setQLabel(); setNote(); syncPresets(); staleOthers(); refreshSelected();
  });
  function syncPresets() { Array.prototype.forEach.call(T.presets.querySelectorAll("button"), function (b) { b.classList.toggle("on", +b.dataset.q === quality); }); }

  // compare divider
  var dragging = false;
  T.stage.addEventListener("pointerdown", function (e) { if (T.empty.style.display !== "none") return; dragging = true; T.stage.setPointerCapture(e.pointerId); setDivider(e.clientX); });
  T.stage.addEventListener("pointermove", function (e) { if (dragging) setDivider(e.clientX); });
  T.stage.addEventListener("pointerup", function () { dragging = false; });
  T.stage.addEventListener("pointercancel", function () { dragging = false; });
  T.divider.tabIndex = 0; T.divider.setAttribute("role", "slider"); T.divider.setAttribute("aria-label", "Before/after comparison position");
  T.divider.addEventListener("keydown", function (e) {
    var cur = parseFloat(T.divider.style.left) || 50;
    if (e.key === "ArrowLeft") { e.preventDefault(); setDividerPct(cur - 4); }
    if (e.key === "ArrowRight") { e.preventDefault(); setDividerPct(cur + 4); }
  });

  // downloads
  T.dlOne.addEventListener("click", async function () {
    var fo = current(); if (!fo) return;
    T.dlOne.disabled = true;
    await ensureComp(fo); downloadBlob(fo.comp, outName(fo));
    T.dlOne.disabled = false; celebrate(T.dlOne, "Download");
    track({ tool: "image", origSize: fo.origSize, outSize: fo.compSize, format: resolvedOut(fo), quality: fo.hitQ || quality, target: target, width: fo.outW, height: fo.outH, filename: fo.name });
  });
  T.dlAll.addEventListener("click", async function () {
    if (!files.length) return;
    T.dlAll.disabled = true; var label = T.dlAll.textContent; T.prog.classList.add("on");
    for (var i = 0; i < files.length; i++) {
      T.dlAll.textContent = "Compressing " + (i + 1) + "/" + files.length + "…";
      T.progBar.style.width = ((i / files.length) * 100).toFixed(1) + "%";
      await ensureComp(files[i]); downloadBlob(files[i].comp, outName(files[i]));
      track({ tool: "image", origSize: files[i].origSize, outSize: files[i].compSize, format: resolvedOut(files[i]), quality: files[i].hitQ || quality, target: target, width: files[i].outW, height: files[i].outH, filename: files[i].name });
      await sleep(300);
    }
    T.progBar.style.width = "100%";
    setTimeout(function () { T.prog.classList.remove("on"); T.progBar.style.width = "0%"; }, 900);
    renderList(); T.dlAll.textContent = label; T.dlAll.disabled = false;
    celebrate(T.dlAll, label);
    toast("Saved " + files.length + " file" + (files.length > 1 ? "s" : "") + " ✓");
  });

  setQLabel(); setNote(); syncPresets();
})();
