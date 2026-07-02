/* Document tool — recompress the Office ZIP container + re-encode embedded media. */
(function (S) {
  "use strict";
  const fileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h8"/></svg>';
  S.buildServerTool({
    id: "document",
    title: "Documents",
    chip: "DOCX · PPTX · XLSX · local engine",
    description: "Office files are ZIP containers. Freecompressor re-encodes their embedded images and repacks the archive with maximum deflate — often a large win on image-heavy <b>Word, PowerPoint and Excel</b> files, with the document fully intact.",
    endpoint: "/api/compress/document",
    accept: ".docx,.pptx,.xlsx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    engine: "media re-encoder",
    engineKey: "sharp",
    dropText: "Drop a document or click to choose",
    dropHint: "DOCX · PPTX · XLSX",
    emptyBig: "No document loaded",
    emptySm: "drop a .docx, .pptx or .xlsx",
    hint: "The document’s text, layout and structure are preserved — only embedded images and archive packing change.",
    icon: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h8M8 9h2"/></svg>',
    fileIcon,
    controls: [
      { kind: "slider", name: "quality", label: "Image quality", value: 78, min: 40, max: 95, step: 1, unit: "" },
      { kind: "slider", name: "maxWidth", label: "Max image width", value: 1600, min: 800, max: 3000, step: 100, unit: " px", rule: true },
      { kind: "check", name: "keepPng", label: "Keep PNGs lossless (logos, screenshots)", value: true },
    ],
    note: (st) =>
      "Embedded photos re-encoded at quality <b>" + st.quality + "</b>, capped at <b>" + st.maxWidth + " px</b> wide." +
      (st.keepPng ? " PNGs are optimized losslessly." : " PNGs may be converted to JPEG where opaque."),
    buildOptions: (st) => ({ quality: st.quality, maxWidth: st.maxWidth, keepPng: st.keepPng ? "1" : "0" }),
    resultSub: (res) => {
      const m = res.meta || {};
      return "Repacked archive" + (m.images != null ? " · " + m.images + " image" + (m.images === 1 ? "" : "s") + " re-encoded" : "");
    },
    validate: (f) => /\.(docx|pptx|xlsx)$/i.test(f.name),
  });
})(window.Freecompressor);
