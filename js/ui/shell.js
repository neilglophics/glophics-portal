/**
 * The app chrome: sidebar navigation, the per-account list, and the topbar's
 * live sync indicator. Everything here reads from State/Model — the shell
 * repaints on the same cycle as the pages.
 *
 * Adding a page means adding one NAV entry and one page file.
 */

const Shell = (() => {

  const NAV = [
    { group: "overview", id: "dashboard",    label: "Dashboard",    icon: "grid" },
    { group: "overview", id: "environments", label: "Environments", icon: "servers" },
    { group: "overview", id: "health",       label: "Health",       icon: "pulse",
      badge: (s) => s.repoOffline, tone: "rose" },
    { group: "activity", id: "in-use",       label: "In use",       icon: "clock",
      badge: (s) => s.reposHeld },
    { group: "activity", id: "tickets",      label: "Tickets",      icon: "list",
      badge: (s) => s.claims },
    { group: "activity", id: "not-tracked",  label: "Not tracked",  icon: "alert",
      badge: (s) => s.skipped, tone: "amber" },
    { group: "settings", id: "settings",     label: "Settings",     icon: "gear" }
  ];

  const BADGE_TONES = {
    rose:  "bg-bad-soft text-bad",
    amber: "bg-warn-soft text-warn",
    plain: "bg-subtle-2 text-muted"
  };

  function navLink(item, active, summary) {
    const on = item.id === active;
    const count = item.badge ? item.badge(summary) : 0;
    const tone = BADGE_TONES[item.tone || "plain"];
    return `<a href="#${item.id}"
      class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
        on ? "bg-brand-soft font-semibold text-brand-fg" : "font-medium text-muted hover:bg-subtle hover:text-ink"}">
      ${H.icon(item.icon, "h-4.5 w-4.5 shrink-0")}
      <span class="flex-1">${H.esc(item.label)}</span>
      ${count ? `<span class="rounded-full ${tone} px-2 py-0.5 text-[11px] font-bold">${count}</span>` : ""}
    </a>`;
  }

  function renderAccounts() {
    const accounts = State.getAccounts();
    const host = document.getElementById("nav-accounts");
    if (!accounts.length) {
      host.innerHTML = `<p class="px-3 py-2 text-xs text-faint">No accounts yet.</p>`;
      return;
    }
    host.innerHTML = accounts.map((account) => {
      const rows = State.getServers()
        .filter((s) => s.accountId === account.id)
        .map((s) => State.getDisplayStatus(s));
      const free = rows.filter((s) => s === "free").length;
      const dot = rows.includes("issue") ? "bg-rose-500" : free ? "bg-emerald-500" : "bg-amber-500";
      return `<a href="#environments" data-action="filter-account" data-id="${H.esc(account.id)}"
        class="flex items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-subtle">
        <span class="h-2 w-2 shrink-0 rounded-full ${dot}"></span>
        <span class="flex-1 truncate text-sm font-medium text-ink-2">${H.esc(account.displayName)}</span>
        <span class="text-[11px] font-semibold text-faint">${free}/${rows.length}</span>
      </a>`;
    }).join("");
  }

  function renderSyncStatus() {
    const el = document.getElementById("sync-indicator");
    if (!el) return;
    const connected = State.getSyncStatus() === "connected";
    const jira = State.getSettings().jira;
    const last = State.getLastJiraSyncAt();
    const label = !jira.enabled ? "Jira off"
      : last ? `Synced ${Format.agoText(last)} ago`
      : "Not synced yet";
    el.innerHTML = `
      <span class="h-2 w-2 shrink-0 rounded-full ${connected ? "bg-emerald-500" : "bg-faintest"}"></span>
      <span class="hidden truncate sm:inline">${H.esc(connected ? label : "Local only")}</span>`;
    el.title = connected ? "Live — changes sync to everyone" : "No server connection; changes stay in this browser";
  }

  function render(activeId) {
    const summary = Model.summary();
    ["overview", "activity", "settings"].forEach((group) => {
      const host = document.querySelector(`[data-nav-group="${group}"]`);
      if (host) host.innerHTML = NAV.filter((n) => n.group === group)
        .map((n) => navLink(n, activeId, summary)).join("");
    });
    renderAccounts();
    renderSyncStatus();
  }

  return { render, renderSyncStatus, NAV };
})();
