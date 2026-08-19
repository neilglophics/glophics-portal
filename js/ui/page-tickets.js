/**
 * Every ticket currently holding a repository, one row each — the whole
 * list, cut by Jira status.
 *
 * This is the page the overview links into: the Dashboard shows the five
 * freeing up first, and anyone who wants "who has what, and until when?"
 * comes here. Soonest to free sorts first, the order In use uses too.
 *
 * Status is the cut that matters, so it is chips rather than a dropdown:
 * every status in play is visible with its count before anything is
 * clicked, which a <select> can't do.
 */

Router.register("tickets", {
  label: "Active tickets",

  // Which Jira status the table is cut to — the status label itself, or
  // "all". View state, not app data: it lives on the page object so a
  // repaint (a sync landing, someone else booking) leaves the filter where
  // the reader put it instead of snapping it back to "all".
  statusFilter: "all",

  render() {
    const rows = Model.claimRows();
    const shown = rows.filter(({ claim }) => this.matches(claim));
    const s = Model.summary();
    const filtered = this.statusFilter !== "all";
    const envCount = new Set(rows.map((r) => r.server.id)).size;
    const occupying = State.getSettings().jira.occupyingStatuses || [];

    return H.page(`
      ${H.pageHead("Active tickets",
        !rows.length ? "No ticket is holding a repository"
          : filtered
            ? `${shown.length} of ${rows.length} shown · ${H.esc(this.statusFilter)}`
            : `${rows.length} ticket${rows.length === 1 ? " is" : "s are"} holding a repository right now`,
        H.btn("Sync now", { data: { "data-action": "sync-jira" } }))}

      <section class="grid grid-cols-1 gap-4 pb-5 md:grid-cols-3">
        ${H.statTile("info", "Active tickets", rows.length,
          `across ${envCount} environment${envCount === 1 ? "" : "s"}`, "list")}
        ${H.statTile("alt", "People holding", s.people, "across all accounts", "users")}
        ${H.statTile("neutral", "Not tracked", s.skipped, "could not be matched", "alert")}
      </section>

      <div class="flex flex-wrap gap-2 pb-4">
        ${H.filterChip("All statuses", rows.length, !filtered,
          { "data-action": "filter-ticket-status", "data-status": "all" })}
        ${this.statusOptions(rows).map((o) => H.filterChip(o.label, o.count, o.on,
          { "data-action": "filter-ticket-status", "data-status": o.label })).join("")}
      </div>

      ${H.table(
        H.th("Ticket") + H.th("Title") + H.th("Status") + H.th("Account / environment") +
        H.th("Repositories") + H.th("Assignees") + H.th("Start") + H.th("End"),
        shown.map((r) => this.row(r)),
        filtered
          ? `No active ticket is at ${this.statusFilter} — pick another status, or All statuses.`
          : "Nothing is tracked yet — run a sync, or check Not tracked for tickets that could not be matched."
      )}

      ${occupying.length ? `
        <p class="pt-4 text-center text-[11px] text-faint">
          A ticket holds its repositories while Jira has it at ${H.esc(occupying.join(", "))} —
          anything else frees up on the next sync.
        </p>` : ""}`);
  },

  // ---------- status filter ----------

  // The statuses actually in play, biggest group first. A selected status
  // stays listed even once a sync empties it: a chip that vanishes under
  // the pointer leaves the table looking broken rather than filtered.
  statusOptions(rows) {
    const byKey = new Map();
    const selected = this.statusFilter.toLowerCase();
    const add = (label, n) => {
      const key = label.toLowerCase();
      const entry = byKey.get(key) || { label, count: 0, on: key === selected };
      entry.count += n;
      byKey.set(key, entry);
    };
    rows.forEach(({ claim }) => add(this.statusOf(claim), 1));
    if (this.statusFilter !== "all") add(this.statusFilter, 0);
    return [...byKey.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  },

  // Jira reports statuses in its own casing and a manual claim may carry
  // none at all, so grouping and matching both go through here.
  statusOf(claim) {
    return (claim.status || "").trim() || "Unknown";
  },

  matches(claim) {
    return this.statusFilter === "all" ||
      this.statusOf(claim).toLowerCase() === this.statusFilter.toLowerCase();
  },

  // ---------- rows ----------

  row({ claim, server, env, accountName, minutesLeft }) {
    return H.tr(
      H.td(`<button data-action="open-ticket" data-ticket="${H.esc(claim.id)}"
              class="whitespace-nowrap text-xs font-bold text-brand-fg hover:underline">${H.esc(claim.id)}</button>
            ${claim.source === "manual" ? `<span class="ml-1 text-[10px] font-semibold text-faint">manual</span>` : ""}`) +
      H.td(`<span class="line-clamp-2 block max-w-[320px] text-sm text-body">${H.esc(claim.summary || claim.note || "—")}</span>`) +
      H.td(H.jiraChip(claim.status)) +
      H.td(`<p class="text-sm font-semibold">${H.esc(accountName)}</p>
            <p class="text-[11px] text-faint">${H.esc(claim.branch || env)}</p>`) +
      H.td(`<div class="flex gap-1">${claim.repos.map((r) => H.repoChip({
              name: r, url: (server.repos[r] || {}).url, state: "held",
              cls: "bg-amber-500/85 text-white"
            })).join("")}</div>`) +
      H.td(H.avatarStack(Model.peopleOf([claim]))) +
      H.td(this.when(claim.startTime, "Not set")) +
      H.td(`${this.when(claim.endTime, "Open-ended")}
            ${claim.endTime
              ? `<p class="text-[11px] font-semibold ${Model.isUrgent(minutesLeft) ? "text-warn" : "text-faint"}">${H.esc(Model.leftText(minutesLeft))}</p>`
              : ""}`)
    );
  },

  // A booking date, or why the row hasn't got one — a manual claim can be
  // open-ended, and a claim Jira raised mid-sync may have neither yet.
  when(iso, fallback) {
    return iso
      ? `<p class="whitespace-nowrap text-xs font-medium text-body">${H.esc(Format.formatDateTime(iso))}</p>`
      : `<p class="whitespace-nowrap text-xs italic text-faintest">${H.esc(fallback)}</p>`;
  }
});

/* The status chips above the table. Narrowing is view state, so this only
   re-renders — nothing is written back to State. */
Actions.on("filter-ticket-status", (el) => {
  Router.page("tickets").statusFilter = el.dataset.status;
  Router.render();
});
