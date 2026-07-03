/* ============================================================================
   FreeCompressor — site.js
   Shared behaviour for every page: theme switch, nav, dropdowns, scroll
   reveal, toast, and the "notify me" UI. No dependencies, ~4 KB.
   ========================================================================== */
(function () {
  "use strict";
  var d = document;
  var $ = function (s, r) { return (r || d).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || d).querySelectorAll(s)); };

  /* ---- theme ------------------------------------------------------------ */
  // The <head> bootstrap already set data-theme before paint; this wires toggles.
  function setTheme(t) {
    d.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("fc-theme", t); } catch (e) {}
  }
  $$(".theme-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var cur = d.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      setTheme(cur === "dark" ? "light" : "dark");
    });
  });

  /* ---- mobile nav --------------------------------------------------------- */
  var nav = $(".nav");
  var burger = $(".nav-burger");
  if (burger && nav) {
    burger.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      burger.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  /* ---- dropdowns ---------------------------------------------------------- */
  $$(".dd").forEach(function (dd) {
    var btn = $("button", dd);
    if (!btn) return;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = dd.classList.toggle("open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    dd.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { dd.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); btn.focus(); }
    });
  });
  d.addEventListener("click", function () {
    $$(".dd.open").forEach(function (dd) {
      dd.classList.remove("open");
      var btn = $("button", dd);
      if (btn) btn.setAttribute("aria-expanded", "false");
    });
  });

  /* ---- scroll reveal ------------------------------------------------------ */
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var els = $$(".reveal");
  if (reduced || !("IntersectionObserver" in window)) {
    els.forEach(function (el) { el.classList.add("in"); });
  } else if (els.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    els.forEach(function (el) { io.observe(el); });
  }

  /* ---- toast --------------------------------------------------------------*/
  var toastEl = $("#toast");
  var toastT;
  function toast(msg, isErr) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.toggle("err", !!isErr);
    toastEl.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove("show"); }, 3200);
  }

  /* ---- notify me (UI only) ------------------------------------------------ */
  $$(".notify-wrap").forEach(function (wrap) {
    var form = $("form", wrap);
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = $("input[type=email]", form);
      if (!input || !input.value || input.value.indexOf("@") < 1) {
        toast("Please enter a valid email address.", true);
        if (input) input.focus();
        return;
      }
      try {
        var key = "fc-notify";
        var list = JSON.parse(localStorage.getItem(key) || "[]");
        list.push({ email: input.value, tool: wrap.getAttribute("data-tool") || "", at: new Date().toISOString() });
        localStorage.setItem(key, JSON.stringify(list));
      } catch (err) {}
      wrap.classList.add("done");
    });
  });

  /* ---- blog category filter ------------------------------------------------*/
  var catRow = $("#blog-cats"), blogGrid = $("#blog-grid"), blogNone = $("#blog-none");
  if (catRow && blogGrid) {
    catRow.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-filter]");
      if (!b) return;
      $$("button", catRow).forEach(function (x) { x.classList.toggle("on", x === b); });
      var f = b.dataset.filter, shown = 0;
      $$("[data-cat]", blogGrid).forEach(function (c) {
        var on = f === "All" || c.dataset.cat === f;
        c.style.display = on ? "" : "none";
        if (on) shown++;
      });
      if (blogNone) blogNone.style.display = shown ? "none" : "block";
    });
  }

  /* ---- contact form → mail compose ------------------------------------------*/
  var cf = $("#contact-form");
  if (cf) {
    cf.addEventListener("submit", function (e) {
      e.preventDefault();
      var n = $("#cf-name").value, em = $("#cf-email").value, m = $("#cf-msg").value;
      location.href = "mailto:hello@freecompressor.online?subject=" +
        encodeURIComponent("FreeCompressor — message from " + n) +
        "&body=" + encodeURIComponent(m + "\n\n— " + n + " (" + em + ")");
    });
  }

  /* ---- anonymous pageview beacon -------------------------------------------
     Privacy-safe: an ephemeral per-tab session id, the path, and the referrer
     (categorized server-side). No cookies, no PII. Fires once per page load,
     never on the admin console. Fails silently on the static (no-backend)
     deploy — it only lands when the page is served by the engine.            */
  (function () {
    try {
      if (location.pathname.indexOf("/admin") === 0) return;
      var sid = sessionStorage.getItem("fc-sid");
      var first = false;
      if (!sid) {
        sid = (String(Date.now()) + Math.random().toString(36).slice(2, 10)).slice(0, 32);
        sessionStorage.setItem("fc-sid", sid);
        first = !localStorage.getItem("fc-seen"); // first-ever session = new visitor-ish
        try { localStorage.setItem("fc-seen", "1"); } catch (e) {}
      }
      var body = JSON.stringify({ sid: sid, path: location.pathname, ref: document.referrer || "", first: first });
      var url = (window.FREECOMPRESSOR_API_BASE || "") + "/api/analytics/pageview";
      if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      else fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true }).catch(function () {});
    } catch (e) { /* analytics must never break the page */ }
  })();

  /* ---- footer year --------------------------------------------------------*/
  $$("[data-year]").forEach(function (el) { el.textContent = String(new Date().getFullYear()); });

  window.FC = window.FC || {};
  window.FC.toast = toast;
})();
