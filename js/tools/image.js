/* ============================================================================
   Image tool — fully client-side compression & conversion (PNG/JPG/WEBP).
   Uses <canvas> for JPEG/WEBP and UPNG+pako for quantized PNG. Nothing leaves
   the browser. Ported and modularized from the original Freecompressor prototype.
   ========================================================================== */
(function (S) {
  "use strict";
  const { $, fmtBytes, toast, downloadBlob, baseName, escapeHtml, dropzone, sleep, track } = S;

  const T = {}; // element cache, filled on init
  let files = [], selectedId = null, quality = 90, seq = 0, target = "orig";
  let working = false, queued = null, ready = false;

  const webpOK = (() => {
    try { return document.createElement("canvas").toDataURL("image/webp").indexOf("image/webp") === 5; }
    catch { return false; }
  })();

  const accepted = (t) => t === "image/png" || t === "image/jpeg";
  const typeOf = (f) => (f.type === "image/png" ? "png" : "jpeg");
  const current = () => files.find((f) => f.id === selectedId) || null;
  const resolved = (fo) => (target === "orig" ? fo.type : target);

  function qWord(q) { return q >= 100 ? "lossless" : q >= 85 ? "high" : q >= 65 ? "balanced" : q >= 40 ? "small" : "tiny"; }
  function setQLabel() { T.qval.innerHTML = quality + ' <small>· ' + qWord(quality) + "</small>"; }

  function setNote() {
    const fo = current();
    const t = fo ? resolved(fo) : (target === "orig" ? "png" : target);
    T.convtag.textContent = fo
      ? (resolved(fo) !== fo.type ? fo.type.toUpperCase() + " → " + resolved(fo).toUpperCase() : "keep " + fo.type.toUpperCase())
      : "";
    if (t === "png") {
      T.note.innerHTML = quality >= 100
        ? "PNG: lossless — pixel-perfect, transparency kept. Best for UI, logos, screenshots."
        : "PNG: quantized to <b>" + Math.max(2, Math.round((quality / 100) * 256)) + " colors</b>, transparency kept.";
    } else if (t === "webp") {
      T.note.innerHTML = "WEBP: quality " + (quality / 100).toFixed(2) + ", transparency kept. Usually the smallest of the three.";
    } else {
      T.note.innerHTML = "JPG: quality " + (quality / 100).toFixed(2) + ". Flattened onto white (no transparency). Best for photos.";
    }
  }

  /* ---- import ----------------------------------------------------------- */
  async function addFiles(fl) {
    let added = 0;
    for (const f of fl) {
      if (!accepted(f.type)) { toast(f.name + ": only PNG and JPEG are supported", true); continue; }
      let bmp;
      try { bmp = await createImageBitmap(f); }
      catch { toast("Could not read " + f.name, true); continue; }
      files.push({
        id: ++seq, name: f.name, type: typeOf(f), orig: f, origSize: f.size,
        origURL: URL.createObjectURL(f), w: bmp.width, h: bmp.height, bmp,
        cache: null, comp: null, compSize: 0, compURL: null, compQ: null,
      });
      added++;
    }
    if (added) {
      T.drop.classList.add("slim");
      T.drop.querySelector(".t").textContent = "Add more images";
      renderList();
      if (selectedId == null) select(files[0].id); else refreshSelected();
      T.dlAll.disabled = false;
    }
  }

  /* ---- encode ----------------------------------------------------------- */
  function ensureCache(fo) {
    if (fo.cache) return fo.cache;
    const c = document.createElement("canvas"); c.width = fo.w; c.height = fo.h;
    const ctx = c.getContext("2d"); ctx.drawImage(fo.bmp, 0, 0);
    fo.cache = { canvas: c, ctx, imageData: null, flat: null };
    return fo.cache;
  }
  function getImageData(fo) {
    const c = ensureCache(fo);
    if (!c.imageData) c.imageData = c.ctx.getImageData(0, 0, fo.w, fo.h);
    return c.imageData;
  }
  function getFlat(fo) {
    const c = ensureCache(fo);
    if (c.flat) return c.flat;
    const f = document.createElement("canvas"); f.width = fo.w; f.height = fo.h;
    const fx = f.getContext("2d"); fx.fillStyle = "#ffffff"; fx.fillRect(0, 0, fo.w, fo.h); fx.drawImage(c.canvas, 0, 0);
    c.flat = f; return f;
  }
  function encodePNG(fo, q) {
    const id = getImageData(fo);
    const ps = q >= 100 ? 0 : Math.max(2, Math.round((q / 100) * 256));
    const buf = UPNG.encode([id.data.buffer.slice(0)], fo.w, fo.h, ps);
    return new Blob([buf], { type: "image/png" });
  }
  function encodeCanvas(fo, mime, q) {
    const cv = mime === "image/jpeg" ? getFlat(fo) : ensureCache(fo).canvas;
    return new Promise((res, rej) =>
      cv.toBlob((b) => (b ? res(b) : rej(new Error("encode-null"))), mime, Math.max(0.02, Math.min(1, q / 100))));
  }
  async function compress(fo, q) {
    const t = resolved(fo);
    if (t === "png") return encodePNG(fo, q);
    if (t === "webp") return await encodeCanvas(fo, "image/webp", q);
    return await encodeCanvas(fo, "image/jpeg", q);
  }

  /* ---- list ------------------------------------------------------------- */
  function renderList() {
    T.list.innerHTML = "";
    files.forEach((fo) => {
      const row = document.createElement("div");
      row.className = "frow" + (fo.id === selectedId ? " sel" : "");
      const saved = fo.compSize ? (1 - fo.compSize / fo.origSize) * 100 : null;
      const savedHtml = saved === null
        ? '<span class="save idle">—</span>'
        : '<span class="save ' + (saved >= 0 ? "pos" : "neg") + '">' + (saved >= 0 ? "−" : "+") + Math.abs(saved).toFixed(0) + "%</span>";
      row.innerHTML =
        '<span class="thumb"><img src="' + fo.origURL + '" alt=""></span>' +
        '<span class="meta"><span class="name">' + escapeHtml(fo.name) + "</span>" +
        '<span class="nums"><span class="fmt">' + fo.type.toUpperCase() + "</span>" + fmtBytes(fo.origSize) +
        (fo.compSize ? " → " + fmtBytes(fo.compSize) : "") + "</span></span>" +
        savedHtml +
        '<button class="x" title="Remove" data-x="' + fo.id + '">✕</button>';
      row.addEventListener("click", (e) => { if (e.target.dataset.x) return; select(fo.id); });
      T.list.appendChild(row);
    });
    T.list.querySelectorAll("[data-x]").forEach((b) =>
      b.addEventListener("click", (e) => { e.stopPropagation(); removeFile(+b.dataset.x); }));
  }

  function removeFile(id) {
    const i = files.findIndex((f) => f.id === id); if (i < 0) return;
    const fo = files[i];
    URL.revokeObjectURL(fo.origURL); if (fo.compURL) URL.revokeObjectURL(fo.compURL);
    files.splice(i, 1);
    if (selectedId === id) { selectedId = null; if (files.length) select(files[0].id); else clearStage(); }
    renderList();
    if (!files.length) {
      T.dlAll.disabled = true; T.dlOne.disabled = true;
      T.drop.classList.remove("slim"); T.drop.querySelector(".t").textContent = "Drop images or click to choose";
    }
  }

  function clearStage() {
    T.empty.style.display = "flex"; T.readout.style.display = "none";
    [T.imgOrig, T.imgComp, T.divider, T.tagL, T.tagR].forEach((e) => (e.style.display = "none"));
    T.dlOne.disabled = true;
  }

  function select(id) {
    selectedId = id; renderList();
    const fo = current(); if (!fo) return clearStage();
    T.empty.style.display = "none";
    [T.imgOrig, T.imgComp, T.divider, T.tagL, T.tagR].forEach((e) => (e.style.display = ""));
    T.imgOrig.src = fo.origURL; T.readout.style.display = "flex"; T.dlOne.disabled = false;
    setNote(); refreshSelected();
  }

  /* ---- live compress ---------------------------------------------------- */
  async function refreshSelected() {
    const fo = current(); if (!fo) return;
    const q = quality;
    if (working) { queued = q; return; }
    working = true; T.working.classList.add("on");
    try {
      const blob = await compress(fo, q);
      if (fo.compURL) URL.revokeObjectURL(fo.compURL);
      fo.comp = blob; fo.compSize = blob.size; fo.compURL = URL.createObjectURL(blob); fo.compQ = q;
      T.imgComp.src = fo.compURL; paintReadout(fo); renderList();
    } catch (err) { console.error(err); toast("Compression failed for " + fo.name, true); }
    working = false; T.working.classList.remove("on");
    if (queued != null && queued !== q) { queued = null; refreshSelected(); } else queued = null;
  }

  function paintReadout(fo) {
    T.rOrig.textContent = fmtBytes(fo.origSize);
    T.rComp.textContent = fmtBytes(fo.compSize);
    const saved = (1 - fo.compSize / fo.origSize) * 100;
    T.rSave.textContent = (saved >= 0 ? "−" : "+") + Math.abs(saved).toFixed(1) + "%";
    T.rSave.className = "v " + (saved >= 0 ? "pos" : "neg");
    T.hint.textContent = saved < 0
      ? "This output is larger than the original — for photographic PNGs, lossless can grow the file. Lower the quality, or keep it as JPEG instead."
      : "Drag the divider to compare. The checkerboard shows transparency — if it survives the divider, your alpha channel is preserved.";
  }

  function staleOthers() {
    files.forEach((fo) => {
      if (fo.id !== selectedId) {
        if (fo.compURL) URL.revokeObjectURL(fo.compURL);
        fo.comp = null; fo.compURL = null; fo.compSize = 0; fo.compQ = null;
      }
    });
    renderList();
  }

  /* ---- divider ---------------------------------------------------------- */
  function setDivider(px) {
    const r = T.stage.getBoundingClientRect();
    let pos = ((px - r.left) / r.width) * 100; pos = Math.max(0, Math.min(100, pos));
    T.imgComp.style.clipPath = "inset(0 " + (100 - pos) + "% 0 0)";
    T.divider.style.left = pos + "%";
  }

  /* ---- downloads -------------------------------------------------------- */
  function outName(fo) {
    const t = resolved(fo);
    const ext = t === "png" ? "png" : t === "webp" ? "webp" : "jpg";
    return baseName(fo.name) + "-min." + ext;
  }
  async function ensureComp(fo) {
    if (!fo.comp || fo.compQ !== quality) {
      const blob = await compress(fo, quality);
      if (fo.compURL && fo.id !== selectedId) URL.revokeObjectURL(fo.compURL);
      fo.comp = blob; fo.compSize = blob.size; fo.compQ = quality;
      if (fo.id !== selectedId) fo.compURL = URL.createObjectURL(blob);
    }
    return fo.comp;
  }

  /* ---- init ------------------------------------------------------------- */
  function init() {
    if (ready) return; ready = true;
    Object.assign(T, {
      file: $("#img-file"), drop: $("#img-drop"), list: $("#img-list"),
      slider: $("#img-q"), qval: $("#img-qval"), note: $("#img-note"),
      presets: $("#img-presets"), fmt: $("#img-fmt"), convtag: $("#img-convtag"),
      stage: $("#img-stage"), imgOrig: $("#img-orig"), imgComp: $("#img-comp"),
      divider: $("#img-divider"), tagL: $("#img-tagL"), tagR: $("#img-tagR"),
      empty: $("#img-empty"), working: $("#img-working"),
      readout: $("#img-readout"), rOrig: $("#img-rOrig"), rComp: $("#img-rComp"), rSave: $("#img-rSave"),
      dlOne: $("#img-dlOne"), dlAll: $("#img-dlAll"), hint: $("#img-hint"),
    });

    dropzone(T.drop, T.file, addFiles);

    let deb;
    T.slider.addEventListener("input", () => {
      quality = +T.slider.value; setQLabel(); setNote(); syncPresets(); staleOthers();
      clearTimeout(deb); deb = setTimeout(refreshSelected, 170);
    });
    T.presets.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-q]"); if (!b) return;
      quality = +b.dataset.q; T.slider.value = quality; setQLabel(); setNote(); syncPresets(); staleOthers(); refreshSelected();
    });
    T.fmt.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-fmt]"); if (!b || b.disabled) return;
      target = b.dataset.fmt;
      T.fmt.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      setNote(); staleOthers(); refreshSelected();
    });

    let dragging = false;
    T.stage.addEventListener("pointerdown", (e) => {
      if (T.empty.style.display !== "none") return;
      dragging = true; T.stage.setPointerCapture(e.pointerId); setDivider(e.clientX);
    });
    T.stage.addEventListener("pointermove", (e) => { if (dragging) setDivider(e.clientX); });
    T.stage.addEventListener("pointerup", () => (dragging = false));
    T.stage.addEventListener("pointercancel", () => (dragging = false));

    T.dlOne.addEventListener("click", async () => {
      const fo = current(); if (!fo) return;
      T.dlOne.disabled = true; await ensureComp(fo); downloadBlob(fo.comp, outName(fo)); T.dlOne.disabled = false;
      track({ tool: "image", origSize: fo.origSize, outSize: fo.compSize, format: resolved(fo), quality, filename: fo.name });
    });
    T.dlAll.addEventListener("click", async () => {
      if (!files.length) return;
      T.dlAll.disabled = true; const label = T.dlAll.textContent;
      for (let i = 0; i < files.length; i++) {
        T.dlAll.textContent = "Compressing " + (i + 1) + "/" + files.length + "…";
        await ensureComp(files[i]); downloadBlob(files[i].comp, outName(files[i]));
        track({ tool: "image", origSize: files[i].origSize, outSize: files[i].compSize, format: resolved(files[i]), quality, filename: files[i].name });
        await sleep(300);
      }
      renderList(); T.dlAll.textContent = label; T.dlAll.disabled = false;
      toast("Saved " + files.length + " file" + (files.length > 1 ? "s" : ""));
    });

    if (!webpOK) {
      const wb = T.fmt.querySelector('[data-fmt="webp"]');
      wb.disabled = true; wb.title = "WEBP encoding not supported in this browser";
    }
    function syncPresets() { T.presets.querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.q === quality)); }

    setQLabel(); setNote(); syncPresets();
  }

  S.tools = S.tools || {};
  S.tools.image = { init };
})(window.Freecompressor);
