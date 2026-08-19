/**
 * Hash router and page registry.
 *
 * A page is `{ label, render() }` and registers itself, so adding one means
 * creating a file and adding a NAV entry in shell.js — nothing here changes.
 */

const Router = (() => {
  const pages = {};
  const FALLBACK = "dashboard";

  function register(id, page) { pages[id] = page; }

  function page(id) { return pages[id] || null; }

  function currentId() {
    const id = (location.hash || "").replace(/^#/, "");
    return pages[id] ? id : FALLBACK;
  }

  // A page repaints on every State change — including one pushed from
  // another viewer over SSE — so half-typed input has to survive the
  // replacement. Values are keyed by what the field is, not where it sits
  // in the DOM, and the focused field keeps its caret.
  function fieldKey(el) {
    if (el.id) return "id:" + el.id;
    const row = el.closest("[data-dir-row]");
    const scope = row ? row.getAttribute("data-dir-row") + "/" : "";
    if (el.dataset.add) return scope + "add:" + el.dataset.add;
    if (el.dataset.field) return scope + "field:" + el.dataset.field + ":" + (el.dataset.repo || "");
    return null;
  }

  function snapshot(host) {
    const values = new Map();
    host.querySelectorAll("input, textarea, select").forEach((el) => {
      if (el.type === "checkbox" || el.type === "radio") return; // driven by data
      const key = fieldKey(el);
      if (!key) return;
      values.set(key, {
        value: el.value,
        focused: el === document.activeElement,
        start: el.selectionStart,
        end: el.selectionEnd
      });
    });
    return values;
  }

  function restore(host, values) {
    if (!values.size) return;
    host.querySelectorAll("input, textarea, select").forEach((el) => {
      if (el.type === "checkbox" || el.type === "radio") return;
      const key = fieldKey(el);
      if (!key || !values.has(key)) return;
      const saved = values.get(key);
      el.value = saved.value;
      if (saved.focused) {
        el.focus();
        try { el.setSelectionRange(saved.start, saved.end); } catch (err) { /* not a text field */ }
      }
    });
  }

  // Re-renders the active page in place. Called on navigation and on every
  // State change, so a booking made in another tab repaints this one.
  function render() {
    const id = currentId();
    const host = document.getElementById("view");
    const scrollTop = host.scrollTop;
    const values = snapshot(host);

    host.innerHTML = pages[id].render();
    if (pages[id].mount) pages[id].mount(host);

    restore(host, values);
    host.scrollTop = scrollTop;
    Shell.render(id);
  }

  function go(id) { location.hash = "#" + id; }

  function start() {
    window.addEventListener("hashchange", () => {
      render();
      document.getElementById("view").scrollTop = 0;
    });
    render();
  }

  return { register, page, currentId, render, go, start };
})();
