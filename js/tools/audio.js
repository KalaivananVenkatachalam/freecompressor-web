/* Audio tool — ffmpeg-backed transcode: format, bitrate, mono, sample rate. */
(function (S) {
  "use strict";
  const fileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  S.buildServerTool({
    id: "audio",
    title: "Audio",
    chip: "MP3 · AAC · Opus · local engine",
    description: "Re-encode audio at a lower bitrate with <b>ffmpeg</b>. Opus gives the best quality-per-byte; MP3 is the most compatible. Drop stereo to mono to roughly halve the size of voice recordings.",
    endpoint: "/api/compress/audio",
    accept: "audio/*",
    engine: "ffmpeg",
    engineKey: "ffmpeg",
    dropText: "Drop audio or click to choose",
    dropHint: "MP3 · WAV · M4A · FLAC",
    emptyBig: "No audio loaded",
    emptySm: "drop an audio file to begin",
    hint: "For spoken-word content, 64 kbps mono Opus is transparent and tiny. Music wants 128 kbps+ stereo.",
    workMsg: "Re-encoding audio…",
    icon: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    fileIcon,
    controls: [
      { kind: "seg", name: "format", label: "Format", value: "mp3",
        options: [{ v: "mp3", label: "MP3" }, { v: "aac", label: "AAC" }, { v: "opus", label: "Opus" }] },
      { kind: "slider", name: "bitrate", label: "Bitrate", value: 128, min: 32, max: 256, step: 16, unit: " kbps" },
      { kind: "check", name: "mono", label: "Downmix to mono", value: false, rule: true },
    ],
    note: (st) => {
      const f = { mp3: "MP3 — plays everywhere", aac: "AAC — efficient, Apple-friendly", opus: "Opus — best quality per byte" }[st.format];
      return f + ". Target <b>" + st.bitrate + " kbps</b>" + (st.mono ? ", mono." : ", stereo.");
    },
    buildOptions: (st) => ({ format: st.format, bitrate: st.bitrate, mono: st.mono ? "1" : "0" }),
    resultSub: (res, st) => st.format.toUpperCase() + " · " + st.bitrate + " kbps" + (st.mono ? " · mono" : " · stereo"),
    outName: (orig, res, st) => S.baseName(orig) + "-min." + (st.format === "aac" ? "m4a" : st.format),
    validate: (f) => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|flac|ogg|aac|opus|wma)$/i.test(f.name),
  });
})(window.Freecompressor);
