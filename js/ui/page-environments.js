/** Every environment, its repositories, who holds it and until when. */

Router.register("environments", {
  label: "Environments",

  render() {
    const all = Model.envRows();
    const rows = Model.filteredEnvRows();
    const filters = State.getFilters();
    const counts = { free: 0, partial: 0, inuse: 0, issue: 0 };
    all.forEach((r) => counts[r.state]++);
    const filtered = rows.length !== all.length;

    const statusChip = (key, label, count) => {
      const on = filters.status === key;
      return `<button data-action="filter-status" data-status="${key}"
        class="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-semibold transition ${
          on ? "bg-slate-900 text-white" : "bg-white text-slate-500 ring-1 ring-slate-200 hover:text-slate-800"}">
        ${key === "all" ? "" : `<span class="h-1.5 w-1.5 rounded-full ${Tokens.ENV_STATE[key].dot}"></span>`}${H.esc(label)} ${count}</button>`;
    };

    return H.page(`
      ${H.pageHead("Environments",
        `${all.length} environment${all.length === 1 ? "" : "s"} across ${State.getAccounts().length} account${State.getAccounts().length === 1 ? "" : "s"}`,
        H.btn("Add environment", { variant: "dark", data: { "data-action": "goto-settings" } }))}

      <div class="flex flex-wrap items-center gap-2 pb-5">
        ${statusChip("all", "All", all.length)}
        ${Object.keys(counts).map((k) => statusChip(k, Tokens.ENV_STATE[k].label, counts[k])).join("")}
        ${filtered ? `<button data-action="clear-filters"
            class="ml-1 text-[11px] font-semibold text-brand-600 hover:underline">Clear filters</button>` : ""}
      </div>

      ${H.table(
        H.th("Environment") + H.th("Repositories") + H.th("Status") + H.th("Assigned to") +
        H.th("Ticket") + H.th("Booked until") + H.th(""),
        rows.map((row) => this.row(row)),
        filtered ? "No environment matches these filters." : "No environments configured yet — add one in Settings."
      )}`);
  },

  row(row) {
    const token = Tokens.ENV_STATE[row.state];
    const minutes = row.soonest ? Model.minutesLeft(row.soonest) : null;

    return H.tr(
      H.td(`<div class="flex items-center gap-3">
              <span class="h-7 w-1 shrink-0 rounded-full ${token.dot}"></span>
              <div class="min-w-0">
                <p class="truncate text-sm font-bold">${H.esc(row.name)}</p>
                <p class="truncate text-[11px] text-slate-400">${H.esc(row.accountName)}</p>
              </div>
            </div>`) +
      H.td(H.repoStrip(row)) +
      H.td(H.dotChip(token)) +
      H.td(row.people.length ? H.avatarStack(row.people) : H.dash) +
      H.td(row.ticketIds.length
        ? `<button data-action="open-ticket" data-ticket="${H.esc(row.ticketIds[0])}"
             class="text-xs font-semibold text-brand-600 hover:underline">${H.esc(row.ticketIds[0])}</button>` +
          (row.ticketIds.length > 1 ? `<span class="ml-1 text-[11px] text-slate-400">+${row.ticketIds.length - 1}</span>` : "")
        : H.dash) +
      H.td(row.soonest
        ? `<p class="text-sm ${Model.isUrgent(minutes) ? "font-semibold text-amber-600" : "text-slate-600"}">${H.esc(Model.leftText(minutes))}</p>
           <div class="mt-1.5 w-24">${H.bar(Model.progress(row.soonest), token.bar)}</div>`
        : row.claims.length
          ? `<span class="text-xs text-slate-400">No end time</span>`
          : `<span class="text-sm font-medium text-emerald-600">Ready to book</span>`) +
      H.td(row.freeRepos.length
        ? H.btn("Assign", { variant: "dark", size: "sm", data: { "data-action": "assign", "data-id": row.id } })
        : H.btn("Force free", { variant: "danger", size: "sm", data: { "data-action": "force-free-server", "data-id": row.id } }),
        "text-right")
    );
  }
});

Actions.on("goto-settings", () => Router.go("settings"));
