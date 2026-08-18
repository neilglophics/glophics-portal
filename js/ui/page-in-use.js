/**
 * What is held, grouped by environment.
 *
 * A flat row per (claim × repository) repeated the environment, ticket and
 * holders on every line. The environment is the row; expanding it shows the
 * per-repository breakdown, which EnvDetail renders for both this page and
 * Environments.
 *
 * Soonest to free sorts first: the question here is "when can I have one?".
 */

const PAGE_ID = "in-use";

Router.register(PAGE_ID, {
  label: "In use",

  rows() {
    return Model.envRows()
      .filter((row) => row.claims.length)
      .map((row) => ({ row, minutes: row.soonest ? Model.minutesLeft(row.soonest) : null }))
      .sort((a, b) => (a.minutes === null ? Infinity : a.minutes) - (b.minutes === null ? Infinity : b.minutes));
  },

  expandableIds() { return this.rows().map(({ row }) => row.id); },

  render() {
    const rows = this.rows();
    const s = Model.summary();
    const repoCount = Model.claimRepoRows().length;
    const anyOpen = EnvDetail.openCount(PAGE_ID) > 0;

    return H.page(`
      ${H.pageHead("In use",
        rows.length
          ? `${repoCount} repositor${repoCount === 1 ? "y" : "ies"} held across ${rows.length} environment${rows.length === 1 ? "" : "s"}`
          : "Nothing is held right now",
        rows.length ? H.btn(anyOpen ? "Collapse all" : "Expand all", { data: { "data-action": "toggle-all-envs" } }) : "")}

      <section class="grid grid-cols-1 gap-4 pb-5 md:grid-cols-3">
        ${H.statTile("amber", "Repositories held", repoCount, `of ${s.repoTotal} total`, "clock")}
        ${H.statTile("brand", "People holding", s.people, "across all accounts", "check")}
        ${H.statTile("rose", "Freeing within 2h", s.soon, "plan the next booking", "alert")}
      </section>

      ${H.table(
        H.th("Environment") + H.th("Repositories") + H.th("Status") + H.th("Holders") +
        H.th("Tickets") + H.th("Frees in") + H.th(""),
        rows.map(({ row, minutes }) => this.envRow(row, minutes)),
        "Every repository is free."
      )}`);
  },

  envRow(row, minutes) {
    const token = Tokens.ENV_STATE[row.state];
    const open = EnvDetail.isOpen(PAGE_ID, row.id);
    const urgent = Model.isUrgent(minutes);

    const summary = H.tr(
      H.td(`<div class="flex items-center gap-3">
              ${EnvDetail.caret(open)}
              <span class="h-7 w-1 shrink-0 rounded-full ${token.dot}"></span>
              <div class="min-w-0">
                <p class="truncate text-sm font-bold">${H.esc(row.name)}</p>
                <p class="truncate text-[11px] text-slate-400">${H.esc(row.accountName)}</p>
              </div>
            </div>`) +
      H.td(H.repoStrip(row)) +
      H.td(H.dotChip(token)) +
      H.td(H.avatarStack(row.people)) +
      H.td(row.ticketIds.length === 1
        ? `<span class="text-xs font-semibold text-brand-600">${H.esc(row.ticketIds[0])}</span>`
        : `<span class="text-xs font-semibold text-slate-600">${row.ticketIds.length} tickets</span>`) +
      H.td(`<p class="text-sm font-semibold ${urgent ? "text-amber-600" : "text-slate-600"}">${H.esc(Model.leftText(minutes))}</p>
            ${row.soonest ? `<div class="mt-1.5 w-20">${H.bar(Model.progress(row.soonest), urgent ? "bg-amber-500" : "bg-brand-500")}</div>` : ""}`) +
      H.td(H.btn("Force free", { variant: "danger", size: "sm",
        data: { "data-action": "force-free-server", "data-id": row.id } }), "text-right"),
      { "data-action": "toggle-env", "data-id": row.id },
      "cursor-pointer"
    );

    return open ? summary + EnvDetail.detailRow(row, 7) : summary;
  }
});
