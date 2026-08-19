/**
 * Every ticket the last sync saw, one row each — cut by Jira status, and
 * opening on the ones actually holding a repository.
 *
 * This is the page the overview links into: the Dashboard shows the five
 * freeing up first, and anyone who wants "who has what, and until when?"
 * comes here. Soonest to free sorts first, the order In use uses too.
 *
 * It opens on "Holding a repo" because that is the question the page was
 * built for; the rest of the board is one chip away, at whatever status
 * Jira has it at. The table and its chips are TicketTable, shared with My
 * tickets — the difference between the two pages is only which tickets
 * each hands over, and that this one names who is on them.
 */

Router.register("tickets", {
  label: "Active tickets",

  // Which cut the table is on — "holding", "all", or a status label. View
  // state, not app data: it lives on the page object so a repaint (a sync
  // landing, someone else booking) leaves the filter where the reader put
  // it instead of snapping it back.
  statusFilter: "holding",

  setStatusFilter(value) { this.statusFilter = value; },

  // Every ticket the board knows about. Named so the shared chip row can
  // ask a page what it is listing without knowing which page it is.
  ticketRows() { return Model.ticketRows(); },

  render() {
    const rows = this.ticketRows();
    const shown = TicketTable.filter(rows, this.statusFilter);
    const holding = rows.filter((r) => r.holding);
    const s = Model.summary();
    const envCount = new Set(holding.map((r) => r.server.id)).size;

    return H.page(`
      ${H.pageHead("Active tickets", this.subtitle(rows, shown, holding),
        H.btn("Sync now", { data: { "data-action": "sync-jira" } }))}

      <section class="grid grid-cols-1 gap-4 pb-5 sm:grid-cols-2 xl:grid-cols-4">
        ${H.statTile("info", "Holding a repo", holding.length,
          `across ${envCount} environment${envCount === 1 ? "" : "s"}`, "list")}
        ${H.statTile("brand", "On the board", rows.length, "every status the sync saw", "grid")}
        ${H.statTile("alt", "People holding", s.people, "across all accounts", "users")}
        ${H.statTile("neutral", "Not tracked", s.skipped, "could not be matched", "alert")}
      </section>

      ${TicketTable.chips(rows, this.statusFilter)}

      ${TicketTable.table(shown, {
        assignees: true,
        empty: this.emptyMessage(rows)
      })}

      ${TicketTable.statusNote()}`);
  },

  subtitle(rows, shown, holding) {
    if (!rows.length) return "Nothing has been synced yet";
    if (this.statusFilter === "holding") {
      return holding.length
        ? `${holding.length} ticket${holding.length === 1 ? " is" : "s are"} holding a repository right now`
        : "No ticket is holding a repository";
    }
    if (this.statusFilter === "all") {
      return `${rows.length} ticket${rows.length === 1 ? "" : "s"} on the board`;
    }
    return `${shown.length} of ${rows.length} shown · ${H.esc(this.statusFilter)}`;
  },

  emptyMessage(rows) {
    if (!rows.length) {
      return "Nothing is tracked yet — run a sync, or check Not tracked for tickets that could not be matched.";
    }
    if (this.statusFilter === "holding") {
      return "No ticket is holding a repository right now — every environment is free.";
    }
    return `No ticket is at ${this.statusFilter} — pick another status, or All statuses.`;
  }
});
