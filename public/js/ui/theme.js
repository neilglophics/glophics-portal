/**
 * Light/dark switching.
 *
 * The whole theme is a set of CSS variables on `html.dark` (see index.html),
 * so this only ever adds or removes one class — no component knows which
 * theme is active, and nothing needs a `dark:` variant.
 *
 * The class is applied by an inline script in <head> before first paint;
 * this module owns the toggle and remembering the choice.
 */

const Theme = (() => {
  const KEY = "serverManager.theme";

  const isDark = () => document.documentElement.classList.contains("dark");

  function apply(dark) {
    document.documentElement.classList.toggle("dark", dark);
    try { localStorage.setItem(KEY, dark ? "dark" : "light"); } catch (err) { /* storage blocked */ }
    render();
  }

  function toggle() { apply(!isDark()); }

  // Sun when dark (click for light), moon when light (click for dark).
  const SUN = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.4 5.6l-1.4 1.4M7 17l-1.4 1.4M18.4 18.4L17 17M7 7L5.6 5.6"/>';
  const MOON = '<path d="M20 14.5A8.2 8.2 0 019.5 4 8.5 8.5 0 1020 14.5z"/>';

  function render() {
    const el = document.getElementById("theme-toggle");
    if (!el) return;
    const dark = isDark();
    el.setAttribute("title", dark ? "Switch to light" : "Switch to dark");
    el.setAttribute("aria-label", el.getAttribute("title"));
    el.setAttribute("aria-pressed", dark ? "true" : "false");
    el.innerHTML = `<svg class="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${dark ? SUN : MOON}</svg>`;
  }

  // Someone who has never chosen keeps following the OS.
  function followSystem() {
    let stored = null;
    try { stored = localStorage.getItem(KEY); } catch (err) { /* storage blocked */ }
    if (stored) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => document.documentElement.classList.toggle("dark", e.matches) || render();
    if (media.addEventListener) media.addEventListener("change", onChange);
  }

  function init() {
    render();
    followSystem();
  }

  return { init, toggle, isDark };
})();

Actions.on("toggle-theme", () => Theme.toggle());
