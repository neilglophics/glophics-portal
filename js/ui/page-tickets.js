/** Every ticket currently holding a repository, one row each. */

Router.register("tickets", {
  label: "Tickets",

  render() {
    const rows = Model.claimRows();
    const s = Model.summary();
    const occupying = State.getSettings().jira.occupyingStatuses || [];
    const byStatus = {};
    rows.forEach(({ claim }) => {
      const key = (claim.status || "Unknown").toUpperCase();
      byStatus[key] = (byStatus[key] || 0) + 1;
    });
    const top = Object.keys(byStatus).sort((a, b) => byStatus[b] - byStatus[a]).slice(0, 2);

    return H.page(`
      ${H.pageHead("Tickets",
        rows.length
          ? `${rows.length} ticket${rows.length === 1 ? " is" : "s are"} holding a repository right now`
          : "No ticket is holding a repository",
        H.btn("Sync now", { data: { "data-action": "sync-jira" } }))}

      <section class="grid grid-cols-1 gap-4 pb-5 md:grid-cols-3">
        ${top[0] ? H.statTile("blue", this.titleCase(top[0]), byStatus[top[0]], "tickets occupying", "check")
                 : H.statTile("blue", "Occupying", 0, occupying.join(", ") || "no statuses set", "check")}
        ${top[1] ? H.statTile("violet", this.titleCase(top[1]), byStatus[top[1]], "tickets occupying", "check")
                 : H.statTile("violet", "People holding", s.people, "across all accounts", "check")}
        ${H.statTile("slate", "Not tracked", s.skipped, "could not be matched", "alert")}
      </section>

      ${H.table(
        H.th("Ticket") + H.th("Status") + H.th("Account / branch") + H.th("Repositories") +
        H.th("Assignees") + H.th("Summary") + H.th("Frees in", "text-right"),
        rows.map((r) => this.row(r)),
        "Nothing is tracked yet — run a sync, or check Not tracked for tickets that could not be matched."
      )}`);
  },

  titleCase(s) {
    return s.charAt(0) + s.slice(1).toLowerCase();
  },

  row({ claim, env, accountName, minutesLeft }) {
    return H.tr(
      H.td(`<button data-action="open-ticket" data-ticket="${H.esc(claim.id)}"
              class="text-xs font-bold text-brand-600 hover:underline">${H.esc(claim.id)}</button>
            ${claim.source === "manual" ? `<span class="ml-1 text-[10px] font-semibold text-slate-400">manual</span>` : ""}`) +
      H.td(H.jiraChip(claim.status)) +
      H.td(`<p class="text-sm font-semibold">${H.esc(accountName)}</p>
            <p class="text-[11px] text-slate-400">${H.esc(claim.branch || env)}</p>`) +
      H.td(`<div class="flex gap-1">${claim.repos.map((r) =>
              `<span class="w-9 rounded-md bg-amber-500/85 py-0.5 text-center text-[9px] font-bold text-white">${H.esc(Tokens.shortRepo(r))}</span>`).join("")}</div>`) +
      H.td(H.avatarStack(Model.peopleOf([claim]))) +
      H.td(`<span class="line-clamp-1 block max-w-[260px] text-sm text-slate-600">${H.esc(claim.summary || claim.note || "—")}</span>`) +
      H.td(`<span class="text-sm font-semibold ${Model.isUrgent(minutesLeft) ? "text-amber-600" : "text-slate-500"}">${H.esc(Model.leftText(minutesLeft))}</span>`, "text-right")
    );
  }
});
