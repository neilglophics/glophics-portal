/**
 * My tickets — what the signed-in person is holding, found through the Jira
 * assignee name on their sign-in account.
 *
 * The row here is an *account*, not a name scraped off a ticket: everyone
 * has their own login, that login carries the "Ticket Assignee" name Jira
 * writes for them (Users → Edit), and this page turns that into "these are
 * mine". Matching goes through the name rather than the account's display
 * name, because the label on the ticket is the only thing both sides share.
 *
 * Who you can see depends on your role, which is also who you may ask for:
 * listing every account needs `manage-users`, so a member is shown their
 * own — already in hand from /api/auth/me — and never makes a request that
 * would be refused. A super admin gets every account and can pick one.
 */

const ASSIGNEE_PAGE = "assignees";

Router.register(ASSIGNEE_PAGE, (() => {

  // Sign-in accounts, for the roles allowed to list them. Server-side data,
  // so it is fetched once per visit rather than coming from State.
  let accounts = [];
  let loaded = false;
  let loading = false;

  // Which account the table is cut to — "me", "all", or one account id.
  let filter = "me";

  const canListAll = () => Auth.can("manage-users");
  const isLoading = () => canListAll() && !loaded;

  function reload() {
    if (!canListAll() || loading) return;
    loading = true;
    Auth.listUsers()
      .then((list) => { accounts = list; })
      .catch(() => { accounts = []; })
      .then(() => { loaded = true; loading = false; Router.render(); });
  }

  // Everyone else sees exactly one account: their own.
  function sourceAccounts() {
    if (canListAll()) return accounts;
    const me = Auth.user();
    return me ? [me] : [];
  }

  // ---------- rows ----------

  function rows() {
    const meId = (Auth.user() || {}).id;
    return sourceAccounts().map((account) => {
      const jiraNames = account.jiraNames || [];
      const claims = Model.claimsForNames(jiraNames);
      const ends = claims.map((c) => c.minutesLeft).filter((m) => m !== null);
      return {
        account, key: account.id,
        name: account.displayName,
        username: account.username,
        role: account.role,
        jiraNames,
        linked: jiraNames.length > 0,
        mine: account.id === meId,
        claims,
        tickets: claims.length,
        repos: claims.reduce((n, c) => n + c.claim.repos.length, 0),
        envs: new Set(claims.map((c) => c.server.id)).size,
        soonest: ends.length ? Math.min(...ends) : null
      };
    // Your own account first — the page is about you before it is about
    // whoever is busiest.
    }).sort((a, b) =>
      (b.mine ? 1 : 0) - (a.mine ? 1 : 0) ||
      b.tickets - a.tickets ||
      a.name.localeCompare(b.name));
  }

  // An unlinked account has no "mine" to show, so a super admin falls back
  // to the whole board rather than staring at an empty table. For everyone
  // else "everyone" *is* their own row, so they stay on it — their row says
  // "Not linked", which is the thing they need to see.
  function mode(all) {
    const me = all.find((r) => r.mine);
    return (filter === "me" && canListAll() && !(me && me.linked)) ? "all" : filter;
  }

  function shown(all, current) {
    if (current === "all") return all;
    if (current === "me") return all.filter((r) => r.mine);
    return all.filter((r) => r.key === current);
  }

  /**
   * Names that are on tickets but that no account answers to. Whoever they
   * are, they cannot open this page and find their own work — so for a
   * super admin this is the list of accounts still to link.
   */
  function uncovered(all) {
    const covered = new Set();
    all.forEach((r) => r.jiraNames.forEach((n) => covered.add(n.trim().toLowerCase())));
    return Model.assigneeRows()
      .filter((r) => r.tickets && !r.jiraNames.some((n) => covered.has(n.trim().toLowerCase())))
      .map((r) => ({ name: r.name, tickets: r.tickets }));
  }

  // ---------- notices ----------

  function linkNotice(all, me) {
    if (me && me.linked) return "";
    return H.notice("info", "Your sign-in has no Jira assignee name yet",
      `Until it does, this page cannot tell which tickets are yours. ${Auth.can("manage-users")
        ? `Set it on your account under <strong>Users → Edit</strong> — the field lists every name already on the board.`
        : `Ask a super admin to add it to your account under Users → Edit.`}`);
  }

  function coverageNotice(all) {
    if (!canListAll()) return "";
    const missing = uncovered(all);
    if (!missing.length) return "";
    const tickets = missing.reduce((n, m) => n + m.tickets, 0);
    return H.notice("warn",
      `${tickets} ticket${tickets === 1 ? " is" : "s are"} assigned to ${missing.length} name${missing.length === 1 ? "" : "s"} no account uses`,
      `${missing.slice(0, 8).map((m) => `<strong>${H.esc(m.name)}</strong> (${m.tickets})`).join(" · ")}${
        missing.length > 8 ? ` and ${missing.length - 8} more` : ""}.
       Put each name in the <strong>Jira assignee name</strong> field of that person's sign-in
       account and they will see their own tickets here.`);
  }

  // ---------- rendering ----------

  function title(current, list) {
    if (current === "me") return "My tickets";
    if (current === "all") return "Everyone's tickets";
    return list.length ? `${list[0].name}'s tickets` : "Tickets";
  }

  function subtitle(current, list) {
    const total = list.reduce((n, r) => n + r.tickets, 0);
    if (current === "me") {
      return total
        ? `${total} ticket${total === 1 ? " is" : "s are"} assigned to you right now`
        : "Nothing is assigned to you right now";
    }
    if (current === "all") {
      const holding = list.filter((r) => r.tickets).length;
      return holding
        ? `${holding} account${holding === 1 ? "" : "s"} holding ${total} ticket${total === 1 ? "" : "s"}`
        : "No account is holding a ticket";
    }
    const row = list[0];
    if (!row) return "No such account";
    return row.linked
      ? `${row.tickets} ticket${row.tickets === 1 ? "" : "s"} · ${row.jiraNames.join(", ")}`
      : "No Jira assignee name on this account yet";
  }

  function personRow(row, forceOpen) {
    // Picking an account is itself a request to see its tickets, so that
    // row opens without a second click.
    const open = row.tickets > 0 && (forceOpen || EnvDetail.isOpen(ASSIGNEE_PAGE, row.key));
    const idle = !row.tickets;
    const person = { id: row.key, name: row.name };

    const summary = H.tr(
      H.td(`<div class="flex items-center gap-3">
              ${idle ? `<span class="h-5 w-5 shrink-0"></span>` : EnvDetail.caret(open)}
              ${H.avatar(person, "h-9 w-9")}
              <div class="min-w-0">
                <p class="flex items-center gap-2 truncate text-sm font-bold">
                  ${H.esc(row.name)}
                  ${row.mine ? `<span class="rounded-md bg-brand-soft px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-brand-fg">YOU</span>` : ""}
                </p>
                <p class="truncate text-[11px] text-faint">@${H.esc(row.username)}</p>
              </div>
            </div>`) +
      H.td(row.linked
        ? `<div class="flex flex-wrap gap-1">${row.jiraNames.map((n) => H.chip("bg-subtle-2 text-muted", n)).join("")}</div>`
        : Auth.can("manage-users")
          // Straight to the page that owns credentials rather than opening
          // its dialog from here — that page loads the list this needs.
          ? `<a href="#users" class="text-[11px] font-semibold text-warn hover:underline">Not linked — set it</a>`
          : `<span class="text-[11px] font-semibold text-warn">Not linked</span>`) +
      H.td(H.chip(Tokens.roleChip(row.role), roleLabel(row.role))) +
      H.td(`<span class="text-sm font-bold ${idle ? "text-faintest" : "text-body"}">${row.tickets}</span>`) +
      H.td(`<span class="text-sm ${idle ? "text-faintest" : "text-body"}">${row.repos}</span>`) +
      H.td(`<span class="text-sm ${idle ? "text-faintest" : "text-body"}">${row.envs}</span>`) +
      H.td(`<span class="text-sm font-semibold ${
        Model.isUrgent(row.soonest) ? "text-warn" : idle ? "text-faintest" : "text-muted"}">${
        H.esc(idle ? "—" : Model.leftText(row.soonest))}</span>`),
      idle ? undefined : { "data-action": "toggle-env", "data-id": row.key },
      idle ? "" : "cursor-pointer"
    );

    if (!open) return summary;

    return summary + `
      <tr class="bg-subtle/60">
        <td colspan="7" class="px-5 pb-5 pt-1">
          <div class="ml-8 space-y-2">${row.claims.map(ticketBlock).join("")}</div>
        </td>
      </tr>`;
  }

  function ticketBlock({ claim, server, env, accountName, minutesLeft }) {
    const urgent = Model.isUrgent(minutesLeft);
    return `<div class="flex flex-wrap items-center gap-3 rounded-xl bg-surface px-3 py-2.5 ring-1 ring-line">
      <button data-action="open-ticket" data-ticket="${H.esc(claim.id)}"
        class="w-24 shrink-0 text-left text-xs font-bold text-brand-fg hover:underline">${H.esc(claim.id)}</button>
      <div class="w-36 shrink-0">${H.jiraChip(claim.status)}</div>

      <div class="min-w-[220px] flex-1">
        <p class="truncate text-xs font-medium text-body">${H.esc(claim.summary || claim.note || "—")}</p>
        <p class="truncate text-[10px] text-faint">${H.esc(accountName)} · ${H.esc(claim.branch || env)}</p>
      </div>

      <div class="w-28 shrink-0">
        <div class="flex gap-1">${claim.repos.map((r) => H.repoChip({
          name: r, url: (server.repos[r] || {}).url, state: "held",
          cls: "bg-amber-500/85 text-white"
        })).join("")}</div>
      </div>

      <div class="w-44 shrink-0 text-[10px] leading-relaxed text-faint">
        <p>Start ${H.esc(claim.startTime ? Format.formatDateTime(claim.startTime) : "not set")}</p>
        <p>End ${H.esc(claim.endTime ? Format.formatDateTime(claim.endTime) : "open-ended")}</p>
      </div>

      <span class="w-16 shrink-0 text-xs font-semibold ${urgent ? "text-warn" : "text-muted"}">${H.esc(Model.leftText(minutesLeft))}</span>
    </div>`;
  }

  return {
    label: "My tickets",

    // Only rows with something on them have a detail worth opening.
    expandableIds() { return rows().filter((r) => r.tickets).map((r) => r.key); },

    render() {
      if (isLoading()) {
        return H.page(H.pageHead("My tickets", "", "") + H.empty("Loading accounts…"));
      }

      const all = rows();
      const current = mode(all);
      const list = shown(all, current);
      const me = all.find((r) => r.mine);
      const anyOpen = EnvDetail.openCount(ASSIGNEE_PAGE) > 0;
      const s = Model.summary();
      const linkedCount = all.filter((r) => r.linked).length;

      return H.page(`
        ${H.pageHead(title(current, list), subtitle(current, list),
          (current === "all" && all.some((r) => r.tickets)
            ? H.btn(anyOpen ? "Collapse all" : "Expand all", { data: { "data-action": "toggle-all-envs" } })
            : "") +
          H.btn("Sync now", { data: { "data-action": "sync-jira" } }))}

        <section class="grid grid-cols-1 gap-4 pb-5 md:grid-cols-3">
          ${H.statTile(me && me.tickets ? "brand" : "ok", "Assigned to you", me ? me.tickets : 0,
            me && me.linked ? me.jiraNames.join(", ") : "no Jira name set", "check")}
          ${H.statTile("info", "Tickets on the board", s.claims, "held across every account", "list")}
          ${canListAll()
            ? H.statTile("alt", "Accounts linked", linkedCount, `of ${all.length} sign-in accounts`, "users")
            : H.statTile("warn", "Freeing within 2h", s.soon, "plan the next booking", "clock")}
        </section>

        ${linkNotice(all, me)}
        ${coverageNotice(all)}

        ${canListAll() && all.length > 1 ? `
          <div class="flex flex-wrap gap-2 pb-4">
            ${me && me.linked ? H.filterChip("Mine", me.tickets, current === "me",
              { "data-action": "filter-assignee", "data-key": "me" }) : ""}
            ${H.filterChip("Everyone", all.reduce((n, r) => n + r.tickets, 0), current === "all",
              { "data-action": "filter-assignee", "data-key": "all" })}
            ${all.filter((r) => !r.mine).map((r) => H.filterChip(r.name, r.tickets, r.key === current,
              { "data-action": "filter-assignee", "data-key": r.key })).join("")}
          </div>` : ""}

        ${H.table(
          H.th("Account") + H.th("Jira assignee name") + H.th("Role") + H.th("Tickets") +
          H.th("Repositories") + H.th("Environments") + H.th("Next free"),
          list.map((r) => personRow(r, current !== "all")),
          current === "me"
            ? "Nothing is assigned to you right now."
            : "No sign-in account to show."
        )}`);
    },

    // Accounts live server-side, so the first paint has no list yet.
    mount() { if (canListAll() && !loaded && !loading) reload(); },

    reload,
    setFilter(key) { filter = key; }
  };
})());

/* The account chips above the table. Narrowing is view state, so this only
   re-renders — nothing is written back to State. */
Actions.on("filter-assignee", (el) => {
  Router.page(ASSIGNEE_PAGE).setFilter(el.dataset.key);
  Router.render();
});
