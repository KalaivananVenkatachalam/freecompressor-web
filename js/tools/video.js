/* Video tool — ffmpeg-backed transcode: codec, CRF quality, scale, audio bitrate. */
(function (S) {
  "use strict";
  const fileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 9l5-3v12l-5-3z"/></svg>';
  S.buildServerTool({
    id: "video",
    title: "Video",
    chip: "H.264 · H.265 · VP9 · local engine",
    description: "Transcode and shrink video with <b>ffmpeg</b>. Choose a codec, dial in constant-quality (CRF), and optionally scale down the resolution. Lower CRF = higher quality and larger files.",
    endpoint: "/api/compress/video",
    accept: "video/*",
    engine: "ffmpeg",
    engineKey: "ffmpeg",
    dropText: "Drop a video or click to choose",
    dropHint: "MP4 · MOV · WEBM · MKV",
    emptyBig: "No video loaded",
    emptySm: "drop a video to begin",
    hint: "CRF is a constant-quality target. 18 is visually lossless; 23 is a good default; 28+ is aggressive.",
    workMsg: "Transcoding… this can take a while for long clips",
    icon: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 9l5-3v12l-5-3z"/></svg>',
    fileIcon,
    preview: "image",
    controls: [
      { kind: "seg", name: "codec", label: "Codec", value: "h264",
        options: [{ v: "h264", label: "H.264" }, { v: "h265", label: "H.265" }, { v: "vp9", label: "VP9" }] },
      { kind: "slider", name: "crf", label: "Quality (CRF)", value: 26, min: 18, max: 34, step: 1,
        format: (v) => v + (v <= 20 ? " · high" : v <= 26 ? " · balanced" : " · small") },
      { kind: "select", name: "scale", label: "Resolution", value: "keep", rule: true,
        options: [{ v: "keep", label: "Keep original" }, { v: "1080", label: "1080p" }, { v: "720", label: "720p" }, { v: "480", label: "480p" }] },
      { kind: "select", name: "audio", label: "Audio bitrate", value: "128",
        options: [{ v: "128", label: "128 kbps" }, { v: "96", label: "96 kbps" }, { v: "64", label: "64 kbps" }, { v: "mute", label: "Remove audio" }] },
    ],
    note: (st) => {
      const c = { h264: "H.264 — universal compatibility", h265: "H.265 — ~40% smaller, newer players", vp9: "VP9 — WebM, great for web" }[st.codec];
      const r = st.scale === "keep" ? "original resolution" : "scaled to " + st.scale + "p";
      return c + ". CRF <b>" + st.crf + "</b>, " + r + ".";
    },
    buildOptions: (st) => ({ codec: st.codec, crf: st.crf, scale: st.scale, audio: st.audio }),
    resultSub: (res, st) => {
      const m = res.meta || {};
      const ext = st.codec === "vp9" ? "webm" : "mp4";
      return ext.toUpperCase() + " · " + st.codec.toUpperCase() + " · CRF " + st.crf +
        (m.width ? " · " + m.width + "×" + m.height : "") + (m.duration ? " · " + S.fmtDuration(m.duration) : "");
    },
    outName: (orig, res, st) => S.baseName(orig) + "-min." + (st.codec === "vp9" ? "webm" : "mp4"),
    validate: (f) => f.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(f.name),
  });
})(window.Freecompressor);
