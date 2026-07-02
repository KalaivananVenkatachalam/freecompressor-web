/* ============================================================================
   Server-tool factory.
   PDF, document, video and audio compression all share the same shape: pick a
   file, choose options, send to the engine, watch progress, download the result.
   Each concrete tool supplies a small config; this factory renders and wires it.

   config = {
     id, title, chip, description, endpoint, accept, engine,
     icon (svg string), controls: [ ... ], note(state) -> string,
     preview: 'image' | 'video' | null
   }
   control descriptor:
     { kind:'seg'|'slider'|'select'|'check', name, label,
       options:[{v,label}], min,max,step,value, unit, format(v)->str }
   ========================================================================== */
(function (S) {
  "use strict";
  const { $, fmtBytes, savedPct, toast, downloadBlob, baseName, escapeHtml, dropzone, apiCompress, health } = S;

  function build(cfg) {
    const view = $("#view-" + cfg.id);
    const P = "st_" + cfg.id + "_"; // id prefix
    const state = {};
    cfg.controls.forEach((c) => { if (c.value !== undefined) state[c.name] = c.value; });

    let files = [], selectedId = null, seq = 0, ready = false, busy = false;
    const current = () => files.find((f) => f.id === selectedId) || null;

    /* ---- markup --------------------------------------------------------- */
    view.innerHTML = `
      <div class="viewhead">
        <h1>${cfg.title} <span class="chip">${cfg.chip}</span></h1>
        <p>${cfg.description}</p>
      </div>
      <div class="grid">
        <div>
          <div class="panel"><div class="pad">
            <div class="drop" id="${P}drop" tabindex="0">
              <svg class="icn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M12 4l-4 4M12 4l4 4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
              <div class="t">${cfg.dropText || "Drop a file or click to choose"}</div>
              <div class="h">${cfg.dropHint || ""}</div>
            </div>
            <input id="${P}file" type="file" accept="${cfg.accept}" ${cfg.multiple ? "multiple" : ""} hidden>
            <div class="flist" id="${P}list"></div>
            <div class="srvwarn" id="${P}warn"></div>
          </div></div>

          <div class="panel"><div class="pad" id="${P}controls"></div></div>
        </div>

        <div class="panel"><div class="pad">
          <div class="stage" id="${P}stage">
            <div class="empty" id="${P}empty">
              ${cfg.icon}
              <div class="big">${cfg.emptyBig || "Nothing loaded"}</div>
              <div class="sm">${cfg.emptySm || ""}</div>
            </div>
            <div class="result" id="${P}result" style="display:none"></div>
            <div class="working" id="${P}working">
              <div class="spin"></div>
              <div class="msg" id="${P}wmsg">Working…</div>
              <div class="bar"><i id="${P}wbar"></i></div>
            </div>
          </div>
          <div class="hint" id="${P}hint">${cfg.hint || ""}</div>
        </div></div>
      </div>`;

    const el = (s) => $("#" + P + s);
    const dropEl = el("drop"), fileInput = el("file"), listEl = el("list"), warnEl = el("warn");
    const ctlEl = el("controls"), emptyEl = el("empty"), resultEl = el("result");
    const workEl = el("working"), wmsg = el("wmsg"), wbar = el("wbar");

    /* ---- controls ------------------------------------------------------- */
    function renderControls() {
      ctlEl.innerHTML = "";
      cfg.controls.forEach((c) => {
        const wrap = document.createElement("div");
        wrap.className = "field";
        if (c.kind === "seg") {
          wrap.innerHTML =
            `<div class="fhead"><span class="lbl">${c.label}</span></div>` +
            `<div class="seg" data-name="${c.name}">` +
            c.options.map((o) => `<button data-v="${o.v}" class="${state[c.name] === o.v ? "on" : ""}">${o.label}</button>`).join("") +
            `</div>`;
        } else if (c.kind === "slider") {
          wrap.innerHTML =
            `<div class="fhead"><span class="lbl">${c.label}</span>` +
            `<span class="val" data-val="${c.name}">${fmtCtl(c, state[c.name])}</span></div>` +
            `<input type="range" data-name="${c.name}" min="${c.min}" max="${c.max}" step="${c.step || 1}" value="${state[c.name]}">`;
        } else if (c.kind === "select") {
          wrap.innerHTML =
            `<div class="fhead"><span class="lbl">${c.label}</span></div>` +
            `<select class="sel" data-name="${c.name}">` +
            c.options.map((o) => `<option value="${o.v}" ${state[c.name] === o.v ? "selected" : ""}>${o.label}</option>`).join("") +
            `</select>`;
        } else if (c.kind === "check") {
          wrap.innerHTML =
            `<label class="check"><input type="checkbox" data-name="${c.name}" ${state[c.name] ? "checked" : ""}><span>${c.label}</span></label>`;
        }
        // divider between control groups
        if (c.rule) wrap.insertAdjacentHTML("afterbegin", '<div class="rule"></div>');
        ctlEl.appendChild(wrap);
      });

      // note + actions
      const foot = document.createElement("div");
      foot.innerHTML =
        `<div class="note" id="${P}note"></div>` +
        `<div class="actions">` +
        `<button class="btn primary" id="${P}run" disabled>Compress</button>` +
        `<button class="btn ghost" id="${P}dl" disabled>Download</button>` +
        `</div>`;
      ctlEl.appendChild(foot);

      // wire
      ctlEl.querySelectorAll(".seg").forEach((seg) =>
        seg.addEventListener("click", (e) => {
          const b = e.target.closest("button[data-v]"); if (!b) return;
          const name = seg.dataset.name;
          state[name] = coerce(name, b.dataset.v);
          seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
          onChange();
        }));
      ctlEl.querySelectorAll('input[type="range"]').forEach((r) =>
        r.addEventListener("input", () => {
          const name = r.dataset.name; state[name] = +r.value;
          const c = cfg.controls.find((x) => x.name === name);
          ctlEl.querySelector(`[data-val="${name}"]`).textContent = fmtCtl(c, state[name]);
          onChange();
        }));
      ctlEl.querySelectorAll("select").forEach((s) =>
        s.addEventListener("change", () => { state[s.dataset.name] = coerce(s.dataset.name, s.value); onChange(); }));
      ctlEl.querySelectorAll('input[type="checkbox"]').forEach((c) =>
        c.addEventListener("change", () => { state[c.dataset.name] = c.checked; onChange(); }));

      el("run").addEventListener("click", runCompress);
      el("dl").addEventListener("click", () => {
        const fo = current(); if (fo && fo.result) downloadBlob(fo.result.blob, fo.result.name);
      });
      onChange();
    }
    function fmtCtl(c, v) { return c.format ? c.format(v) : v + (c.unit || ""); }
    function coerce(name, v) {
      const c = cfg.controls.find((x) => x.name === name);
      if (!c) return v;
      const sample = c.value;
      return typeof sample === "number" ? +v : v;
    }
    function onChange() {
      const noteEl = el("note");
      if (noteEl && cfg.note) noteEl.innerHTML = cfg.note(state, current());
    }

    /* ---- import --------------------------------------------------------- */
    function addFiles(fl) {
      let added = 0;
      for (const f of fl) {
        if (cfg.validate && !cfg.validate(f)) { toast(f.name + ": unsupported file for this tool", true); continue; }
        const fo = { id: ++seq, name: f.name, file: f, origSize: f.size, result: null, error: null, previewURL: null };
        if (cfg.preview === "image") fo.previewURL = URL.createObjectURL(f);
        files.push(fo); added++;
        if (!cfg.multiple) break;
      }
      if (added) {
        dropEl.classList.add("slim");
        dropEl.querySelector(".t").textContent = cfg.multiple ? "Add more files" : "Replace file";
        if (selectedId == null || !cfg.multiple) select(files[files.length - 1].id);
        renderList();
      }
    }

    function renderList() {
      listEl.innerHTML = "";
      files.forEach((fo) => {
        const row = document.createElement("div");
        row.className = "frow" + (fo.id === selectedId ? " sel" : "");
        let tail;
        if (fo.error) tail = '<span class="save err">error</span>';
        else if (fo.result) {
          const s = savedPct(fo.origSize, fo.result.outSize);
          tail = '<span class="save ' + (s >= 0 ? "pos" : "neg") + '">' + (s >= 0 ? "−" : "+") + Math.abs(s).toFixed(0) + "%</span>";
        } else tail = '<span class="save idle">—</span>';
        const ext = (fo.name.split(".").pop() || "?").toUpperCase();
        const thumb = fo.previewURL
          ? '<span class="thumb"><img src="' + fo.previewURL + '" alt=""></span>'
          : '<span class="thumb">' + cfg.fileIcon + "</span>";
        row.innerHTML =
          thumb +
          '<span class="meta"><span class="name">' + escapeHtml(fo.name) + "</span>" +
          '<span class="nums"><span class="fmt">' + ext + "</span>" + fmtBytes(fo.origSize) +
          (fo.result ? " → " + fmtBytes(fo.result.outSize) : "") + "</span></span>" +
          tail +
          '<button class="x" title="Remove" data-x="' + fo.id + '">✕</button>';
        row.addEventListener("click", (e) => { if (e.target.dataset.x) return; select(fo.id); });
        listEl.appendChild(row);
      });
      listEl.querySelectorAll("[data-x]").forEach((b) =>
        b.addEventListener("click", (e) => { e.stopPropagation(); removeFile(+b.dataset.x); }));
    }

    function removeFile(id) {
      const i = files.findIndex((f) => f.id === id); if (i < 0) return;
      const fo = files[i];
      if (fo.previewURL) URL.revokeObjectURL(fo.previewURL);
      if (fo.result) URL.revokeObjectURL(fo.result.url || "");
      files.splice(i, 1);
      if (selectedId === id) { selectedId = files.length ? files[0].id : null; }
      if (!files.length) { dropEl.classList.remove("slim"); dropEl.querySelector(".t").textContent = cfg.dropText || "Drop a file or click to choose"; }
      renderList(); paintStage();
    }

    function select(id) { selectedId = id; renderList(); paintStage(); }

    /* ---- stage / result ------------------------------------------------- */
    function paintStage() {
      const fo = current();
      const runB = el("run"), dlB = el("dl");
      if (!fo) {
        emptyEl.style.display = "flex"; resultEl.style.display = "none";
        if (runB) runB.disabled = true; if (dlB) dlB.disabled = true;
        return;
      }
      if (runB) runB.disabled = busy;
      if (dlB) dlB.disabled = !fo.result;
      if (fo.result) {
        emptyEl.style.display = "none"; resultEl.style.display = "flex";
        const s = savedPct(fo.origSize, fo.result.outSize);
        resultEl.innerHTML =
          '<div class="card">' +
          '<div class="big ' + (s >= 0 ? "pos" : "neg") + '">' + (s >= 0 ? "−" : "+") + Math.abs(s).toFixed(1) + "%</div>" +
          '<div class="cmp"><span class="was">' + fmtBytes(fo.origSize) + '</span><span class="arr">→</span><span class="now">' + fmtBytes(fo.result.outSize) + "</span></div>" +
          '<div class="sub">' + (cfg.resultSub ? cfg.resultSub(fo.result, state) : "Compressed with the " + cfg.engine + " engine.") + "</div>" +
          (cfg.resultPreview ? cfg.resultPreview(fo) : "") +
          "</div>";
      } else {
        emptyEl.style.display = "flex"; resultEl.style.display = "none";
      }
    }

    async function runCompress() {
      const fo = current(); if (!fo || busy) return;
      const h = await health();
      if (!h.ok || (h.engines && cfg.engineKey && h.engines[cfg.engineKey] === false)) {
        showWarn(true);
        toast("The " + cfg.engine + " engine isn't available.", true);
        return;
      }
      showWarn(false);
      busy = true; el("run").disabled = true;
      workEl.classList.add("on"); wmsg.textContent = "Uploading…"; wbar.style.width = "4%";
      fo.error = null;
      try {
        const res = await apiCompress(cfg.endpoint, fo.file, cfg.buildOptions ? cfg.buildOptions(state) : state, (p, phase) => {
          if (phase === "upload") { wmsg.textContent = "Uploading… " + Math.round(p * 100) + "%"; wbar.style.width = Math.max(4, p * 40) + "%"; }
          else { wmsg.textContent = cfg.workMsg || "Compressing…"; wbar.style.width = "82%"; }
        });
        wbar.style.width = "100%";
        const name = decorateName(fo.name, res, state);
        fo.result = { blob: res.blob, url: URL.createObjectURL(res.blob), outSize: res.outSize, name, meta: res.meta };
        toast("Compressed — saved " + Math.max(0, savedPct(fo.origSize, res.outSize)).toFixed(0) + "%");
      } catch (err) {
        console.error(err); fo.error = err.message || "Compression failed";
        toast(fo.error, true);
        if (/reach the engine|not available/i.test(fo.error)) showWarn(true);
      }
      busy = false; workEl.classList.remove("on");
      renderList(); paintStage();
    }

    function decorateName(orig, res, st) {
      if (cfg.outName) return cfg.outName(orig, res, st);
      const ext = orig.split(".").pop();
      return baseName(orig) + "-min." + ext;
    }

    function showWarn(on) {
      warnEl.classList.toggle("on", on);
      if (on) warnEl.innerHTML = cfg.offlineMsg ||
        `The ${cfg.engine} engine isn't reachable. Start it with <code>npm run dev</code> in <code>/server</code>, or run the bundled Docker image.`;
    }

    /* ---- init ----------------------------------------------------------- */
    function init() {
      if (ready) return; ready = true;
      dropzone(dropEl, fileInput, addFiles);
      renderControls();
      paintStage();
      health().then((h) => {
        const avail = h.ok && (!cfg.engineKey || h.engines?.[cfg.engineKey] !== false);
        if (!avail) showWarn(true);
      });
    }

    S.tools = S.tools || {};
    S.tools[cfg.id] = { init };
  }

  S.buildServerTool = build;
})(window.Freecompressor);
