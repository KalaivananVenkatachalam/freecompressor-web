/* ============================================================================
   Freecompressor core — shared utilities used by every tool.
   Exposed as a single global `Freecompressor` (no build step required).
   ========================================================================== */
window.Freecompressor = (function () {
  "use strict";

  // API base: same origin when served by the engine; overridable for split deploys.
  const API_BASE = (window.FREECOMPRESSOR_API_BASE || "").replace(/\/$/, "");

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---- formatting ------------------------------------------------------- */
  function fmtBytes(b) {
    if (b == null) return "—";
    return b < 1024 ? b + " B"
      : b < 1048576 ? (b / 1024).toFixed(1) + " KB"
      : b < 1073741824 ? (b / 1048576).toFixed(2) + " MB"
      : (b / 1073741824).toFixed(2) + " GB";
  }
  function fmtDuration(s) {
    if (s == null || !isFinite(s)) return "—";
    s = Math.round(s);
    const m = Math.floor(s / 60), sec = s % 60;
    return m + ":" + String(sec).padStart(2, "0");
  }
  function savedPct(orig, comp) { return (1 - comp / orig) * 100; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---- toast ------------------------------------------------------------ */
  const toastEl = $("#toast");
  let toastT;
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("err", !!isErr);
    toastEl.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove("show"), 3000);
  }

  /* ---- download helpers ------------------------------------------------- */
  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  function baseName(name) {
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(0, i) : name;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /* ---- dropzone factory ------------------------------------------------- */
  // Wires click, keyboard and drag/drop onto an element; calls onFiles(FileList).
  function dropzone(el, input, onFiles) {
    el.addEventListener("click", () => input.click());
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
    });
    input.addEventListener("change", (e) => { onFiles(e.target.files); input.value = ""; });
    ["dragenter", "dragover"].forEach((ev) =>
      el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) =>
      el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.remove("drag"); }));
    el.addEventListener("drop", (e) => {
      if (e.dataTransfer && e.dataTransfer.files) onFiles(e.dataTransfer.files);
    });
  }

  /* ---- API client ------------------------------------------------------- */
  // Uploads one file + options to a compression endpoint, streaming progress.
  // Resolves with { blob, headers } where headers carries x-* size metadata.
  function apiCompress(endpoint, file, options, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", API_BASE + endpoint);
      xhr.responseType = "blob";
      // Optional deploy-time token (set window.FREECOMPRESSOR_API_TOKEN before core.js).
      if (window.FREECOMPRESSOR_API_TOKEN) xhr.setRequestHeader("Authorization", "Bearer " + window.FREECOMPRESSOR_API_TOKEN);

      const form = new FormData();
      form.append("file", file, file.name);
      Object.keys(options || {}).forEach((k) => form.append(k, options[k]));

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total, "upload");
      };
      // Server sends the finished file back; treat receipt as processing→done.
      xhr.onprogress = () => { if (onProgress) onProgress(1, "process"); };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({
            blob: xhr.response,
            outSize: +xhr.getResponseHeader("x-output-size") || xhr.response.size,
            origSize: +xhr.getResponseHeader("x-original-size") || file.size,
            outName: parseFilename(xhr.getResponseHeader("content-disposition")) ||
                     (baseName(file.name) + "-min"),
            meta: safeJSON(xhr.getResponseHeader("x-meta")),
          });
        } else {
          // Error responses come back as JSON blobs.
          xhr.response.text().then((t) => {
            reject(new Error(safeJSON(t)?.error || ("Engine error " + xhr.status)));
          }).catch(() => reject(new Error("Engine error " + xhr.status)));
        }
      };
      xhr.onerror = () => reject(new Error("Cannot reach the engine — is the server running?"));
      xhr.ontimeout = () => reject(new Error("The job timed out."));
      xhr.timeout = 30 * 60 * 1000; // 30 min ceiling for large video
      xhr.send(form);
    });
  }
  function parseFilename(cd) {
    if (!cd) return null;
    const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function safeJSON(s) { try { return JSON.parse(s); } catch { return null; } }

  /* ---- engine health ---------------------------------------------------- */
  // Cached briefly so a burst of tool inits shares one request, but expiring
  // so an engine started *after* page load is noticed without a reload.
  const HEALTH_TTL = 15000;
  let _health = null, _healthAt = 0;
  async function health(force) {
    if (!force && _health && Date.now() - _healthAt < HEALTH_TTL) return _health;
    try {
      const r = await fetch(API_BASE + "/api/health", {
        cache: "no-store",
        headers: window.FREECOMPRESSOR_API_TOKEN ? { Authorization: "Bearer " + window.FREECOMPRESSOR_API_TOKEN } : {},
      });
      _health = await r.json();
    } catch {
      _health = { ok: false, engines: {} };
    }
    _healthAt = Date.now();
    return _health;
  }

  /* ---- usage beacon ------------------------------------------------------ */
  // Reports image-tool job METADATA (sizes, format) after a download so the
  // admin dashboard covers all tools. The image itself never leaves the page.
  // Fire-and-forget: failures are ignored, the tool works without it.
  function track(payload) {
    try {
      const body = JSON.stringify(payload);
      const url = API_BASE + "/api/beacon";
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      } else {
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch { /* tracking must never break the tool */ }
  }

  return {
    $, $$, API_BASE, track,
    fmtBytes, fmtDuration, savedPct, sleep,
    toast, downloadBlob, baseName, escapeHtml,
    dropzone, apiCompress, health,
  };
})();
