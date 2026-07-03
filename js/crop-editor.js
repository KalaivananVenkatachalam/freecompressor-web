/* ============================================================================
   FreeCompressor — crop-editor.js  (ES module, lazy-loaded)
   A modal crop editor over the original image. The crop rectangle is stored in
   IMAGE-pixel coordinates, so it stays pixel-accurate at any zoom/pan level and
   the exported result matches the box exactly. Pointer events unify mouse +
   touch: drag inside to move, drag a handle to resize, drag outside to pan,
   wheel or two-finger pinch to zoom. Aspect presets (Free / 1:1 / 4:3 / 16:9 /
   3:2 / Original) constrain resizing.

   openCropEditor({ imageURL, imageW, imageH, crop, onApply, onCancel })
     crop:   existing normalized {x,y,w,h} (0..1) or null
     onApply(rect|null):  rect is normalized {x,y,w,h}; null means "no crop"
   ========================================================================== */

const PRESETS = [
  { id: "free", label: "Free", ar: 0 },
  { id: "orig", label: "Original", ar: -1 },
  { id: "1:1", label: "1:1", ar: 1 },
  { id: "4:3", label: "4:3", ar: 4 / 3 },
  { id: "3:2", label: "3:2", ar: 3 / 2 },
  { id: "16:9", label: "16:9", ar: 16 / 9 },
];
const MIN_PX = 8; // smallest crop side, in image pixels

export function openCropEditor(opts) {
  const IW = opts.imageW, IH = opts.imageH;
  const onApply = opts.onApply || function () {};
  const onCancel = opts.onCancel || function () {};

  /* crop rect in image pixels */
  let crop = opts.crop
    ? { x: opts.crop.x * IW, y: opts.crop.y * IH, w: opts.crop.w * IW, h: opts.crop.h * IH }
    : { x: 0, y: 0, w: IW, h: IH };
  let aspect = 0; // 0 = free; -1 handled as IW/IH; else ratio

  /* view transform: screen = image * scale + offset */
  let scale = 1, offx = 0, offy = 0, fitScale = 1;

  /* ---- DOM ------------------------------------------------------------- */
  const modal = el("div", "crop-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Crop image");

  const stage = el("div", "crop-stage");
  const img = new Image();
  img.className = "crop-img";
  img.draggable = false;
  img.src = opts.imageURL;
  img.width = IW; img.height = IH;

  const box = el("div", "crop-box");
  const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  HANDLES.forEach((h) => { const el2 = el("span", "crop-h h-" + h); el2.dataset.h = h; box.appendChild(el2); });
  const gridEl = el("div", "crop-grid");
  box.appendChild(gridEl);
  stage.appendChild(img); stage.appendChild(box);

  const bar = el("div", "crop-bar");
  const presetWrap = el("div", "crop-presets");
  PRESETS.forEach((p) => {
    const b = el("button", "chip");
    b.type = "button"; b.textContent = p.label; b.dataset.p = p.id;
    if (p.id === "free") b.classList.add("on");
    b.addEventListener("click", () => setPreset(p));
    presetWrap.appendChild(b);
  });
  const dims = el("div", "crop-dims"); dims.textContent = "";
  const actions = el("div", "crop-actions");
  const btnReset = mkBtn("btn btn-ghost btn-sm", "Reset");
  const btnCancel = mkBtn("btn btn-ghost btn-sm", "Cancel");
  const btnApply = mkBtn("btn btn-primary btn-sm", "Apply crop");
  actions.append(btnReset, btnCancel, btnApply);
  bar.append(presetWrap, dims, actions);

  modal.append(stage, bar);
  document.body.appendChild(modal);
  document.body.style.overflow = "hidden";

  /* ---- layout / transform --------------------------------------------- */
  function computeFit() {
    const r = stage.getBoundingClientRect();
    const vw = r.width, vh = r.height;
    fitScale = Math.min(vw / IW, vh / IH) * 0.94;
    if (!isFinite(fitScale) || fitScale <= 0) fitScale = 1;
    scale = fitScale;
    offx = (vw - IW * scale) / 2;
    offy = (vh - IH * scale) / 2;
  }
  function clampView() {
    const r = stage.getBoundingClientRect();
    const vw = r.width, vh = r.height, iw = IW * scale, ih = IH * scale, pad = 40;
    if (iw <= vw) offx = (vw - iw) / 2;
    else offx = Math.min(pad, Math.max(vw - iw - pad, offx));
    if (ih <= vh) offy = (vh - ih) / 2;
    else offy = Math.min(pad, Math.max(vh - ih - pad, offy));
  }
  const sx = (ix) => offx + ix * scale;
  const sy = (iy) => offy + iy * scale;

  function render() {
    img.style.transform = "translate(" + offx + "px," + offy + "px) scale(" + scale + ")";
    box.style.left = sx(crop.x) + "px";
    box.style.top = sy(crop.y) + "px";
    box.style.width = crop.w * scale + "px";
    box.style.height = crop.h * scale + "px";
    dims.textContent = Math.round(crop.w) + " × " + Math.round(crop.h) + " px";
  }

  /* ---- crop maths ------------------------------------------------------ */
  function clampRect(r) {
    r.w = Math.max(MIN_PX, Math.min(r.w, IW));
    r.h = Math.max(MIN_PX, Math.min(r.h, IH));
    r.x = Math.max(0, Math.min(r.x, IW - r.w));
    r.y = Math.max(0, Math.min(r.y, IH - r.h));
    return r;
  }
  function setPreset(p) {
    Array.prototype.forEach.call(presetWrap.children, (b) => b.classList.toggle("on", b.dataset.p === p.id));
    aspect = p.ar === -1 ? IW / IH : p.ar;
    if (aspect > 0) {
      // Re-fit the current crop to the target ratio, centered on its middle.
      const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
      let w = crop.w, h = w / aspect;
      if (h > IH) { h = IH; w = h * aspect; }
      if (w > IW) { w = IW; h = w / aspect; }
      crop = clampRect({ x: cx - w / 2, y: cy - h / 2, w, h });
      // keep ratio exact after clamping
      if (Math.abs(crop.w / crop.h - aspect) > 0.001) { crop.h = crop.w / aspect; crop = clampRect(crop); }
    }
    render();
  }

  /* ---- interaction ----------------------------------------------------- */
  const pointers = new Map();
  let mode = null;         // 'move' | 'resize' | 'pan'
  let handle = null;
  let start = null;        // {px,py, crop, offx, offy}
  let pinch = null;        // {dist, mx, my, scale, offx, offy}

  function ptScreen(e) {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  stage.addEventListener("pointerdown", (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, ptScreen(e));
    if (pointers.size === 2) { beginPinch(); return; }
    if (pointers.size > 2) return;
    const p = ptScreen(e);
    const hEl = e.target.closest(".crop-h");
    if (hEl) { mode = "resize"; handle = hEl.dataset.h; }
    else if (inBox(p)) mode = "move";
    else mode = "pan";
    start = { px: p.x, py: p.y, crop: Object.assign({}, crop), offx, offy };
  });

  stage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, ptScreen(e));
    if (pinch) { updatePinch(); return; }
    if (!mode) return;
    const p = ptScreen(e);
    const dxi = (p.x - start.px) / scale;   // deltas in image pixels
    const dyi = (p.y - start.py) / scale;
    if (mode === "move") {
      crop = clampRect({ x: start.crop.x + dxi, y: start.crop.y + dyi, w: start.crop.w, h: start.crop.h });
    } else if (mode === "pan") {
      offx = start.offx + (p.x - start.px); offy = start.offy + (p.y - start.py); clampView();
    } else if (mode === "resize") {
      crop = resizeRect(start.crop, handle, dxi, dyi);
    }
    render();
  });

  function endPointer(e) {
    if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) { mode = null; handle = null; }
  }
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);

  function inBox(p) {
    return p.x >= sx(crop.x) && p.x <= sx(crop.x) + crop.w * scale &&
           p.y >= sy(crop.y) && p.y <= sy(crop.y) + crop.h * scale;
  }

  function resizeRect(s0, h, dxi, dyi) {
    let x = s0.x, y = s0.y, w = s0.w, hgt = s0.h;
    const east = h.indexOf("e") >= 0, west = h.indexOf("w") >= 0;
    const south = h.indexOf("s") >= 0, north = h.indexOf("n") >= 0;
    if (east) w = s0.w + dxi;
    if (west) { x = s0.x + dxi; w = s0.w - dxi; }
    if (south) hgt = s0.h + dyi;
    if (north) { y = s0.y + dyi; hgt = s0.h - dyi; }

    if (aspect > 0) {
      // Lock ratio; drive height off the axis the user is actually dragging.
      const isCorner = (east || west) && (north || south);
      if (isCorner || east || west) hgt = w / aspect;
      else w = hgt * aspect;
      if (north) y = s0.y + s0.h - hgt;
      if (west) x = s0.x + s0.w - w;
    }
    // Enforce minimums without flipping the box; anchor to the fixed edge.
    if (w < MIN_PX) { w = MIN_PX; if (west) x = s0.x + s0.w - w; }
    if (hgt < MIN_PX) { hgt = MIN_PX; if (north) y = s0.y + s0.h - hgt; }
    const r = { x, y, w, h: hgt };
    // Clamp inside the image, then restore the ratio if it was locked.
    if (r.x < 0) { r.w += r.x; r.x = 0; }
    if (r.y < 0) { r.h += r.y; r.y = 0; }
    if (r.x + r.w > IW) r.w = IW - r.x;
    if (r.y + r.h > IH) r.h = IH - r.y;
    if (aspect > 0) { if (r.w / r.h > aspect) r.w = r.h * aspect; else r.h = r.w / aspect; }
    return clampRect(r);
  }

  /* zoom */
  function zoomAround(cx, cy, ns) {
    ns = Math.max(fitScale, Math.min(fitScale * 16, ns));
    const ix = (cx - offx) / scale, iy = (cy - offy) / scale;
    scale = ns; offx = cx - ix * scale; offy = cy - iy * scale;
    clampView(); render();
  }
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = ptScreen(e);
    zoomAround(p.x, p.y, scale * (e.deltaY < 0 ? 1.12 : 0.89));
  }, { passive: false });

  function beginPinch() {
    const pts = Array.from(pointers.values());
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    pinch = { dist, mx: (pts[0].x + pts[1].x) / 2, my: (pts[0].y + pts[1].y) / 2, scale, offx, offy };
    mode = null; handle = null;
  }
  function updatePinch() {
    const pts = Array.from(pointers.values());
    if (pts.length < 2) return;
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
    const ns = Math.max(fitScale, Math.min(fitScale * 16, pinch.scale * (dist / (pinch.dist || 1))));
    const ix = (pinch.mx - pinch.offx) / pinch.scale, iy = (pinch.my - pinch.offy) / pinch.scale;
    scale = ns; offx = mx - ix * scale; offy = my - iy * scale;
    clampView(); render();
  }

  /* ---- actions --------------------------------------------------------- */
  function normalized() {
    const n = { x: crop.x / IW, y: crop.y / IH, w: crop.w / IW, h: crop.h / IH };
    if (n.x <= 0.001 && n.y <= 0.001 && n.w >= 0.999 && n.h >= 0.999) return null; // full image
    return n;
  }
  function close() {
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", onKey, true);
    document.body.style.overflow = "";
    modal.remove();
  }
  btnApply.addEventListener("click", () => { const n = normalized(); close(); onApply(n); });
  btnCancel.addEventListener("click", () => { close(); onCancel(); });
  btnReset.addEventListener("click", () => {
    crop = { x: 0, y: 0, w: IW, h: IH }; aspect = 0;
    Array.prototype.forEach.call(presetWrap.children, (b) => b.classList.toggle("on", b.dataset.p === "free"));
    computeFit(); render();
  });
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); onCancel(); }
    else if (e.key === "Enter") { e.preventDefault(); const n = normalized(); close(); onApply(n); }
  }
  function onResize() { computeFit(); clampView(); render(); }
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);

  /* ---- go -------------------------------------------------------------- */
  function boot() { computeFit(); crop = clampRect(crop); render(); }
  if (img.complete && img.naturalWidth) boot();
  else img.onload = boot;

  return { close };
}

/* ---- tiny DOM helpers ---------------------------------------------------- */
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function mkBtn(cls, label) { const b = el("button", cls); b.type = "button"; b.textContent = label; return b; }
