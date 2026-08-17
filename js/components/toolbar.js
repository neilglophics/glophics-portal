/**
 * Search box, account/status/user filters, and the Table/Board view tabs.
 */

const Toolbar = (() => {
  const { escapeHtml } = Format;
  function el(id) { return document.getElementById(id); }

  function renderFilterOptions() {
    const userSelect = el("filter-user");
    const accountSelect = el("filter-account");
    const filters = State.getFilters();

    userSelect.innerHTML = `<option value="all">Anyone</option>` +
      State.getUsers().map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
    userSelect.value = filters.userId;

    accountSelect.innerHTML = `<option value="all">All accounts</option>` +
      State.getAccounts().map((a) => `<option value="${a.id}">${escapeHtml(a.displayName)}</option>`).join("");
    accountSelect.value = filters.accountId;

    el("filter-status").value = filters.status;
  }

  function setViewMode(mode) {
    UiState.setViewMode(mode);
    document.querySelectorAll("#view-tabs .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    el("view-table").hidden = mode !== "table";
    el("view-board").hidden = mode !== "board";
    EnvTable.render();
    EnvBoard.render();
  }

  function bindEvents() {
    el("search-input").addEventListener("input", (e) => {
      State.setFilter("search", e.target.value);
    });
    el("filter-status").addEventListener("change", (e) => State.setFilter("status", e.target.value));
    el("filter-user").addEventListener("change", (e) => State.setFilter("userId", e.target.value));
    el("filter-account").addEventListener("change", (e) => State.setFilter("accountId", e.target.value));
    el("clear-filters").addEventListener("click", () => {
      el("search-input").value = "";
      State.clearFilters();
    });

    el("view-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest(".tab-btn");
      if (!btn) return;
      setViewMode(btn.dataset.mode);
    });
  }

  return { renderFilterOptions, setViewMode, bindEvents };
})();
