/**
 * Tickets Jira returned at an occupying status that could not be matched to
 * an environment. Each row has a different cause and a different fix, which
 * is why this earns a page rather than a line in the sync bar: an unmatched
 * ticket means the board says "free" while someone is actually working.
 */

Router.register("not-tracked", {
  label: "Not tracked",

  // The server writes a sentence, not a code. Classifying it here keeps the
  // fix column useful without the API having to grow a taxonomy.
  classify(reason) {
    const r = String(reason || "").toLowerCase();
    if (r.includes("no account")) return "account";
    if (r.includes("no environment")) return "environment";
    if (r.includes("repository")) return "ticket";
    if (r.includes("branch")) return "environment";
    return "other";
  },

  FIX: {
    account:     { label: "Add the account",     hint: "Settings → Directories → Accounts", chip: "bg-brand-soft text-brand-fg" },
    environment: { label: "Add the environment", hint: "Settings → Directories → Servers",  chip: "bg-brand-soft text-brand-fg" },
    ticket:      { label: "Fix the ticket",      hint: "In Jira",                           chip: "bg-warn-soft text-warn" },
    other:       { label: "Review",              hint: "Check the ticket fields",           chip: "bg-subtle-2 text-muted" }
  },

  render() {
    const skipped = State.getSkippedTickets();
    const jira = State.getSettings().jira;
    const counts = {};
    skipped.forEach((s) => {
      const kind = this.classify(s.reason);
      counts[kind] = (counts[kind] || 0) + 1;
    });

    if (!jira.enabled) {
      return H.page(`
        ${H.pageHead("Not tracked", "Jira is off, so nothing is being matched", "")}
        ${H.empty("Turn Jira on in Settings to see tickets that could not be matched to an environment.")}`);
    }

    return H.page(`
      ${H.pageHead("Not tracked",
        skipped.length
          ? `${skipped.length} ticket${skipped.length === 1 ? " is" : "s are"} at an occupying status but matched no environment`
          : "Every ticket at an occupying status matched an environment",
        H.btn("Re-run match", { data: { "data-action": "sync-jira" } }))}

      <div class="mb-5 flex items-start gap-3 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
        <span class="mt-0.5 shrink-0 text-faint">${H.icon("alert", "h-5 w-5")}</span>
        <p class="text-xs leading-relaxed text-muted">
          Matching needs <strong class="font-semibold text-ink-2">Account Name</strong>,
          <strong class="font-semibold text-ink-2">Branch</strong>,
          <strong class="font-semibold text-ink-2">Repository</strong> and
          <strong class="font-semibold text-ink-2">Status</strong> all filled in on the ticket.
          Anything listed here holds no repository, so its environment still reads as free.
        </p>
      </div>

      ${skipped.length ? `
      <section class="grid grid-cols-1 gap-4 pb-5 md:grid-cols-3">
        ${H.statTile("brand", "Unknown account", counts.account || 0, "add it in Settings", "plug")}
        ${H.statTile("brand", "Unknown branch", counts.environment || 0, "add the environment", "plug")}
        ${H.statTile("warn", "Incomplete ticket", counts.ticket || 0, "fix the ticket in Jira", "alert")}
      </section>` : ""}

      ${H.table(
        H.th("Ticket") + H.th("Jira status") + H.th("Account name") + H.th("Branch") +
        H.th("Why it was skipped") + H.th("Fix", "text-right"),
        skipped.map((s) => this.row(s)),
        "Nothing was skipped on the last sync."
      )}`);
  },

  row(s) {
    const fix = this.FIX[this.classify(s.reason)];
    return H.tr(
      H.td(`<button data-action="open-ticket" data-ticket="${H.esc(s.key)}"
              class="text-xs font-bold text-brand-fg hover:underline">${H.esc(s.key)}</button>`) +
      H.td(H.jiraChip(s.status)) +
      H.td(`<span class="text-sm font-semibold">${H.esc(s.accountName || "—")}</span>`) +
      H.td(`<span class="text-xs font-medium text-muted">${H.esc(s.branch || "—")}</span>`) +
      H.td(`<span class="text-sm text-body">${H.esc(s.reason)}</span>`) +
      H.td(`<div class="flex flex-col items-end gap-1">
              ${H.chip(fix.chip, fix.label)}
              <span class="text-[10px] text-faint">${H.esc(fix.hint)}</span>
            </div>`, "text-right")
    );
  }
});
