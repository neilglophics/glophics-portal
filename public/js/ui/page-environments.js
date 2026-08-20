/**
 * Every environment, free or held. Clicking a row expands it into the
 * per-repository breakdown — which repos are free, and which ticket holds
 * each of the others — rendered by EnvDetail, the same component In use uses.
 */

Router.register("environments", {
  label: "Environments",

  expandableIds() { return Model.filteredEnvRows().map((row) => row.id); },

  render() {
    const all = Model.envRows();
    const rows = Model.filteredEnvRows();
    const filters = State.getFilters();
    const accounts = State.getAccounts();
    const members = State.getUsers().slice().sort((a, b) => a.name.localeCompare(b.name));
    const counts = { free: 0, partial: 0, inuse: 0, issue: 0 };
    all.forEach((r) => counts[r.state]++);
    const filtered = rows.length !== all.length;
    const signedInUserId = State.getSignedInUserId();
    const memberOptions = [
      { id: "all", label: "All members", count: all.length },
      ...(signedInUserId === "__me__" ? [{ id: "__me__", label: "You" }] : []),
      ...members.map((member) => ({ id: member.id, label: member.name }))
    ].map((option) => ({
      ...option,
      count: option.count ?? all.filter((row) => row.claims.some((claim) =>
        State.claimMatchesFilterUser(claim, option.id))).length
    }));
    const selectedUserIds = Array.isArray(filters.userId) ? filters.userId : [filters.userId];
    const allMembersSelected = selectedUserIds.includes("all");
    const selectedMemberOptions = memberOptions.filter((option) => selectedUserIds.includes(option.id));
    const selectedMemberServerCount = allMembersSelected ? all.length
      : all.filter((row) => row.claims.some((claim) => selectedUserIds.some((id) =>
        State.claimMatchesFilterUser(claim, id)))).length;
    const memberSelectionLabel = allMembersSelected ? "All members"
      : selectedMemberOptions.length === 1 ? selectedMemberOptions[0].label
        : `${selectedMemberOptions.length} members`;
    const anyOpen = EnvDetail.openCount("environments") > 0;

    const statusChip = (key, label, count) => {
      const on = (filters.status || "all") === key;
      return `<button data-action="filter-status" data-status="${key}"
        class="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-semibold transition ${
          on ? "bg-accent text-on-accent" : "bg-surface text-muted ring-1 ring-line-2 hover:text-ink"}">
        ${key === "all" ? "" : `<span class="h-1.5 w-1.5 rounded-full ${Tokens.ENV_STATE[key].dot}"></span>`}${H.esc(label)} ${count}</button>`;
    };

    return H.page(`
      ${H.pageHead("Environments",
        `${all.length} environment${all.length === 1 ? "" : "s"} across ${accounts.length} account${accounts.length === 1 ? "" : "s"}`,
        (rows.length ? H.btn(anyOpen ? "Collapse all" : "Expand all", { data: { "data-action": "toggle-all-envs" } }) : "") +
        H.btn("Add environment", { variant: "dark", data: { "data-action": "goto-settings" } }))}

      <div class="flex flex-wrap items-center gap-2 pb-5">
        ${statusChip("all", "All", all.length)}
        ${Object.keys(counts).map((k) => statusChip(k, Tokens.ENV_STATE[k].label, counts[k])).join("")}
        <details class="relative" ${signedInUserId ? "" : "disabled"}>
          <summary class="flex cursor-pointer list-none items-center gap-2 rounded-xl bg-surface px-3.5 py-2 text-[11px] font-semibold text-muted ring-1 ring-line-2 transition hover:text-ink">
            <span class="text-faint">Member</span>
            <span class="max-w-36 truncate text-ink-2">${H.esc(memberSelectionLabel)}</span>
            <span class="rounded-full bg-subtle-2 px-1.5 py-0.5 text-[10px] text-faint">${selectedMemberServerCount}</span>
            ${H.icon("chevron", "h-3 w-3 rotate-90")}
          </summary>
          <div class="absolute left-0 z-20 mt-2 min-w-64 overflow-hidden rounded-xl bg-surface p-1.5 shadow-lg ring-1 ring-line-2">
            ${memberOptions.map(({ id, label, count }) => {
              const checked = allMembersSelected ? id === "all" : selectedUserIds.includes(id);
              return `<label class="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-ink-2 transition hover:bg-subtle">
                <input type="checkbox" name="member-filter" value="${H.esc(id)}" data-change="filter-user" ${checked ? "checked" : ""}
                  class="h-3.5 w-3.5 rounded accent-brand-500" />
                <span class="min-w-0 flex-1 truncate">${H.esc(label)}</span>
                <span class="text-[11px] text-faint">${count}</span>
              </label>`;
            }).join("")}
          </div>
        </details>
        ${filtered ? `<button data-action="clear-filters"
            class="ml-1 text-[11px] font-semibold text-brand-fg hover:underline">Clear filters</button>` : ""}
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
    const open = EnvDetail.isOpen("environments", row.id);

    const summary = H.tr(
      H.td(`<div class="flex items-center gap-3">
              ${EnvDetail.caret(open)}
              <span class="h-7 w-1 shrink-0 rounded-full ${token.dot}"></span>
              <div class="min-w-0">
                <p class="truncate text-sm font-bold">${H.esc(row.name)}</p>
                <p class="truncate text-[11px] text-faint">${H.esc(row.accountName)}</p>
              </div>
            </div>`) +
      H.td(H.repoStrip(row)) +
      H.td(H.dotChip(token)) +
      H.td(row.people.length ? H.avatarStack(row.people) : H.dash) +
      H.td(row.ticketIds.length
        ? `<button data-action="open-ticket" data-ticket="${H.esc(row.ticketIds[0])}"
             class="text-xs font-semibold text-brand-fg hover:underline">${H.esc(row.ticketIds[0])}</button>` +
          (row.ticketIds.length > 1 ? `<span class="ml-1 text-[11px] text-faint">+${row.ticketIds.length - 1}</span>` : "")
        : H.dash) +
      H.td(row.soonest
        ? `<p class="text-sm ${Model.isUrgent(minutes) ? "font-semibold text-warn" : "text-body"}">${H.esc(Model.leftText(minutes))}</p>
           <div class="mt-1.5 w-24">${H.bar(Model.progress(row.soonest), token.bar)}</div>`
        : row.claims.length
          ? `<span class="text-xs text-faint">No end time</span>`
          : `<span class="text-sm font-medium text-ok">Ready to book</span>`) +
      H.td(row.freeRepos.length
        ? H.btn("Assign", { variant: "dark", size: "sm", data: { "data-action": "assign", "data-id": row.id } })
        : H.btn("Force free", { variant: "danger", size: "sm", data: { "data-action": "force-free-server", "data-id": row.id } }),
        "text-right"),
      { "data-action": "toggle-env", "data-id": row.id },
      "cursor-pointer"
    );

    return open ? summary + EnvDetail.detailRow(row, 7) : summary;
  }
});

Actions.on("goto-settings", () => Router.go("settings"));
