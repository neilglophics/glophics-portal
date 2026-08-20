/**
 * The app chrome: sidebar navigation, the per-account list, the topbar's
 * live sync indicator, and the signed-in account menu. Everything here
 * reads from State/Model/Auth — the shell repaints on the same cycle as
 * the pages.
 *
 * Adding a page means adding one NAV entry and one page file. A NAV entry
 * with `requires` only appears for a role that holds that capability;
 * hiding it is courtesy, and the route behind it is checked again on the
 * server.
 */

const Shell = (() => {

  // Whether the account dropdown is open. View state, not app data — it
  // lives here so a repaint (a booking someone else made, say) doesn't
  // snap the menu shut under the pointer.
  let menuOpen = false;
  let sidebar_minimized = false;

  try {
    sidebar_minimized = localStorage.getItem("serverManager.sidebarMinimized") === "true";
  } catch (err) {
    // Storage may be blocked; the expanded sidebar remains the safe default.
  }

  const NAV = [
    { group: "overview", id: "dashboard",    label: "Dashboard",    icon: "grid" },
    { group: "overview", id: "tickets",      label: "Active tickets", icon: "list",
      badge: (s) => s.claims },
    { group: "overview", id: "assignees",    label: "My tickets",   icon: "users",
      badge: (s) => s.myTickets },
    { group: "overview", id: "environments", label: "Environments", icon: "servers" },
    { group: "overview", id: "health",       label: "Health",       icon: "pulse",
      badge: (s) => s.repoOffline, tone: "rose" },
    { group: "activity", id: "in-use",       label: "In use",       icon: "clock",
      badge: (s) => s.reposHeld },
    { group: "activity", id: "not-tracked",  label: "Not tracked",  icon: "alert",
      badge: (s) => s.skipped, tone: "amber" },
    { group: "settings", id: "users",        label: "Users",        icon: "users",
      requires: "manage-users" },
    { group: "settings", id: "settings",     label: "Settings",     icon: "gear",
      requires: "configure" }
  ];

  const BADGE_TONES = {
    rose:  "bg-bad-soft text-bad",
    amber: "bg-warn-soft text-warn",
    plain: "bg-subtle-2 text-muted"
  };

  function visibleNav() {
    return NAV.filter((item) => !item.requires || Auth.can(item.requires));
  }

  function navLink(item, active, summary) {
    const on = item.id === active;
    const count = item.badge ? item.badge(summary) : 0;
    const tone = BADGE_TONES[item.tone || "plain"];
    return `<a href="#${item.id}" title="${H.esc(item.label)}" data-sidebar-link
      class="relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
        on ? "bg-brand-soft font-semibold text-brand-fg" : "font-medium text-muted hover:bg-subtle hover:text-ink"}">
      ${H.icon(item.icon, "h-4.5 w-4.5 shrink-0")}
      <span class="sidebar-label flex-1">${H.esc(item.label)}</span>
      ${count ? `<span data-sidebar-badge class="rounded-full ${tone} px-2 py-0.5 text-[11px] font-bold">${count}</span>` : ""}
    </a>`;
  }

  function accountAlias(display_name) {
    const words = String(display_name || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return words.slice(0, 3).map((word) => word[0]).join("").toUpperCase();
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
      const dot = rows.includes("issue") ? "bg-bad" : free ? "bg-ok" : "bg-warn";
      const alias = accountAlias(account.displayName);
      return `<a href="#environments" data-action="filter-account" data-id="${H.esc(account.id)}"
        data-sidebar-link data-sidebar-account title="${H.esc(`${account.displayName}: ${free} of ${rows.length} free`)}"
        class="flex items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-subtle">
        <span class="h-2 w-2 shrink-0 rounded-full ${dot}"></span>
        <span class="sidebar-account-alias text-[9px] font-bold tracking-tight text-ink-2" aria-hidden="true">${H.esc(alias)}</span>
        <span class="sidebar-label flex-1 truncate text-sm font-medium text-ink-2">${H.esc(account.displayName)}</span>
        <span class="sidebar-account-count text-[11px] font-semibold text-faint">${free}/${rows.length}</span>
      </a>`;
    }).join("");
  }

  function renderSidebarState() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    const toggle = sidebar.querySelector('[data-action="toggle-sidebar"]');
    const label = sidebar_minimized ? "Expand sidebar" : "Minimize sidebar";
    sidebar.dataset.minimized = String(sidebar_minimized);
    if (!toggle) return;
    toggle.setAttribute("aria-expanded", String(!sidebar_minimized));
    toggle.setAttribute("title", label);
    const accessible_label = toggle.querySelector(".sr-only");
    if (accessible_label) accessible_label.textContent = label;
  }

  function toggleSidebar() {
    sidebar_minimized = !sidebar_minimized;
    try {
      localStorage.setItem("serverManager.sidebarMinimized", String(sidebar_minimized));
    } catch (err) {
      // The visual toggle still works when persistence is unavailable.
    }
    renderSidebarState();
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
      <span class="h-2 w-2 shrink-0 rounded-full ${connected ? "bg-ok" : "bg-faintest"}"></span>
      <span class="hidden truncate sm:inline">${H.esc(connected ? label : "Local only")}</span>`;
    el.title = connected ? "Live — changes sync to everyone" : "No server connection; changes stay in this browser";
  }

  // ---------- who is signed in ----------

  function menuItem(iconName, label, action) {
    return `<button type="button" data-action="${action}"
      class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium text-body transition hover:bg-subtle hover:text-ink">
      ${H.icon(iconName, "h-3.5 w-3.5 shrink-0 text-faint")}${H.esc(label)}</button>`;
  }

  function renderAccountMenu() {
    const host = document.getElementById("account-menu");
    if (!host) return;
    const user = Auth.user();
    if (!user) { host.innerHTML = ""; return; }

    const person = { id: user.id, name: user.displayName };
    host.innerHTML = `
      <button type="button" data-action="toggle-account-menu" aria-haspopup="menu" aria-expanded="${menuOpen}"
              class="flex shrink-0 items-center gap-3 rounded-full pl-0 pr-1 transition hover:opacity-80">
        ${H.avatar(person, "h-10 w-10")}
        <span class="hidden text-left lg:block">
          <span class="block text-sm font-semibold leading-tight">${H.esc(user.displayName)}</span>
          <span class="block text-[10px] font-semibold uppercase tracking-wide text-faint">${H.esc(Auth.roleName())}</span>
        </span>
      </button>
      ${menuOpen ? `
        <div role="menu"
             class="absolute right-0 top-full z-40 mt-2 w-56 rounded-2xl bg-surface p-2 shadow-xl ring-1 ring-line">
          <div class="border-b border-line px-3 pb-2.5 pt-1.5">
            <p class="truncate text-sm font-semibold">${H.esc(user.displayName)}</p>
            <p class="truncate text-[11px] text-faint">@${H.esc(user.username)}</p>
          </div>
          <div class="pt-1.5">
            ${menuItem("key", "Change password", "change-own-password")}
            ${menuItem("logout", "Sign out", "sign-out")}
          </div>
        </div>` : ""}`;
  }

  function toggleMenu(force) {
    const next = force === undefined ? !menuOpen : force;
    if (next === menuOpen) return;
    menuOpen = next;
    renderAccountMenu();
  }

  // The menu is the one piece of chrome that has to close when the click
  // lands somewhere else entirely, so it listens at the document rather
  // than through the app's delegated handler.
  //
  // In the capture phase, deliberately: opening the menu re-renders
  // #account-menu, which detaches the button that was clicked. A bubbling
  // listener would then run against a node no longer in the document,
  // where closest("#account-menu") finds nothing and reads as a click
  // outside — closing the menu in the same gesture that opened it.
  // Capturing runs first, while the DOM the click happened in is intact.
  function bind() {
    renderSidebarState();
    document.addEventListener("click", (e) => {
      if (!menuOpen) return;
      if (e.target.closest("#account-menu")) return;
      toggleMenu(false);
    }, true);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") toggleMenu(false);
    });
  }

  function render(activeId) {
    renderSidebarState();
    const summary = Model.summary();
    const items = visibleNav();
    ["overview", "activity", "settings"].forEach((group) => {
      const host = document.querySelector(`[data-nav-group="${group}"]`);
      if (!host) return;
      const inGroup = items.filter((n) => n.group === group);
      host.innerHTML = inGroup.map((n) => navLink(n, activeId, summary)).join("");
      // A group whose every entry is hidden by role hides its heading too,
      // rather than leaving a label over nothing.
      const heading = host.parentElement.querySelector("p");
      if (heading) heading.classList.toggle("hidden", inGroup.length === 0);
    });
    renderAccounts();
    renderSyncStatus();
    renderAccountMenu();
  }

  return { render, renderSyncStatus, renderAccountMenu, toggleMenu, toggleSidebar, bind, NAV };
})();

Actions.on("toggle-account-menu", () => Shell.toggleMenu());
Actions.on("toggle-sidebar", () => Shell.toggleSidebar());
