/**
 * Boot sequence only. Every component owns its own rendering and event
 * wiring (see js/components/*.js) — this file just starts State, tells
 * each component to render once and bind its events, and re-runs the full
 * render whenever State says something changed.
 */

(() => {
  function renderAll() {
    KpiRow.render();
    SyncBar.render();
    Toolbar.renderFilterOptions();
    EnvTable.render();
    EnvBoard.render();
    SettingsConfig.render();
    SettingsRules.render();
    SettingsJira.render();
  }

  async function init() {
    await State.init();
    State.subscribe(renderAll);
    State.subscribeStatus(Topbar.renderSyncStatus);
    renderAll();
    Topbar.renderSyncStatus(State.getSyncStatus());

    Topbar.bindEvents();
    Toolbar.bindEvents();
    SyncBar.bindEvents();
    EnvTable.bindEvents();
    EnvBoard.bindEvents();
    AssignModal.bindEvents();
    ConfirmModal.bindEvents();
    SettingsJira.bindEvents();
    SettingsRules.bindEvents();
    SettingsConfig.bindEvents();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
