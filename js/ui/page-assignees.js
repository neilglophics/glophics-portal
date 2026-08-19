/**
 * My tickets — the Active tickets table, cut to whoever is signed in.
 *
 * Which tickets are "mine" is decided by the Jira "Ticket Assignee" name
 * on the sign-in account (Users → Edit), not by the account's display
 * name: the label written on the ticket is the only thing both sides
 * share. That name arrives with /api/auth/me, so this page asks the server
 * for nothing beyond the board every other page already has — it paints on
 * the first frame, with no account list to wait for.
 *
 * Every ticket of yours, at every status, because "mine" does not stop at
 * the ones holding an environment — the cut is by status, same as Active
 * tickets, and it opens on all of them. Only ever your own, whatever your
 * role; everyone else's are one click away on Active tickets.
 */

Router.register("assignees", {
  label: "My tickets",

  // Which cut the table is on — "all", "holding", or a status label. View
  // state, not app data: it lives on the page object so a repaint (a sync
  // landing, someone else booking) leaves the filter where the reader put
  // it instead of snapping it back.
  statusFilter: "all",

  setStatusFilter(value) { this.statusFilter = value; },

  // Only ever this person's. Named so the shared chip row can ask a page
  // what it is listing without knowing which page it is.
  ticketRows() {
    const names = Auth.jiraNames();
    return names.length ? Model.ticketsForNames(names) : [];
  },

  render() {
    const names = Auth.jiraNames();
    const linked = names.length > 0;
    const rows = this.ticketRows();
    const shown = TicketTable.filter(rows, this.statusFilter);
    const holding = rows.filter((r) => r.holding);
    const envs = new Set(holding.map((r) => r.server.id)).size;
    const soon = holding.filter((r) => r.minutesLeft !== null && r.minutesLeft > 0 && r.minutesLeft < 120).length;

    return H.page(`
      ${H.pageHead("My tickets", this.subtitle(rows, shown, holding, linked),
        H.btn("Sync now", { data: { "data-action": "sync-jira" } }))}

      <section class="grid grid-cols-1 gap-4 pb-5 md:grid-cols-3">
        ${H.statTile(rows.length ? "brand" : "ok", "Assigned to you", rows.length,
          linked ? names.join(", ") : "no Jira name set", "check")}
        ${H.statTile("info", "Holding a repo", holding.length,
          `across ${envs} environment${envs === 1 ? "" : "s"}`, "list")}
        ${H.statTile(soon ? "warn" : "neutral", "Freeing within 2h", soon,
          soon ? "hand them back on time" : "nothing of yours is due", "clock")}
      </section>

      ${linked ? "" : this.linkNotice()}

      ${TicketTable.chips(rows, this.statusFilter)}

      ${TicketTable.table(shown, { empty: this.emptyMessage(rows, linked) })}

      ${rows.length ? TicketTable.statusNote() : ""}`);
  },

  subtitle(rows, shown, holding, linked) {
    if (!linked) return "No Jira assignee name on your sign-in yet";
    if (!rows.length) return "Nothing is assigned to you right now";
    if (this.statusFilter === "all") {
      return `${rows.length} ticket${rows.length === 1 ? " is" : "s are"} assigned to you right now`;
    }
    if (this.statusFilter === "holding") {
      return holding.length
        ? `${holding.length} of yours ${holding.length === 1 ? "is" : "are"} holding a repository`
        : "None of yours is holding a repository";
    }
    return `${shown.length} of ${rows.length} shown · ${H.esc(this.statusFilter)}`;
  },

  emptyMessage(rows, linked) {
    if (!linked) return "Once your sign-in carries a Jira assignee name, the tickets it is on show up here.";
    if (!rows.length) return "Nothing is assigned to you right now — check Active tickets for what the rest of the board is holding.";
    if (this.statusFilter === "holding") return "None of your tickets is holding a repository right now.";
    return `None of your tickets are at ${this.statusFilter} — pick another status, or All statuses.`;
  },

  // Nothing matches an empty name, so an unlinked sign-in sees an empty
  // table it cannot explain. Say why, and who can fix it.
  linkNotice() {
    return H.notice("info", "Your sign-in has no Jira assignee name yet",
      `Until it does, this page cannot tell which tickets are yours. ${Auth.can("manage-users")
        ? `Set it on your account under <strong>Users → Edit</strong> — the field lists every name already on the board.`
        : `Ask a super admin to add it to your account under <strong>Users → Edit</strong>.`}`);
  }
});
