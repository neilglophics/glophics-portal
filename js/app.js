/**
 * Boot. Everything else is either the data layer (State/Storage/data.js) or
 * the UI layer (js/ui/*). This file only wires the two together:
 *
 *   State change  → Router.render()      repaint the active page + shell
 *   sync status   → Shell.renderSyncStatus()
 *   hash change   → Router.render()      handled inside Router.start()
 *
 * Load order matters and is fixed in index.html: data layer, then tokens →
 * model → html → router → pages → shell/actions/modals, then this.
 */

(() => {
  async function init() {
    await State.init();

    // Any change to app data — local edit or an update pushed from another
    // viewer over SSE — repaints whatever page is open.
    State.subscribe(() => Router.render());
    State.subscribeStatus(() => Shell.renderSyncStatus());

    Actions.bind(document.getElementById("app"));
    Modals.bind();
    bindSearch();

    Router.start();

    // "Frees in 40m" goes stale on its own, so the open page refreshes on a
    // slow tick even when nothing changed. Skipped while a dialog is open so
    // a repaint never yanks a half-filled form away.
    setInterval(() => {
      if (!Modals.isOpen()) Router.render();
    }, 30000);
  }

  function bindSearch() {
    const input = document.getElementById("search-input");
    if (!input) return;
    let timer = null;
    input.addEventListener("input", (e) => {
      clearTimeout(timer);
      const value = e.target.value;
      timer = setTimeout(() => {
        State.setFilter("search", value);
        if (Router.currentId() !== "environments" && value.trim()) Router.go("environments");
      }, 200);
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
