/**
 * Reachability of every repository URL, grouped by environment.
 *
 * Flat, this was one row per endpoint: the environment repeated once per
 * repository, and 93 rows scrolled past to find the broken ones. Grouped,
 * the environment is the row and its endpoints are the detail.
 *
 * Environments with a problem sort first, and inside one, broken endpoints
 * sort above healthy ones — a health page that buries its failures is not
 * doing its job.
 *
 * The detail here is health-shaped (endpoint, state, note) rather than
 * claim-shaped, so it renders in this file. The open-state and caret come
 * from EnvDetail, so expanding behaves exactly as it does elsewhere.
 */

const HEALTH_PAGE = "health";

Router.register(HEALTH_PAGE, {
  label: "Server health",

  rows() {
    const RANK = { offline: 0, checking: 1, unconfigured: 2, online: 3 };
    return Model.envRows().map((row) => {
      const repos = row.repoNames.map((name) => {
        const repo = row.server.repos[name];
        return {
          name,
          url: repo.url || null,
          health: repo.health || (repo.url ? "checking" : "unconfigured"),
          claims: State.getRepoClaims(row.id, name),
          note: State.getRepoNote(row.id, name)
        };
      }).sort((a, b) => RANK[a.health] - RANK[b.health] || a.name.localeCompare(b.name));

      const count = (h) => repos.filter((r) => r.health === h).length;
      return {
        row, repos,
        offline: count("offline"),
        unconfigured: count("unconfigured"),
        online: count("online")
      };
    }).sort((a, b) =>
      (a.offline ? 0 : a.unconfigured ? 1 : 2) - (b.offline ? 0 : b.unconfigured ? 1 : 2) ||
      b.offline - a.offline ||
      a.row.accountName.localeCompare(b.row.accountName) ||
      a.row.name.localeCompare(b.row.name));
  },

  expandableIds() { return this.rows().map((r) => r.row.id); },

  render() {
    const rows = this.rows();
    const s = Model.summary();
    const broken = rows.filter((r) => r.offline);
    const interval = State.getSettings().jira.pollIntervalMinutes || 1;
    const anyOpen = EnvDetail.openCount(HEALTH_PAGE) > 0;

    return H.page(`
      ${H.pageHead("Server health",
        `${s.repoTotal} endpoint${s.repoTotal === 1 ? "" : "s"} across ${rows.length} environment${rows.length === 1 ? "" : "s"} · problems first`,
        (rows.length ? H.btn(anyOpen ? "Collapse all" : "Expand all", { data: { "data-action": "toggle-all-envs" } }) : "") +
        H.btn("Recheck all", { data: { "data-action": "check-health" } }))}

      <section class="grid grid-cols-1 gap-4 pb-5 md:grid-cols-3">
        ${H.statTile("ok", "Responding", s.repoOnline, `of ${s.repoTotal} endpoints`, "check")}
        ${H.statTile("bad", "Unreachable", s.repoOffline, "needs attention", "alert")}
        ${H.statTile("neutral", "No URL set", s.repoUnconfigured, "never checked", "plug")}
      </section>

      ${broken.length ? H.notice("bad",
        `${s.repoOffline} endpoint${s.repoOffline === 1 ? "" : "s"} not responding across ${broken.length} environment${broken.length === 1 ? "" : "s"}`,
        `${broken.slice(0, 6).map((r) =>
            `${H.esc(r.row.accountName)} ${H.esc(r.row.name)} <strong>(${r.offline})</strong>`).join(" · ")}${
            broken.length > 6 ? ` · and ${broken.length - 6} more` : ""}.
         Expand a row to see which endpoints.`) : ""}

      ${H.table(
        H.th("Environment") + H.th("Endpoints") + H.th("State") + H.th("Responding") +
        H.th("Held by") + H.th(""),
        rows.map((r) => this.envRow(r)),
        "No repositories configured yet."
      )}

      <p class="pt-4 text-center text-[11px] text-faint">
        Checked automatically about every ${interval} minute${interval === 1 ? "" : "s"} while the server is running.
      </p>`);
  },

  // Health-only strip: colour reflects reachability, never occupancy.
  strip(repos) {
    return `<div class="flex gap-1">` + repos.map((r) => {
      const cls = r.health === "offline" ? "bg-rose-500/85 text-white"
        : r.health === "unconfigured" ? "bg-line-2 text-muted"
        : r.health === "checking" ? "bg-faint text-white"
        : "bg-emerald-500/85 text-white";
      return H.repoChip({ name: r.name, url: r.url, cls, state: Tokens.HEALTH[r.health] ? Tokens.HEALTH[r.health].label.toLowerCase() : r.health });
    }).join("") + `</div>`;
  },

  envRow({ row, repos, offline, unconfigured, online }) {
    const open = EnvDetail.isOpen(HEALTH_PAGE, row.id);
    const token = offline
      ? { chip: "bg-bad-soft text-bad", dot: "bg-rose-500", label: `${offline} offline` }
      : unconfigured
        ? { chip: "bg-subtle-2 text-muted", dot: "bg-faintest", label: `${unconfigured} no URL` }
        : { chip: "bg-ok-soft text-ok", dot: "bg-emerald-500", label: "All responding" };
    const holders = Model.peopleOf(repos.flatMap((r) => r.claims));

    const summary = H.tr(
      H.td(`<div class="flex items-center gap-3">
              ${EnvDetail.caret(open)}
              <span class="h-7 w-1 shrink-0 rounded-full ${token.dot}"></span>
              <div class="min-w-0">
                <p class="truncate text-sm font-bold">${H.esc(row.name)}</p>
                <p class="truncate text-[11px] text-faint">${H.esc(row.accountName)}</p>
              </div>
            </div>`) +
      H.td(this.strip(repos)) +
      H.td(H.dotChip(token)) +
      H.td(`<span class="text-sm font-semibold ${offline ? "text-bad" : "text-body"}">${online}/${repos.length}</span>`) +
      H.td(holders.length ? H.avatarStack(holders) : `<span class="text-xs text-faintest">free</span>`) +
      H.td(H.btn("Recheck", { size: "sm", data: { "data-action": "check-health" } }), "text-right"),
      { "data-action": "toggle-env", "data-id": row.id },
      "cursor-pointer"
    );

    if (!open) return summary;

    return summary + `
      <tr class="bg-subtle/60">
        <td colspan="6" class="px-5 pb-5 pt-1">
          <div class="ml-8 space-y-2">${repos.map((r) => this.repoBlock(row, r)).join("")}</div>
        </td>
      </tr>`;
  },

  repoBlock(row, r) {
    const token = Tokens.HEALTH[r.health] || Tokens.HEALTH.checking;
    const chipCls = r.health === "offline" ? "bg-rose-500/85 text-white"
      : r.health === "unconfigured" ? "bg-line-2 text-muted"
      : r.health === "checking" ? "bg-faint text-white"
      : "bg-emerald-500/85 text-white";

    return `<div class="flex flex-wrap items-center gap-3 rounded-xl bg-surface px-3 py-2.5 ring-1 ring-line">
      <div class="flex w-40 shrink-0 items-center gap-2.5">
        ${H.repoChip({ name: r.name, url: r.url, cls: chipCls, state: token.label.toLowerCase() })}
        <span class="truncate text-xs font-semibold capitalize text-body">${H.esc(r.name)}</span>
      </div>

      <div class="min-w-[240px] flex-1">
        ${r.url
          ? `<a href="${H.esc(r.url)}" target="_blank" rel="noopener"
               class="text-xs font-medium text-body hover:text-brand-fg hover:underline">${H.esc(r.url.replace(/^https?:\/\//, ""))}</a>`
          : `<span class="text-xs italic text-faintest">no URL configured</span>`}
        ${r.note ? `<p class="truncate text-[10px] text-faint">${H.esc(r.note)}</p>` : ""}
      </div>

      <div class="w-32 shrink-0">${H.dotChip(token)}</div>

      <div class="w-28 shrink-0">
        ${r.claims.length
          ? H.avatarStack(Model.peopleOf(r.claims), 2)
          : `<span class="text-xs text-faintest">free</span>`}
      </div>

      <div class="flex shrink-0 gap-2">
        ${H.iconBtn("note", r.note ? "Edit note" : "Add note",
          { "data-action": "edit-note", "data-id": row.id, "data-repo": r.name })}
        ${r.url
          ? H.iconBtn("copy", "Copy URL", { "data-action": "copy-url", "data-url": r.url })
          : H.iconBtn("plug", "Set URL", { "data-action": "set-repo-url", "data-id": row.id, "data-repo": r.name })}
        ${r.url ? H.iconBtn("external", "Open", { "data-action": "open-url", "data-url": r.url }) : ""}
      </div>
    </div>`;
  }
});

Actions.on("open-url", (el) => window.open(el.dataset.url, "_blank", "noopener"));
