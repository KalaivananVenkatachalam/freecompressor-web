/* PDF tool — Ghostscript-backed downsampling + stream recompression. */
(function (S) {
  "use strict";
  const fileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
  S.buildServerTool({
    id: "pdf",
    title: "PDF",
    chip: "downsample · recompress · local engine",
    description: "Shrink PDFs by downsampling embedded images and recompressing streams with <b>Ghostscript</b>. Pick a target profile, and optionally force grayscale for scanned or text-heavy documents.",
    endpoint: "/api/compress/pdf",
    accept: "application/pdf,.pdf",
    engine: "Ghostscript",
    engineKey: "ghostscript",
    dropText: "Drop a PDF or click to choose",
    dropHint: "PDF",
    emptyBig: "No PDF loaded",
    emptySm: "drop a .pdf to begin",
    hint: "Profiles map to Ghostscript presets: Screen ≈ 72 dpi, eBook ≈ 150 dpi, Print ≈ 300 dpi.",
    icon: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h1.5a1.5 1.5 0 0 1 0 3H9zM9 13v6"/></svg>',
    fileIcon,
    controls: [
      { kind: "seg", name: "profile", label: "Target profile", value: "ebook",
        options: [{ v: "screen", label: "Screen" }, { v: "ebook", label: "eBook" }, { v: "printer", label: "Print" }] },
      { kind: "slider", name: "dpi", label: "Max image DPI", value: 150, min: 72, max: 300, step: 6, unit: " dpi", rule: true },
      { kind: "check", name: "grayscale", label: "Convert to grayscale", value: false },
      { kind: "check", name: "stripMeta", label: "Strip metadata", value: true },
    ],
    note: (st) => {
      const p = { screen: "smallest, screen-only quality", ebook: "balanced — good for sharing", printer: "print-ready, larger" }[st.profile];
      return "Profile: <b>" + st.profile + "</b> (" + p + "). Images above <b>" + st.dpi + " dpi</b> are downsampled." +
        (st.grayscale ? " Output forced to grayscale." : "");
    },
    buildOptions: (st) => ({ profile: st.profile, dpi: st.dpi, grayscale: st.grayscale ? "1" : "0", stripMeta: st.stripMeta ? "1" : "0" }),
    resultSub: (res, st) => "Ghostscript · " + st.profile + " profile · " + st.dpi + " dpi cap" + (st.grayscale ? " · grayscale" : ""),
    validate: (f) => /pdf$/i.test(f.name) || f.type === "application/pdf",
  });
})(window.Freecompressor);
