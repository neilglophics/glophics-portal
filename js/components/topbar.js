/**
 * Header: clock, sync-status dot, and the Dashboard/Settings page tabs.
 */

const Topbar = (() => {
  function el(id) { return document.getElementById(id); }

  function renderSyncStatus(status) {
    const elm = el("sync-status");
    if (!elm) return;
    if (status === "connected") {
      elm.textContent = "Live · synced";
      elm.className = "sync-status sync-connected";
    } else {
      elm.textContent = "Local only";
      elm.className = "sync-status sync-offline";
    }
  }

  function tickClock() {
    el("clock").textContent = Format.formatClock(new Date());
  }

  function bindEvents() {
    tickClock();
    setInterval(tickClock, 1000 * 30);

    el("nav-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest(".tab-btn");
      if (!btn) return;
      document.querySelectorAll("#nav-tabs .tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      const view = btn.dataset.view;
      document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
    });
  }

  return { renderSyncStatus, bindEvents };
})();
