/* ============================================================================
   App shell — routing between tools, keyboard shortcuts, engine status.
   ========================================================================== */
(function (S) {
  "use strict";
  const { $, $$, health } = S;

  const TOOLS = ["image", "pdf", "document", "video", "audio"];
  const inited = new Set();
  let currentTool = null;

  function show(tool) {
    if (!TOOLS.includes(tool)) tool = "image";
    if (tool === currentTool) return;
    currentTool = tool;

    $$(".navitem").forEach((n) => n.classList.toggle("on", n.dataset.tool === tool));
    TOOLS.forEach((t) => { $("#view-" + t).hidden = t !== tool; });

    // lazy-init the tool the first time it's shown
    if (!inited.has(tool) && S.tools[tool]) { S.tools[tool].init(); inited.add(tool); }

    if (location.hash !== "#" + tool) history.replaceState(null, "", "#" + tool);
    document.title = "Freecompressor — " + ({ image: "images", pdf: "PDF", document: "documents", video: "video", audio: "audio" }[tool]);
  }

  function wireNav() {
    $("#nav").addEventListener("click", (e) => {
      const item = e.target.closest(".navitem"); if (item) show(item.dataset.tool);
    });
    $("#nav").addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        const item = e.target.closest(".navitem");
        if (item) { e.preventDefault(); show(item.dataset.tool); }
      }
    });
    // number shortcuts 1–5, when not typing in a field
    document.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= TOOLS.length) show(TOOLS[n - 1]);
    });
    window.addEventListener("hashchange", () => show((location.hash || "#image").slice(1)));
  }

  async function wireStatus() {
    const dot = $("#srvDot"), txt = $("#srvTxt");
    async function paint(force) {
      const h = await health(force);
      dot.classList.toggle("up", !!h.ok);
      dot.classList.toggle("down", !h.ok);
      if (h.ok) {
        const eng = h.engines || {};
        const on = Object.keys(eng).filter((k) => eng[k]);
        txt.textContent = "engine online" + (on.length ? " · " + on.length + " codecs" : "");
      } else {
        txt.textContent = "engine offline — images still work";
      }
    }
    await paint();
    setInterval(() => paint(true), 30000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    wireNav();
    wireStatus();
    show((location.hash || "#image").slice(1));
  });
})(window.Freecompressor);
