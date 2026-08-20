/**
 * Boot. Everything else is either the data layer (State/Storage/Auth/
 * data.js) or the UI layer (js/ui/*). This file only wires the two
 * together:
 *
 *   sign in       → LoginScreen, then the shell
 *   State change  → Router.render()      repaint the active page + shell
 *   sync status   → Shell.renderSyncStatus()
 *   hash change   → Router.render()      handled inside Router.start()
 *
 * Nothing about the board is fetched until there is a session: State.init()
 * is only reached past the gate, and every route it uses answers 401
 * without one.
 *
 * Load order matters and is fixed in index.html: data layer, then tokens →
 * model → html → router → pages → shell/actions/modals, then this.
 */

(() => {
  async function init() {
    // Bound before the gate so the sign-in screen and the account menu are
    // live even though the app behind them hasn't started.
    Actions.bind(document.getElementById("app"));
    Modals.bind();
    Shell.bind();
    Theme.init();

    LoginScreen.renderChecking();
    await Auth.refresh();
    if (!Auth.isSignedIn()) await LoginScreen.show();
    LoginScreen.hide();

    // A seeded or freshly-reset account must set its own password before it
    // is trusted with anything else — the server enforces this on every
    // route regardless (see requirePasswordCurrent in the request pipeline),
    // this just means the first thing you see is the same "Change password"
    // dialog the avatar menu already offers, rather than a wall of 403s.
    if (Auth.mustChangePassword()) Modals.changeOwnPassword();

    await start();
  }

  async function start() {
    // A role that can't claim can't write anything either — say so once,
    // here, instead of letting every save be refused by the server.
    Storage.setReadOnly(!Auth.can("claim"));

    await State.init();

    // Any change to app data — local edit or an update pushed from another
    // viewer over SSE — repaints whatever page is open.
    State.subscribe(() => Router.render());
    State.subscribeStatus(() => {
      Shell.renderSyncStatus();
      checkSessionOnDrop();
    });

    bindSearch();
    Router.start();

    // "Frees in 40m" goes stale on its own, so the open page refreshes on a
    // slow tick even when nothing changed. Skipped while a dialog is open so
    // a repaint never yanks a half-filled form away.
    setInterval(() => {
      if (!Modals.isOpen()) Router.render();
    }, 30000);
  }

  // The live stream dropping can mean the server went away, or it can mean
  // this session ended — a super admin revoking access, or a week passing.
  // Only the second one should send someone back to the sign-in screen, so
  // ask before assuming, and ask only once per drop.
  let checkingSession = false;
  async function checkSessionOnDrop() {
    if (checkingSession || State.getSyncStatus() === "connected") return;
    checkingSession = true;
    const user = await Auth.refresh();
    checkingSession = false;
    if (!user) location.reload();
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
