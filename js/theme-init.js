/* Runs synchronously in <head> before first paint to avoid a theme flash. */
(function () {
  try {
    // Always start in light mode; honor the user's saved choice if they've
    // toggled before. System dark-mode preference is intentionally ignored.
    var t = localStorage.getItem("fc-theme") || "light";
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
})();
