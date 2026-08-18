/**
 * One delegated listener for the whole app. Markup declares what it wants
 * with `data-action` / `data-change`; handlers register here or from the
 * page that owns them.
 *
 * Because it is delegated, re-rendering a page never leaves a dead listener
 * behind and never needs re-binding.
 */

const Actions = (() => {
  const clicks = {};
  const changes = {};

  function on(name, fn) { clicks[name] = fn; }
  function onChange(name, fn) { changes[name] = fn; }

  function bind(root) {
    root.addEventListener("click", (e) => {
      const el = e.target.closest("[data-action]");
      if (!el || !root.contains(el)) return;
      const fn = clicks[el.dataset.action];
      if (!fn) return;
      if (el.tagName !== "A" || el.getAttribute("href") === "#") e.preventDefault();
      fn(el, e);
    });

    root.addEventListener("change", (e) => {
      const el = e.target.closest("[data-change]");
      if (!el) return;
      const fn = changes[el.dataset.change];
      if (fn) fn(el, e);
    });
  }

  // Swaps a button to a pending label while an async action runs, so the
  // user gets feedback even though the result arrives over SSE.
  async function withPending(el, label, work) {
    const original = el.textContent;
    el.disabled = true;
    el.textContent = label;
    try { await work(); } catch (err) { /* surfaced by the sync indicator */ }
    el.disabled = false;
    el.textContent = original;
  }

  function post(path) {
    return fetch(path, { method: "POST" }).catch(() => {});
  }

  // ---------- core actions ----------

  on("sync-jira", (el) => withPending(el, "Syncing…", () => post("/api/jira/sync-now")));
  on("check-health", (el) => withPending(el, "Checking…", () => post("/api/health/check-now")));

  on("assign", (el) => Modals.assign(el.dataset.id));
  on("edit-note", (el) => Modals.note(el.dataset.id, el.dataset.repo));
  on("set-repo-url", (el) => Modals.repoUrl(el.dataset.id, el.dataset.repo));

  on("force-free-server", (el) => {
    const server = State.getServer(el.dataset.id);
    if (!server) return;
    const claims = State.getServerTickets(server.id);
    Modals.confirm({
      title: "Force free this environment?",
      message: `This drops all ${claims.length} active claim${claims.length === 1 ? "" : "s"} on ${server.name}. A live Jira ticket still at an occupying status may be re-claimed on the next sync.`,
      confirmLabel: "Force free all",
      onConfirm: () => State.forceFreeServer(server.id)
    });
  });

  on("force-free-ticket", (el) => {
    const ticket = State.getTicket(el.dataset.ticket);
    if (!ticket) return;
    const names = ticket.userIds.map((id) => (State.getUser(id) || {}).name).filter(Boolean).join(", ");
    Modals.confirm({
      title: "Force free this claim?",
      message: `${ticket.id} holds ${ticket.repos.join(", ")}${names ? ` for ${names}` : ""}. If the ticket is still at an occupying status, the next sync may re-claim it.`,
      confirmLabel: "Force free",
      onConfirm: () => State.forceFreeTicket(ticket.id)
    });
  });

  on("copy-url", (el) => {
    const url = el.dataset.url;
    if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
    const original = el.getAttribute("title");
    el.setAttribute("title", "Copied");
    setTimeout(() => el.setAttribute("title", original || "Copy URL"), 1500);
  });

  on("open-ticket", async (el) => {
    try {
      const config = await fetch("/api/jira-config").then((r) => r.json());
      if (!config.baseUrl) return;
      const base = /^https?:\/\//i.test(config.baseUrl) ? config.baseUrl : `https://${config.baseUrl}`;
      window.open(`${base.replace(/\/$/, "")}/browse/${encodeURIComponent(el.dataset.ticket)}`, "_blank", "noopener");
    } catch (err) { /* no server or not configured — nothing to open */ }
  });

  // ---------- filters ----------

  on("filter-account", (el) => State.setFilter("accountId", el.dataset.id));
  on("filter-status", (el) => State.setFilter("status", el.dataset.status));
  on("clear-filters", () => {
    const search = document.getElementById("search-input");
    if (search) search.value = "";
    State.clearFilters();
  });

  onChange("filter-status", (el) => State.setFilter("status", el.value));
  onChange("filter-account", (el) => State.setFilter("accountId", el.value));
  onChange("filter-user", (el) => State.setFilter("userId", el.value));

  return { on, onChange, bind, withPending };
})();
