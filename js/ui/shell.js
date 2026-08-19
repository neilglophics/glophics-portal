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

  return { render, renderSyncStatus, renderAccountMenu, toggleMenu, bind, NAV };
})();

Actions.on("toggle-account-menu", () => Shell.toggleMenu());
