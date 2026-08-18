/**
 * One row per repository actually held, soonest to free at the top — the
 * question people ask here is "when can I have one?".
 */

Router.register("in-use", {
  label: "In use",

  render() {
    const rows = Model.claimRepoRows();
    const s = Model.summary();
    const envCount = new Set(rows.map((r) => r.server.id)).size;

    return H.page(`
      ${H.pageHead("In use",
        rows.length
          ? `${rows.length} repositor${rows.length === 1 ? "y" : "ies"} held by ${s.claims} ticket${s.claims === 1 ? "" : "s"} across ${envCount} environment${envCount === 1 ? "" : "s"}`
          : "Nothing is held right now",
        "")}

      <section class="grid grid-cols-1 gap-4 pb-5 md:grid-cols-3">
        ${H.statTile("amber", "Repositories held", rows.length, `of ${s.repoTotal} total`, "clock")}
        ${H.statTile("brand", "People holding", s.people, "across all accounts", "check")}
        ${H.statTile("rose", "Freeing within 2h", s.soon, "plan the next booking", "alert")}
      </section>

      ${H.table(
        H.th("Repository") + H.th("Environment") + H.th("Ticket") + H.th("Jira status") +
        H.th("Holders") + H.th("Held since") + H.th("Frees in") + H.th(""),
        rows.map((r) => this.row(r)),
        "Every repository is free."
      )}`);
  },

  row({ claim, repo, env, accountName, minutesLeft }) {
    const urgent = Model.isUrgent(minutesLeft);
    return H.tr(
      H.td(`<div class="flex items-center gap-2.5">
              <span class="w-9 rounded-md bg-amber-500/85 py-0.5 text-center text-[9px] font-bold text-white">${H.esc(Tokens.shortRepo(repo))}</span>
              <span class="text-xs font-semibold capitalize text-slate-600">${H.esc(repo)}</span>
            </div>`) +
      H.td(`<p class="text-sm font-semibold">${H.esc(env)}</p>
            <p class="text-[11px] text-slate-400">${H.esc(accountName)}</p>`) +
      H.td(`<button data-action="open-ticket" data-ticket="${H.esc(claim.id)}"
              class="text-xs font-semibold text-brand-600 hover:underline">${H.esc(claim.id)}</button>
            <p class="max-w-[200px] truncate text-[11px] text-slate-400">${H.esc(claim.summary || claim.note || "")}</p>`) +
      H.td(H.jiraChip(claim.status)) +
      H.td(H.avatarStack(Model.peopleOf([claim]))) +
      H.td(`<span class="text-xs text-slate-500">${H.esc(claim.startTime ? Format.formatDateTime(claim.startTime) : "—")}</span>`) +
      H.td(`<p class="text-sm font-semibold ${urgent ? "text-amber-600" : "text-slate-600"}">${H.esc(Model.leftText(minutesLeft))}</p>
            ${claim.endTime ? `<div class="mt-1.5 w-20">${H.bar(Model.progress(claim), urgent ? "bg-amber-500" : "bg-brand-500")}</div>` : ""}`) +
      H.td(H.btn("Force free", { variant: "danger", size: "sm", data: { "data-action": "force-free-ticket", "data-ticket": claim.id } }), "text-right")
    );
  }
});
