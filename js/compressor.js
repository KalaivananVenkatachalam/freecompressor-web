/* ============================================================================
   FreeCompressor — compressor.js  (ES module)
   The image compressor UI + job orchestration. 100% client-side.

   Encoding runs in a pool of module workers (see encode-worker.js) so the main
   thread never freezes — even compressing 100 files at once. A concurrency cap
   (3–5) with per-worker FIFO queues means only a handful of encodes run at a
   time and the rest wait their turn. Live preview jumps the queue. Every file
   has its own state (queued/compressing/…/done/failed) with progress, cancel
   and retry. Memory is bounded: the main thread never holds a full-resolution
   bitmap, and object URLs are revoked the moment they're no longer shown.

   Browsers without module workers or OffscreenCanvas (e.g. old Safari) fall
   back to a main-thread engine that shares the exact same encode-core.js — so
   behaviour is identical, just without the off-thread parallelism.

   Input:  PNG · JPG · WEBP · GIF · AVIF · HEIC   Output: PNG · JPG · WebP · AVIF
   Privacy: re-encoding strips all EXIF/GPS metadata; EXIF orientation is baked
   in first so images never come out sideways.
   ========================================================================== */
import { encode } from "./encode-core.js";

const d = document;
const $ = (s) => d.querySelector(s);
const root = $("#cmp-drop");

const toast = (window.FC && window.FC.toast) || function () {};

/* ---- feature detection --------------------------------------------------- */
function canEncode(mime) {
  try { return d.createElement("canvas").toDataURL(mime).indexOf(mime) === 5; }
  catch (e) { return false; }
}
const webpOK = canEncode("image/webp");

const DECODABLE = /^image\/(png|jpeg|webp|gif|avif|heic|heif|bmp)$/;
const NAME_OK = /\.(png|jpe?g|webp|gif|avif|heic|heif|bmp)$/i;
const HEIC = /^image\/hei[cf]$/;
const HEIC_EXT = /\.(heic|heif)$/i;

/* ==========================================================================
   ENCODE ENGINE — worker pool with a main-thread fallback
   ========================================================================== */
const POOL_SIZE = Math.max(2, Math.min(5, (navigator.hardwareConcurrency || 4) - 1));

function createWorkerEngine() {
  const slots = new Array(POOL_SIZE).fill(null);
  const jobs = new Map(); // jobId -> job
  let jobSeq = 0, caps = null, readyDone = false, resolveReady;
  const readyP = new Promise((r) => (resolveReady = r));
  const readyTimer = setTimeout(() => finishReady({ ok: false }), 6000);

  function finishReady(c) {
    if (readyDone) return;
    readyDone = true; caps = c; clearTimeout(readyTimer); resolveReady(c);
  }

  function spawn(i) {
    let w;
    try { w = new Worker("/js/encode-worker.js", { type: "module" }); }
    catch (e) { return null; }
    const slot = { w, i, busy: false, queue: [], current: null };
    w.onmessage = (e) => onMsg(slot, e.data);
    w.onerror = () => onErr(slot);
    return slot;
  }

  for (let i = 0; i < POOL_SIZE; i++) slots[i] = spawn(i);
  if (!slots.some(Boolean)) finishReady({ ok: false }); // couldn't create any worker

  function onMsg(slot, m) {
    if (m.type === "ready") { finishReady(m.caps); return; }
    const job = jobs.get(m.jobId);
    if (!job) return;
    if (m.type === "progress") { job.onProgress && job.onProgress(m.phase, m.pct); return; }
    slot.busy = false; slot.current = null; jobs.delete(m.jobId);
    if (m.type === "done") job.resolve(m);
    else if (m.type === "canceled") job.reject(canceledError());
    else job.reject(new Error(m.message || "compression failed"));
    pump(slot);
  }

  // A worker script error (or crash) — reject its jobs and respawn so the pool
  // stays at full strength for the next files.
  function onErr(slot) {
    const dead = slot.current ? [slot.current, ...slot.queue] : [...slot.queue];
    slot.queue = []; slot.busy = false; slot.current = null;
    try { slot.w.terminate(); } catch (e) {}
    dead.forEach((j) => { jobs.delete(j.jobId); j.reject(new Error("worker crashed")); });
    slots[slot.i] = spawn(slot.i);
  }

  function firstAlive() { return slots.find(Boolean) || null; }

  function pump(slot) {
    if (!slot || slot.busy) return;
    const job = slot.queue.shift();
    if (!job) return;
    slot.busy = true; slot.current = job;
    slot.w.postMessage({ type: "encode", jobId: job.jobId, fileId: job.fileId, blob: job.blob, opts: job.opts });
  }

  function compress(fo, opts, ctrl) {
    ctrl = ctrl || {};
    return new Promise((resolve, reject) => {
      const jobId = ++jobSeq;
      const slot = slots[fo.id % slots.length] || firstAlive();
      if (!slot) { reject(new Error("no worker available")); return; }
      const job = { jobId, fileId: fo.id, blob: fo.decodedBlob || fo.orig, opts, resolve, reject, onProgress: ctrl.onProgress, slot };
      jobs.set(jobId, job);
      if (ctrl.signal) {
        if (ctrl.signal.aborted) { jobs.delete(jobId); reject(canceledError()); return; }
        ctrl.signal.addEventListener("abort", () => cancel(jobId), { once: true });
      }
      if (ctrl.priority) slot.queue.unshift(job); else slot.queue.push(job);
      pump(slot);
    });
  }

  function cancel(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;
    const slot = job.slot;
    const qi = slot ? slot.queue.indexOf(job) : -1;
    if (qi >= 0) { slot.queue.splice(qi, 1); jobs.delete(jobId); job.reject(canceledError()); return; }
    if (slot && slot.current === job) slot.w.postMessage({ type: "cancel", jobId });
  }

  // Broadcast: a bitmap can land in a non-home slot when routing fell back to
  // firstAlive() (its home slot was down), so tell every worker to drop it.
  function forget(fileId) {
    slots.forEach((s) => { if (s) s.w.postMessage({ type: "forget", fileId }); });
  }

  function destroy() { slots.forEach((s) => { if (s) { try { s.w.terminate(); } catch (e) {} } }); }

  return { kind: "worker", ready: readyP, compress, forget, capsOf: () => caps, destroy };
}

function createMainEngine() {
  const platform = {
    makeCanvas: (w, h) => { const c = d.createElement("canvas"); c.width = w; c.height = h; return c; },
    toBlob: (c, type, quality) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode-null"))), type, quality)),
    upng: () => Promise.resolve(window.UPNG),
    avif: () => import("/vendor/avif/avif-encode.js").then((m) => m.encodeAVIF),
  };
  async function compress(fo, opts, ctrl) {
    ctrl = ctrl || {};
    const blob = fo.decodedBlob || fo.orig;
    let bmp;
    try { bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }); }
    catch (e) { bmp = await createImageBitmap(blob); }
    try {
      return await encode(bmp, opts, platform, {
        shouldCancel: () => ctrl.signal && ctrl.signal.aborted,
        onPhase: (phase, pct) => ctrl.onProgress && ctrl.onProgress(phase, pct),
      });
    } finally { try { bmp.close && bmp.close(); } catch (e) {} }
  }
  return { kind: "main", ready: Promise.resolve({ ok: true, webp: webpOK }), compress, forget() {}, capsOf: () => ({ ok: true, webp: webpOK }) };
}

function canceledError() { const e = new Error("canceled"); e.canceled = true; return e; }

// Pick the worker engine if its self-test passes, else the main-thread engine.
const Engine = (function () {
  let impl = null;
  const readyP = (async () => {
    if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
      const we = createWorkerEngine();
      const caps = await we.ready;
      if (caps && caps.ok) { impl = we; return impl; }
      we.destroy(); // self-test failed — don't leak the spawned workers
    }
    impl = createMainEngine();
    return impl;
  })();
  return {
    ready: readyP,
    async compress(fo, opts, ctrl) { return (impl || (await readyP)).compress(fo, opts, ctrl); },
    forget(id) { if (impl) impl.forget(id); },
    isFallback() { return impl ? impl.kind === "main" : false; },
  };
})();

/* ==========================================================================
   STATE
   ========================================================================== */
if (!root) { /* not the compressor page — module does nothing */ }
else main();

function main() {
  const T = {};
  const files = [];
  let selectedId = null;
  let quality = 80;
  let target = 0;               // 0 = quality mode, else target bytes
  let outFmt = "orig";          // orig | png | jpeg | webp | avif
  const resize = { mode: "off", edge: 0, w: null, h: null, fill: false, lock: true };
  let seq = 0;
  let previewCtrl = null;       // AbortController for the in-flight live preview

  /* ---- helpers ---------------------------------------------------------- */
  const fmtBytes = (b) =>
    b == null ? "—" : b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(2) + " MB";
  const baseName = (n) => { const i = n.lastIndexOf("."); return i > 0 ? n.slice(0, i) : n; };
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function downloadBlob(blob, name) {
    const a = d.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    d.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  function track(payload) {
    try {
      const body = JSON.stringify(payload);
      if (navigator.sendBeacon) navigator.sendBeacon("/api/beacon", new Blob([body], { type: "application/json" }));
    } catch (e) {}
  }

  const current = () => files.find((f) => f.id === selectedId) || null;
  const autoMode = () => target > 0 && outFmt === "orig";
  function resolved(fo) {
    if (outFmt !== "orig") return outFmt;
    if (fo.srcType === "png" || fo.srcType === "jpeg") return fo.srcType;
    if (fo.srcType === "webp" && webpOK) return "webp";
    return webpOK ? "webp" : "jpeg";
  }
  const resolvedOut = (fo) => (autoMode() && fo.autoFmt ? fo.autoFmt : resolved(fo));
  const fmtLabel = (f) => (f === "jpeg" ? "JPG" : f === "webp" ? "WebP" : f === "avif" ? "AVIF" : "PNG");

  function buildOpts(fo) {
    return {
      fmt: outFmt, quality, target,
      resize: { mode: resize.mode, edge: resize.edge, w: resize.w, h: resize.h, fill: resize.fill },
      crop: fo.crop || null, srcType: fo.srcType, webpOK,
    };
  }
  const cropKey = (fo) => (fo.crop ? "c" + [fo.crop.x, fo.crop.y, fo.crop.w, fo.crop.h].map((v) => v.toFixed(4)).join(",") : "nc");
  const resizeKey = () =>
    resize.mode === "edge" && resize.edge > 0 ? "e" + resize.edge
    : resize.mode === "custom" && (resize.w || resize.h) ? "c" + resize.w + "x" + resize.h + (resize.fill ? "f" : "t")
    : "n";
  const compKey = (fo) => (autoMode() ? "auto" : resolved(fo)) + "|" + (target > 0 ? "t" + target : "q" + quality) + "|" + resizeKey() + "|" + cropKey(fo);
  const isResizing = () => (resize.mode === "edge" && resize.edge > 0) || (resize.mode === "custom" && !!(resize.w || resize.h));

  /* ---- HEIC decoder (lazy, main thread only) ---------------------------- */
  let heicLib = null;
  function loadHeic() {
    if (heicLib) return heicLib;
    heicLib = new Promise((res, rej) => {
      const s = d.createElement("script");
      s.src = "/vendor/heic2any.min.js";
      s.onload = () => (window.heic2any ? res(window.heic2any) : rej(new Error("heic decoder unavailable")));
      s.onerror = () => { heicLib = null; rej(new Error("could not load HEIC decoder")); };
      d.head.appendChild(s);
    });
    return heicLib;
  }
  async function toDecodableBlob(file) {
    if (HEIC.test(file.type) || HEIC_EXT.test(file.name)) {
      const heic2any = await loadHeic();
      return await heic2any({ blob: file, toType: "image/png" });
    }
    return file;
  }
  function srcTypeOf(mime, name) {
    if (HEIC.test(mime) || HEIC_EXT.test(name)) return "heic";
    const m = /^image\/(\w+)/.exec(mime || "");
    const t = m ? m[1] : "unknown";
    return t === "jpg" ? "jpeg" : t;
  }
  // Read intrinsic dimensions once, without keeping a decoded bitmap in memory.
  function ensureDims(fo) {
    if (fo.dimsP) return fo.dimsP;
    fo.dimsP = new Promise((res) => {
      const img = new Image();
      img.onload = () => { fo.w = img.naturalWidth; fo.h = img.naturalHeight; res(fo); };
      img.onerror = () => res(fo);
      img.src = fo.origURL;
    });
    return fo.dimsP;
  }

  /* ---- import ----------------------------------------------------------- */
  function addFiles(fl) {
    const list = Array.prototype.slice.call(fl || []);
    let firstNewId = null;
    for (const f of list) {
      if (!DECODABLE.test(f.type) && !NAME_OK.test(f.name)) { toast(f.name + ": not a supported image format", true); continue; }
      const fo = {
        id: ++seq, name: f.name, srcType: srcTypeOf(f.type, f.name), orig: f, decodedBlob: null,
        origSize: f.size, origURL: null, w: 0, h: 0, crop: null,
        comp: null, compSize: 0, compURL: null, compKey: null,
        outW: 0, outH: 0, hitQ: null, missed: false, autoFmt: null,
        status: "idle", progress: 0, error: null, ready: false, rowEl: null, jobCtrl: null, dimsP: null, prepP: null,
      };
      files.push(fo);
      if (firstNewId == null) firstNewId = fo.id;
      fo.prepP = prepareFile(fo);
    }
    if (firstNewId != null) {
      T.drop.classList.add("slim");
      T.dropT.textContent = "Add more images";
      renderList();
      if (selectedId == null) select(firstNewId);
      T.dlAll.disabled = false;
    }
  }
  async function prepareFile(fo) {
    try {
      const blob = await toDecodableBlob(fo.orig);
      fo.decodedBlob = blob !== fo.orig ? blob : null;
      if (fo.origURL) URL.revokeObjectURL(fo.origURL); // defend against a re-run
      fo.origURL = URL.createObjectURL(blob);
      fo.ready = true;
      await ensureDims(fo);
      if (fo.rowEl) { const img = fo.rowEl.querySelector(".thumb img"); if (img && !img.src) img.src = fo.origURL; }
      if (fo.id === selectedId) {
        T.imgOrig.src = fo.origURL;
        showStage(fo);
        if (resize.mode === "custom" && !resize.w && !resize.h && fo.w) { resize.w = fo.w; resize.h = fo.h; syncDimInputs(); }
        setNote(); refreshSelected();
      }
      updateRow(fo);
    } catch (e) {
      fo.status = "failed";
      fo.error = HEIC_EXT.test(fo.name) ? "Could not decode HEIC" : "Could not read image";
      updateRow(fo);
      if (fo.id === selectedId) { T.working.classList.remove("on"); clearStage(); } // clear the stuck spinner
      toast(fo.error + ": " + fo.name, true);
    }
  }

  /* ---- live preview ----------------------------------------------------- */
  async function refreshSelected() {
    const fo = current();
    if (!fo || !fo.ready) return;
    // Supersede any outgoing preview (of ANY file) up front — otherwise a slow
    // encode for a previously-selected file could finish and clobber the stage.
    if (previewCtrl) previewCtrl.abort();
    const key = compKey(fo);
    if (fo.comp && fo.compKey === key) { showPreview(fo); T.working.classList.remove("on"); return; }

    const ctrl = new AbortController();
    previewCtrl = ctrl; fo.jobCtrl = ctrl;
    setStatus(fo, "compressing", 0);
    T.working.classList.add("on");
    try {
      const out = await Engine.compress(fo, buildOpts(fo), {
        priority: true, signal: ctrl.signal,
        onProgress: (phase, pct) => { if (!ctrl.signal.aborted) setStatus(fo, phase, pct); },
      });
      if (ctrl.signal.aborted || fo.id !== selectedId) return;
      applyResult(fo, out, key);
      showPreview(fo);
      setStatus(fo, "done", 100);
    } catch (err) {
      if (err && err.canceled) return;         // superseded or user-canceled
      setStatus(fo, "failed"); fo.error = (err && err.message) || "compression failed";
      toast("Compression failed for " + fo.name, true);
    } finally {
      if (previewCtrl === ctrl) { previewCtrl = null; T.working.classList.remove("on"); }
      if (fo.jobCtrl === ctrl) fo.jobCtrl = null;
    }
  }
  function applyResult(fo, out, key) {
    if (fo.compURL) URL.revokeObjectURL(fo.compURL);
    fo.comp = out.blob; fo.compSize = out.size; fo.compKey = key;
    fo.outW = out.width; fo.outH = out.height;
    fo.hitQ = out.quality; fo.missed = out.missed;
    fo.autoFmt = out.mode === "auto" ? out.fmt : null;
    fo.compURL = URL.createObjectURL(out.blob);
  }
  function showPreview(fo) {
    if (!fo.compURL && fo.comp) fo.compURL = URL.createObjectURL(fo.comp);
    if (fo.compURL) T.imgComp.src = fo.compURL;
    paintReadout(fo);
    if (autoMode()) setNote();
    setDimTag();
    updateRow(fo);
  }

  // Compress a file for batch download (no live preview overhead).
  async function compressForBatch(fo) {
    if (!fo.ready) await ensureReady(fo);
    const key = compKey(fo);
    if (fo.comp && fo.compKey === key) { setStatus(fo, "done", 100); return; }
    const ctrl = new AbortController(); fo.jobCtrl = ctrl;
    setStatus(fo, "compressing", 0);
    try {
      const out = await Engine.compress(fo, buildOpts(fo), {
        signal: ctrl.signal,
        onProgress: (phase, pct) => setStatus(fo, phase, pct),
      });
      if (fo.id === selectedId) applyResult(fo, out, key);
      else {
        fo.comp = out.blob; fo.compSize = out.size; fo.compKey = key;
        fo.outW = out.width; fo.outH = out.height;
        fo.hitQ = out.quality; fo.missed = out.missed;
        fo.autoFmt = out.mode === "auto" ? out.fmt : null;
      }
      setStatus(fo, "done", 100);
      if (fo.id === selectedId) showPreview(fo);
    } catch (err) {
      if (err && err.canceled) setStatus(fo, "canceled");
      else { setStatus(fo, "failed"); fo.error = (err && err.message) || "compression failed"; }
      throw err;
    } finally { if (fo.jobCtrl === ctrl) fo.jobCtrl = null; }
  }
  // Reuse the in-flight prepare promise so batch/download paths never kick off a
  // second decode (which would orphan the first origURL / decoded blob).
  function ensureReady(fo) {
    return fo.ready ? Promise.resolve() : (fo.prepP || (fo.prepP = prepareFile(fo)));
  }

  /* ---- per-file status -------------------------------------------------- */
  const ACTIVE = { queued: 1, decoding: 1, compressing: 1, optimizing: 1 };
  function setStatus(fo, status, pct) {
    fo.status = status;
    if (pct != null) fo.progress = pct;
    if (!ACTIVE[status]) fo.progress = status === "done" ? 100 : 0;
    updateRow(fo);
  }
  const statusText = (fo) => ({
    queued: "Queued", decoding: "Decoding…", compressing: "Compressing…",
    optimizing: "Optimizing…", failed: "Failed", canceled: "Canceled",
  }[fo.status] || "");

  /* ---- file list -------------------------------------------------------- */
  function buildRow(fo) {
    const row = d.createElement("div");
    row.className = "frow";
    row.setAttribute("role", "button"); row.tabIndex = 0;
    row.innerHTML =
      '<span class="thumb"><img alt=""></span>' +
      '<span class="meta">' +
        '<span class="name"></span>' +
        '<span class="nums"></span>' +
        '<span class="fstat"><span class="fstat-txt"></span><span class="fbar"><i></i></span></span>' +
      "</span>" +
      '<span class="save idle">—</span>' +
      '<span class="frow-actions">' +
        '<button class="ficon retry" type="button" title="Retry" aria-label="Retry">↻</button>' +
        '<button class="ficon stop" type="button" title="Cancel" aria-label="Cancel">✕</button>' +
        '<button class="x" type="button" aria-label="Remove">✕</button>' +
      "</span>";
    row.addEventListener("click", (e) => { if (e.target.closest(".frow-actions")) return; select(fo.id); });
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(fo.id); } });
    row.querySelector(".x").addEventListener("click", (e) => { e.stopPropagation(); removeFile(fo.id); });
    row.querySelector(".stop").addEventListener("click", (e) => { e.stopPropagation(); cancelFile(fo); });
    row.querySelector(".retry").addEventListener("click", (e) => { e.stopPropagation(); retryFile(fo); });
    return row;
  }
  function updateRow(fo) {
    const row = fo.rowEl; if (!row) return;
    row.classList.toggle("sel", fo.id === selectedId);
    row.classList.toggle("active", !!ACTIVE[fo.status]);
    row.classList.toggle("failed", fo.status === "failed" || fo.status === "canceled");
    const img = row.querySelector(".thumb img");
    if (fo.origURL && img.getAttribute("src") !== fo.origURL) img.src = fo.origURL;
    row.querySelector(".name").textContent = fo.name;
    const nums = row.querySelector(".nums");
    nums.innerHTML = '<span class="fmt-tag">' + fo.srcType.toUpperCase() + "</span>" +
      fmtBytes(fo.origSize) + (fo.compSize ? " → " + fmtBytes(fo.compSize) : "");
    const save = row.querySelector(".save");
    if (fo.compSize) {
      const s = (1 - fo.compSize / fo.origSize) * 100;
      save.className = "save " + (s >= 0 ? "pos" : "neg");
      save.textContent = (s >= 0 ? "−" : "+") + Math.abs(s).toFixed(0) + "%";
    } else { save.className = "save idle"; save.textContent = "—"; }
    const txt = statusText(fo);
    row.querySelector(".fstat-txt").textContent = ACTIVE[fo.status] && fo.progress ? txt.replace("…", " " + fo.progress + "%") : txt;
    row.querySelector(".fbar i").style.width = (ACTIVE[fo.status] ? fo.progress : 0) + "%";
    row.classList.toggle("has-stat", !!txt);
  }
  function renderList() {
    const frag = d.createDocumentFragment();
    files.forEach((fo) => { if (!fo.rowEl) fo.rowEl = buildRow(fo); updateRow(fo); frag.appendChild(fo.rowEl); });
    T.list.innerHTML = "";
    T.list.appendChild(frag);
  }
  function selectHighlight() { files.forEach((fo) => fo.rowEl && fo.rowEl.classList.toggle("sel", fo.id === selectedId)); }

  function removeFile(id) {
    const i = files.findIndex((f) => f.id === id);
    if (i < 0) return;
    const fo = files[i];
    if (fo.jobCtrl) fo.jobCtrl.abort();
    Engine.forget(fo.id);
    if (fo.origURL) URL.revokeObjectURL(fo.origURL);
    if (fo.compURL) URL.revokeObjectURL(fo.compURL);
    if (fo.rowEl && fo.rowEl.parentNode) fo.rowEl.parentNode.removeChild(fo.rowEl);
    files.splice(i, 1);
    if (selectedId === id) { selectedId = null; if (files.length) select(files[0].id); else clearStage(); }
    if (!files.length) {
      T.dlAll.disabled = true; T.dlOne.disabled = true;
      T.drop.classList.remove("slim");
      T.dropT.textContent = "Drag & drop images here";
    }
  }
  function cancelFile(fo) {
    if (fo.jobCtrl) fo.jobCtrl.abort();
    setStatus(fo, "canceled");
  }
  function retryFile(fo) {
    fo.error = null;
    if (!fo.ready) {                            // failed before decode finished — re-decode
      fo.status = "idle"; fo.dimsP = null; fo.prepP = null;
      updateRow(fo);
      fo.prepP = prepareFile(fo);
      if (fo.id === selectedId) select(fo.id);  // re-enter the loading state
      return;
    }
    if (fo.id === selectedId) { fo.compKey = null; refreshSelected(); }
    else compressForBatch(fo).catch(() => {});
  }

  function clearStage() {
    T.empty.style.display = "flex";
    T.readout.style.display = "none";
    [T.imgOrig, T.imgComp, T.divider, T.tagL, T.tagR].forEach((e) => (e.style.display = "none"));
    T.working.classList.remove("on");
    T.dlOne.disabled = true;
    T.cropBtn.disabled = true;
  }
  function showStage(fo) {
    T.empty.style.display = "none";
    [T.imgOrig, T.imgComp, T.divider, T.tagL, T.tagR].forEach((e) => (e.style.display = ""));
    if (fo.origURL) T.imgOrig.src = fo.origURL;
    T.readout.style.display = "flex";
    T.dlOne.disabled = false;
    T.cropBtn.disabled = false;
  }
  function select(id) {
    const prev = current();
    if (prev && prev.id !== id && prev.compURL) { URL.revokeObjectURL(prev.compURL); prev.compURL = null; }
    selectedId = id;
    selectHighlight();
    const fo = current();
    if (!fo) return clearStage();
    if (!fo.ready) { // still decoding — show a spinner until prepareFile resolves
      T.empty.style.display = "none";
      [T.imgOrig, T.imgComp, T.divider, T.tagL, T.tagR].forEach((e) => (e.style.display = "none"));
      T.readout.style.display = "none";
      T.working.classList.add("on");
      T.dlOne.disabled = true; T.cropBtn.disabled = true;
      return;
    }
    showStage(fo);
    if (resize.mode === "custom" && !resize.w && !resize.h && fo.w) { resize.w = fo.w; resize.h = fo.h; syncDimInputs(); }
    setNote(); refreshSelected();
  }

  /* ---- labels & notes --------------------------------------------------- */
  const qWord = (q) => (q >= 100 ? "lossless" : q >= 85 ? "best" : q >= 60 ? "balanced" : q >= 35 ? "small" : "tiny");
  function setQLabel() { T.qval.innerHTML = quality + " <small>· " + qWord(quality) + "</small>"; }
  function setDimTag() {
    const fo = current();
    if (!fo || !isResizing() || !fo.outW) { T.dimtag.textContent = ""; return; }
    T.dimtag.textContent = (fo.crop ? "cropped → " : "") + fo.outW + "×" + fo.outH;
  }
  function setNote() {
    const fo = current();
    const fmt = fo ? resolvedOut(fo) : outFmt === "orig" ? "png" : outFmt;
    T.convtag.textContent = !fo ? ""
      : autoMode() ? (fo.autoFmt ? "auto → " + fmtLabel(fo.autoFmt) : "auto format")
      : resolved(fo) !== fo.srcType ? (fo.srcType === "heic" ? "HEIC" : fo.srcType.toUpperCase()) + " → " + fmtLabel(resolved(fo)) : "keeps " + fo.srcType.toUpperCase();
    setDimTag();
    if (autoMode()) {
      T.note.innerHTML = "Target mode: we automatically pick the <b>output format and quality</b> with the best "
        + "image quality under <b>" + fmtBytes(target) + "</b> — lossless PNG when it fits, otherwise "
        + (webpOK ? "WebP/AVIF" : "JPG/PNG") + " at the highest quality that does.";
      return;
    }
    if (target > 0) { T.note.innerHTML = "Target mode: we search for the highest " + fmtLabel(fmt) + " quality that fits under <b>" + fmtBytes(target) + "</b>."; return; }
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
  function paintReadout(fo) {
    T.rOrig.textContent = fmtBytes(fo.origSize);
    T.rComp.textContent = fmtBytes(fo.compSize);
    const saved = (1 - fo.compSize / fo.origSize) * 100;
    T.rSave.textContent = (saved >= 0 ? "−" : "+") + Math.abs(saved).toFixed(1) + "%";
    T.rSave.className = "v " + (saved >= 0 ? "pos" : "neg");
    const dimNote = isResizing() || fo.crop ? "Output " + fo.outW + "×" + fo.outH + ". " : "";
    if (target > 0 && fo.missed) {
      T.hint.textContent = dimNote + "Even at minimum quality this is " + fmtBytes(fo.compSize) + " — above your " + fmtBytes(target) + " target. Try a smaller target, resize, or crop.";
    } else if (target > 0) {
      const pct = Math.round((fo.compSize / target) * 100);
      const fmtTxt = autoMode() ? fmtLabel(fo.autoFmt) + " picked automatically" : fmtLabel(resolvedOut(fo));
      const room = pct <= 90 ? " (comfortably under)" : pct >= 96 ? " (right at the limit)" : "";
      T.hint.textContent = dimNote + "Final " + fmtBytes(fo.compSize) + " — " + pct + "% of your " + fmtBytes(target) + " target" + room + ". " + fmtTxt + " at quality " + fo.hitQ + ".";
    } else if (saved < 0) {
      T.hint.textContent = dimNote + "Output is larger than the original — lossless PNG can grow photos. Lower the quality or switch to JPG/WebP.";
    } else {
      T.hint.textContent = dimNote + "Drag the divider to compare before and after. The checkerboard shows preserved transparency.";
    }
  }
  // Recompute of the whole batch is only needed when a GLOBAL setting changes —
  // each file's cached result is then stale (its compKey no longer matches).
  function invalidateOthers() {
    files.forEach((fo) => {
      if (fo.id !== selectedId) {
        if (fo.compURL) { URL.revokeObjectURL(fo.compURL); fo.compURL = null; }
        fo.comp = null; fo.compSize = 0; fo.compKey = null;
        if (!ACTIVE[fo.status]) fo.status = "idle";
        updateRow(fo);
      }
    });
  }
  function onGlobalSettingChange() { invalidateOthers(); refreshSelected(); }

  /* ---- compare divider -------------------------------------------------- */
  function setDividerPct(pos) {
    pos = Math.max(0, Math.min(100, pos));
    T.imgComp.style.clipPath = "inset(0 " + (100 - pos) + "% 0 0)";
    T.divider.style.left = pos + "%";
  }
  function setDivider(px) { const r = T.stage.getBoundingClientRect(); setDividerPct(((px - r.left) / r.width) * 100); }

  /* ---- downloads -------------------------------------------------------- */
  function outName(fo) {
    const t = resolvedOut(fo);
    return baseName(fo.name) + "-min." + (t === "jpeg" ? "jpg" : t);
  }
  async function ensureComp(fo) {
    const key = compKey(fo);
    if (!fo.comp || fo.compKey !== key) await compressForBatch(fo);
    return fo.comp;
  }
  function celebrate(btn, label) {
    btn.innerHTML = '<span class="check-pop"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span> Saved';
    setTimeout(() => (btn.textContent = label), 1600);
  }

  async function downloadAll() {
    if (!files.length) return;
    T.dlAll.disabled = true;
    const label = T.dlAll.dataset.label || T.dlAll.textContent;
    T.dlAll.dataset.label = label;
    T.prog.classList.add("on");
    const total = files.length; let done = 0;
    files.forEach((fo) => { if (!(fo.comp && fo.compKey === compKey(fo)) && !ACTIVE[fo.status]) setStatus(fo, "queued", 0); });
    const tick = () => {
      done++;
      T.dlAll.textContent = "Compressing " + done + "/" + total + "…";
      T.progBar.style.width = ((done / total) * 100).toFixed(1) + "%";
    };
    // Fire every file at once; the worker pool caps real concurrency to POOL_SIZE.
    await Promise.allSettled(files.map((fo) => compressForBatch(fo).then(tick, tick)));
    // Download the successful ones sequentially (a tiny gap avoids browser throttling).
    let saved = 0;
    for (const fo of files) {
      if (!fo.comp) continue;
      downloadBlob(fo.comp, outName(fo));
      track({ tool: "image", origSize: fo.origSize, outSize: fo.compSize, format: resolvedOut(fo), quality: fo.hitQ || quality, target, width: fo.outW, height: fo.outH, filename: fo.name });
      saved++;
      await sleep(150);
    }
    T.progBar.style.width = "100%";
    setTimeout(() => { T.prog.classList.remove("on"); T.progBar.style.width = "0%"; }, 900);
    T.dlAll.textContent = label; T.dlAll.disabled = false;
    celebrate(T.dlAll, label);
    const failed = total - saved;
    toast(failed ? "Saved " + saved + " file" + (saved !== 1 ? "s" : "") + " · " + failed + " failed" : "Saved " + saved + " file" + (saved !== 1 ? "s" : "") + " ✓", failed > 0);
  }

  /* ---- crop editor (lazy-loaded) --------------------------------------- */
  let cropModPromise = null;
  async function openCrop() {
    const fo = current();
    if (!fo || !fo.ready) return;
    await ensureDims(fo);
    if (!fo.w || !fo.h) { toast("Couldn't read image dimensions", true); return; }
    T.cropBtn.disabled = true;
    try {
      if (!cropModPromise) cropModPromise = import("/js/crop-editor.js");
      const mod = await cropModPromise;
      mod.openCropEditor({
        imageURL: fo.origURL, imageW: fo.w, imageH: fo.h, crop: fo.crop,
        onApply(rect) {
          fo.crop = rect;                 // null clears the crop
          fo.compKey = null;              // force recompress of this file
          if (fo.compURL) { URL.revokeObjectURL(fo.compURL); fo.compURL = null; }
          fo.comp = null; fo.compSize = 0;
          updateCropBtn(fo);
          setNote(); refreshSelected();
        },
      });
    } catch (e) {
      toast("Couldn't open the crop tool", true);
    } finally { T.cropBtn.disabled = false; }
  }
  function updateCropBtn(fo) {
    const on = !!(fo && fo.crop);
    T.cropBtn.classList.toggle("on", on);
    T.cropBtn.querySelector(".crop-label").textContent = on ? "Cropped" : "Crop";
  }

  /* ---- init ------------------------------------------------------------- */
  Object.assign(T, {
    drop: $("#cmp-drop"), dropT: $("#cmp-drop .t"), file: $("#cmp-file"), list: $("#cmp-list"),
    fmt: $("#cmp-fmt"), convtag: $("#cmp-convtag"),
    targetChips: $("#cmp-target"),
    resizeChips: $("#cmp-resize"), resizeCustom: $("#cmp-resize-custom"), dimtag: $("#cmp-dimtag"),
    rw: $("#cmp-rw"), rh: $("#cmp-rh"), lock: $("#cmp-lock"), fillmode: $("#cmp-fillmode"),
    cropBtn: $("#cmp-crop"),
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
  T.drop.addEventListener("click", () => T.file.click());
  T.drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); T.file.click(); } });
  T.file.addEventListener("change", (e) => { addFiles(e.target.files); T.file.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => T.drop.addEventListener(ev, (e) => { e.preventDefault(); T.drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => T.drop.addEventListener(ev, (e) => { e.preventDefault(); T.drop.classList.remove("drag"); }));
  T.drop.addEventListener("drop", (e) => { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  // paste
  d.addEventListener("paste", (e) => {
    if (!e.clipboardData) return;
    const imgs = Array.prototype.filter.call(e.clipboardData.files || [], (f) => /^image\//.test(f.type));
    if (imgs.length) { e.preventDefault(); addFiles(imgs); toast("Pasted " + imgs.length + " image" + (imgs.length > 1 ? "s" : "")); }
  });

  // output format
  T.fmt.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-fmt]"); if (!b || b.disabled) return;
    outFmt = b.dataset.fmt;
    Array.prototype.forEach.call(T.fmt.querySelectorAll("button"), (x) => x.classList.toggle("on", x === b));
    setNote(); onGlobalSettingChange();
  });
  if (!webpOK) { const wb = T.fmt.querySelector('[data-fmt="webp"]'); if (wb) { wb.disabled = true; wb.title = "WebP encoding not supported in this browser"; } }

  // target size
  T.targetChips.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-bytes]"); if (!b) return;
    target = +b.dataset.bytes;
    Array.prototype.forEach.call(T.targetChips.querySelectorAll("button"), (x) => x.classList.toggle("on", x === b));
    T.qblock.style.opacity = target > 0 ? 0.45 : 1;
    T.slider.disabled = target > 0;
    Array.prototype.forEach.call(T.presets.querySelectorAll("button"), (x) => (x.disabled = target > 0));
    setNote(); onGlobalSettingChange();
  });

  // resize
  T.resizeChips.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    Array.prototype.forEach.call(T.resizeChips.querySelectorAll("button"), (x) => x.classList.remove("on"));
    b.classList.add("on");
    if (b.hasAttribute("data-custom")) {
      resize.mode = "custom"; T.resizeCustom.hidden = false;
      const fo = current();
      if (fo && !resize.w && !resize.h && fo.w) { resize.w = fo.w; resize.h = fo.h; }
      syncDimInputs();
    } else { resize.mode = "edge"; resize.edge = +b.dataset.edge; T.resizeCustom.hidden = true; }
    setDimTag(); onGlobalSettingChange();
  });
  function syncDimInputs() { T.rw.value = resize.w || ""; T.rh.value = resize.h || ""; }
  function ratio() { const fo = current(); return fo && fo.w ? fo.h / fo.w : 1; }
  let rdeb;
  T.rw.addEventListener("input", () => {
    resize.w = Math.max(0, parseInt(T.rw.value, 10) || 0) || null;
    if (resize.lock && resize.w) { resize.h = Math.round(resize.w * ratio()); T.rh.value = resize.h; }
    setDimTag(); clearTimeout(rdeb); rdeb = setTimeout(onGlobalSettingChange, 280);
  });
  T.rh.addEventListener("input", () => {
    resize.h = Math.max(0, parseInt(T.rh.value, 10) || 0) || null;
    if (resize.lock && resize.h) { resize.w = Math.round(resize.h / ratio()); T.rw.value = resize.w; }
    setDimTag(); clearTimeout(rdeb); rdeb = setTimeout(onGlobalSettingChange, 280);
  });
  T.lock.addEventListener("click", () => {
    resize.lock = !resize.lock;
    T.lock.classList.toggle("on", resize.lock);
    T.lock.setAttribute("aria-pressed", resize.lock ? "true" : "false");
    if (resize.lock && resize.w) { resize.h = Math.round(resize.w * ratio()); syncDimInputs(); setDimTag(); onGlobalSettingChange(); }
  });
  T.fillmode.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-fill]"); if (!b) return;
    resize.fill = b.dataset.fill === "fill";
    Array.prototype.forEach.call(T.fillmode.querySelectorAll("button"), (x) => x.classList.toggle("on", x === b));
    setDimTag(); onGlobalSettingChange();
  });

  // crop
  if (T.cropBtn) T.cropBtn.addEventListener("click", openCrop);

  // quality
  let deb;
  T.slider.addEventListener("input", () => {
    quality = +T.slider.value; setQLabel(); setNote(); syncPresets(); invalidateOthers();
    clearTimeout(deb); deb = setTimeout(refreshSelected, 180);
  });
  T.presets.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-q]"); if (!b || b.disabled) return;
    quality = +b.dataset.q; T.slider.value = quality; setQLabel(); setNote(); syncPresets(); onGlobalSettingChange();
  });
  function syncPresets() { Array.prototype.forEach.call(T.presets.querySelectorAll("button"), (b) => b.classList.toggle("on", +b.dataset.q === quality)); }

  // compare divider
  let dragging = false;
  T.stage.addEventListener("pointerdown", (e) => { if (T.empty.style.display !== "none") return; dragging = true; T.stage.setPointerCapture(e.pointerId); setDivider(e.clientX); });
  T.stage.addEventListener("pointermove", (e) => { if (dragging) setDivider(e.clientX); });
  T.stage.addEventListener("pointerup", () => (dragging = false));
  T.stage.addEventListener("pointercancel", () => (dragging = false));
  T.divider.tabIndex = 0; T.divider.setAttribute("role", "slider"); T.divider.setAttribute("aria-label", "Before/after comparison position");
  T.divider.addEventListener("keydown", (e) => {
    const cur = parseFloat(T.divider.style.left) || 50;
    if (e.key === "ArrowLeft") { e.preventDefault(); setDividerPct(cur - 4); }
    if (e.key === "ArrowRight") { e.preventDefault(); setDividerPct(cur + 4); }
  });

  // downloads
  T.dlOne.addEventListener("click", async () => {
    const fo = current(); if (!fo) return;
    T.dlOne.disabled = true;
    try { await ensureComp(fo); if (fo.comp) { downloadBlob(fo.comp, outName(fo)); celebrate(T.dlOne, "Download"); track({ tool: "image", origSize: fo.origSize, outSize: fo.compSize, format: resolvedOut(fo), quality: fo.hitQ || quality, target, width: fo.outW, height: fo.outH, filename: fo.name }); } }
    catch (e) { toast("Compression failed for " + fo.name, true); }
    T.dlOne.disabled = false;
  });
  T.dlAll.addEventListener("click", downloadAll);

  // If we fell back to the main-thread engine, tell the user heavy batches may hitch.
  Engine.ready.then(() => { if (Engine.isFallback()) console.info("FreeCompressor: using main-thread encoder (workers/OffscreenCanvas unavailable)"); });

  setQLabel(); setNote(); syncPresets();
}
