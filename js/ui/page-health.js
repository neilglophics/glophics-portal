/**
 * Reachability of every repository URL. Failures sort to the top — a health
 * page whose two broken endpoints sit twenty rows down is not doing its job.
 */

Router.register("health", {
  label: "Server health",

  render() {
    const rows = Model.repoRows();
    const s = Model.summary();
    const offline = rows.filter((r) => r.health === "offline");
    const interval = State.getSettings().jira.pollIntervalMinutes || 1;

    return H.page(`
      ${H.pageHead("Server health",
        `${rows.length} repository endpoint${rows.length === 1 ? "" : "s"} · problems listed first`,
        H.btn("Recheck all", { data: { "data-action": "check-health" } }))}

      <section class="grid grid-cols-1 gap-4 pb-5 md:grid-cols-3">
        ${H.statTile("ok", "Responding", s.repoOnline, `of ${s.repoTotal} endpoints`, "check")}
        ${H.statTile("bad", "Unreachable", s.repoOffline, "needs attention", "alert")}
        ${H.statTile("neutral", "No URL set", s.repoUnconfigured, "never checked", "plug")}
      </section>

      ${offline.length ? H.notice("bad",
        `${offline.length} endpoint${offline.length === 1 ? "" : "s"} not responding`,
        `${offline.map((r) => `${H.esc(r.accountName)} ${H.esc(r.env)} · ${H.esc(r.repo)}`).join(" — ")}.
         Their environments read as <strong>Server down</strong> until a check succeeds.`) : ""}

      ${H.table(
        H.th("Endpoint") + H.th("Environment") + H.th("Repository") + H.th("State") +
        H.th("Held by") + H.th("Note") + H.th(""),
        rows.map((r) => this.row(r)),
        "No repositories configured yet."
      )}

      <p class="pt-4 text-center text-[11px] text-faint">
        Checked automatically about every ${interval} minute${interval === 1 ? "" : "s"} while the server is running.
      </p>`);
  },

  row(r) {
    const token = Tokens.HEALTH[r.health] || Tokens.HEALTH.checking;
    return H.tr(
      H.td(r.url
        ? `<a href="${H.esc(r.url)}" target="_blank" rel="noopener"
             class="text-xs font-medium text-body hover:text-brand-fg hover:underline">${H.esc(r.url.replace(/^https?:\/\//, ""))}</a>`
        : `<span class="text-xs italic text-faintest">no URL configured</span>`) +
      H.td(`<p class="text-sm font-semibold">${H.esc(r.env)}</p>
            <p class="text-[11px] text-faint">${H.esc(r.accountName)}</p>`) +
      H.td(`<span class="text-xs font-semibold capitalize text-muted">${H.esc(r.repo)}</span>`) +
      H.td(H.dotChip(token)) +
      H.td(r.claims.length
        ? H.avatarStack(Model.peopleOf(r.claims))
        : `<span class="text-xs text-faintest">free</span>`) +
      H.td(r.note
        ? `<span title="${H.esc(r.note)}" class="line-clamp-1 block max-w-[220px] text-xs text-muted">${H.esc(r.note)}</span>`
        : `<span class="text-xs text-faintest">—</span>`) +
      H.td(`<div class="flex justify-end gap-2">
              ${H.iconBtn("note", r.note ? "Edit note" : "Add note", { "data-action": "edit-note", "data-id": r.serverId, "data-repo": r.repo })}
              ${r.url
                ? H.iconBtn("copy", "Copy URL", { "data-action": "copy-url", "data-url": r.url })
                : H.iconBtn("plug", "Set URL", { "data-action": "set-repo-url", "data-id": r.serverId, "data-repo": r.repo })}
              ${r.url ? H.iconBtn("external", "Open", { "data-action": "open-url", "data-url": r.url }) : ""}
            </div>`, "text-right")
    );
  }
});

Actions.on("open-url", (el) => window.open(el.dataset.url, "_blank", "noopener"));
