/** Overview of the pool: what's free, what's held, and what frees up next. */

Router.register("dashboard", {
  label: "Dashboard",

  PAGE_SIZE: 5,
  activePage: 0,
  updatesPage: 0,

  setActivePage(n) { this.activePage = n; },
  setUpdatesPage(n) { this.updatesPage = n; },

  // A page's worth of a longer list, plus the position within it — clamped,
  // so a page number kept from before a claim freed (the list got shorter)
  // still lands somewhere real instead of rendering empty.
  paged(items, page) {
    const totalPages = Math.max(1, Math.ceil(items.length / this.PAGE_SIZE));
    const current = Math.min(Math.max(0, page), totalPages - 1);
    const start = current * this.PAGE_SIZE;
    return { items: items.slice(start, start + this.PAGE_SIZE), page: current, totalPages };
  },

  // Prev/next, only when there's a second page to go to.
  pager(page, totalPages, action) {
    if (totalPages <= 1) return "";
    const navBtn = (dir, targetPage, disabled) => `
      <button type="button" data-action="${action}" data-page="${targetPage}" ${disabled ? "disabled" : ""}
        class="grid h-7 w-7 place-items-center rounded-full text-faint ring-1 ring-line-2 transition hover:bg-brand-soft hover:text-brand-fg hover:ring-brand-soft disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-faint">
        ${H.icon("chevron", `h-3 w-3 ${dir === "prev" ? "rotate-180" : ""}`)}
      </button>`;
    return `<div class="flex items-center justify-end gap-2 pt-3">
      ${navBtn("prev", page - 1, page === 0)}
      <span class="text-[11px] font-semibold text-faint">Page ${page + 1} of ${totalPages}</span>
      ${navBtn("next", page + 1, page >= totalPages - 1)}
    </div>`;
  },

  render() {
    const s = Model.summary();
    const held = Model.envRows()
      .filter((r) => r.state !== "free")
      .sort((a, b) => Model.minutesLeft(a.soonest || {}) - Model.minutesLeft(b.soonest || {}))
      .slice(0, 3);
    const active = this.paged(Model.claimRows(), this.activePage);
    const claims = active.items;
    const upd = this.paged(Model.latestJiraUpdates(Infinity), this.updatesPage);
    const updates = upd.items;

    return H.page(`
      <section class="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-500 to-brand-700 px-8 py-7 text-white">
        <svg class="pointer-events-none absolute -right-6 top-1/2 h-56 w-56 -translate-y-1/2 text-white/15" viewBox="0 0 100 100" fill="currentColor">
          <path d="M50 4c2 26 18 42 44 46-26 4-42 20-46 46-4-26-20-42-46-46 26-4 42-20 48-46z"/>
        </svg>
        <p class="text-[11px] font-bold tracking-[0.16em] text-white/70">ENVIRONMENT POOL</p>
        <h1 class="mt-2 max-w-lg text-[27px] font-bold leading-tight tracking-tight">
          ${s.free === 0 ? "Every environment is taken" : `${s.free} environment${s.free === 1 ? " is" : "s are"} free<br />and ready to book`}
        </h1>
        <p class="mt-2 max-w-md text-sm text-white/75">
          ${s.free === 0 ? "Free one up, or wait for the next booking to end." : "Claim one before your ticket reaches QA testing."}
        </p>
        <!-- text-on-accent is explicit: the section sets text-white, which would
             otherwise be inherited onto a button that goes light in dark mode. -->
        <a href="#environments" class="mt-5 inline-flex items-center gap-2.5 rounded-full bg-accent py-2.5 pl-5 pr-2.5 text-sm font-semibold text-on-accent transition hover:bg-accent-2">
          Browse environments
          <span class="grid h-6 w-6 place-items-center rounded-full bg-on-accent/15">${H.icon("chevron", "h-3 w-3")}</span>
        </a>
      </section>

      <section class="mt-5 grid grid-cols-2 gap-4 xl:grid-cols-4">
        ${H.statTile("ok", "Available now", s.free, `of ${s.total} environments`, "check")}
        ${H.statTile("warn", "In use", s.held, `${s.claims} active claim${s.claims === 1 ? "" : "s"}`, "clock")}
        ${H.statTile("bad", "Needs attention", s.issue, `${s.repoOffline} endpoint${s.repoOffline === 1 ? "" : "s"} offline`, "alert")}
        ${H.statTile("brand", "Freeing up soon", s.soon, "within 2 hours", "clock")}
      </section>

      <section class="mt-7">
        <div class="flex items-center justify-between">
          <h2 class="text-[17px] font-bold tracking-tight">Held right now</h2>
          <a href="#in-use" class="text-xs font-semibold text-brand-fg hover:underline">See all</a>
        </div>
        <div class="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          ${held.length ? held.map(this.card).join("") : H.empty("Nothing is held — every environment is free.")}
        </div>
      </section>

      <section class="mt-7 flex flex-col gap-5 xl:flex-row">
        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-end justify-between gap-3 pb-4">
            <div>
              <h2 class="text-[17px] font-bold tracking-tight">Active tickets</h2>
              <p class="mt-0.5 text-xs text-faint">
                ${s.claims} ticket${s.claims === 1 ? " is" : "s are"} holding a repository, soonest to free first
              </p>
            </div>
            <a href="#tickets" class="text-xs font-semibold text-brand-fg hover:underline">See all</a>
          </div>
          ${H.table(
            H.th("Holders") + H.th("Environment") + H.th("Ticket") + H.th("Status") + H.th("Summary") + H.th("Frees in", "text-right"),
            claims.map(({ claim, env, accountName, minutesLeft }) => {
              const subLine = `${accountName} · ${claim.repos.map(Tokens.shortRepo).join(", ")}`;
              const summaryText = claim.summary || claim.note || "—";
              return H.tr(
                H.td(H.avatarStack(Model.peopleOf([claim]))) +
                H.td(`<p class="max-w-[10rem] truncate text-sm font-semibold" title="${H.esc(env)}">${H.esc(env)}</p>
                      <p class="max-w-[10rem] truncate text-[11px] text-faint" title="${H.esc(subLine)}">${H.esc(subLine)}</p>`) +
                H.td(`<button data-action="open-ticket" data-ticket="${H.esc(claim.id)}"
                        class="text-xs font-semibold text-brand-fg hover:underline">${H.esc(claim.id)}</button>`) +
                H.td(H.jiraChip(claim.status)) +
                H.td(`<p class="max-w-[260px] truncate text-sm text-body" title="${H.esc(summaryText)}">${H.esc(summaryText)}</p>`) +
                H.td(`<span class="text-sm font-semibold ${Model.isUrgent(minutesLeft) ? "text-warn" : "text-muted"}">${H.esc(Model.leftText(minutesLeft))}</span>`, "text-right")
              );
            }),
            "No ticket is holding a repository."
          )}
          ${this.pager(active.page, active.totalPages, "dashboard-active-page")}
        </div>

        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-end justify-between gap-3 pb-4">
            <div>
              <h2 class="text-[17px] font-bold tracking-tight">Latest Jira updates</h2>
              <p class="mt-0.5 text-xs text-faint">Most recently updated tickets, synced from Jira</p>
            </div>
            <a href="#tickets" class="text-xs font-semibold text-brand-fg hover:underline">See all</a>
          </div>
          ${H.table(
            H.th("Ticket") + H.th("Assignee") + H.th("Status") + H.th("Branch") + H.th("Repos"),
            updates.map((r) => H.tr(
              H.td(`<button data-action="open-ticket" data-ticket="${H.esc(r.claim.id)}"
                      class="whitespace-nowrap text-xs font-bold text-brand-fg hover:underline">${H.esc(r.claim.id)}</button>
                    <p class="whitespace-nowrap text-[10px] text-faint">${H.esc(Format.agoText(r.claim.updatedAt))} ago</p>`) +
              H.td(H.avatarStack(Model.peopleOf([r.claim]), 2)) +
              H.td(H.jiraChip(r.claim.status)) +
              H.td(`<p class="max-w-[7rem] truncate text-xs font-medium text-body" title="${H.esc(r.claim.branch || r.env)}">${H.esc(r.claim.branch || r.env)}</p>`) +
              H.td(TicketTable.repos(r))
            )),
            "Nothing from Jira yet — run a sync.",
            { narrow: true }
          )}
          ${this.pager(upd.page, upd.totalPages, "dashboard-updates-page")}
        </div>
      </section>`);
  },

  card(row) {
    const token = Tokens.ENV_STATE[row.state];
    const minutes = row.soonest ? Model.minutesLeft(row.soonest) : null;
    return `
      <article class="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
        <div class="flex h-24 flex-col justify-between ${H.TONE[token.tone].soft} p-3">
          <div class="flex items-start justify-between">
            <span class="rounded-full bg-surface/70 px-2.5 py-1 text-[10px] font-bold ${H.TONE[token.tone].fg} backdrop-blur">${H.esc(token.label)}</span>
          </div>
          ${H.repoStrip(row)}
        </div>
        <div class="p-4">
          <span class="inline-block rounded-md bg-subtle-2 px-2 py-0.5 text-[10px] font-bold tracking-wide text-muted">${H.esc(row.accountName.toUpperCase())}</span>
          <h3 class="mt-2.5 text-sm font-bold">${H.esc(row.name)}</h3>
          <div class="mt-3">${H.bar(row.soonest ? Model.progress(row.soonest) : 0, token.bar)}</div>
          <p class="mt-1.5 text-[11px] ${Model.isUrgent(minutes) ? "font-medium text-warn" : "text-faint"}">
            ${!row.soonest ? "No end time set"
              : minutes <= 0 ? "Booking expired"
              : `Frees in ${H.esc(Model.leftText(minutes))}`}</p>
          <div class="mt-3.5 flex items-center gap-2.5 border-t border-line-soft pt-3.5">
            ${row.claims.length
              ? `${H.avatarStack(row.people, 3)}
                 <p class="ml-1 truncate text-[11px] text-faint">${H.esc(row.ticketIds.join(", "))}</p>`
              : `<p class="text-[11px] text-faint">${row.offline.length ? "Offline — no active claim" : "No active claim"}</p>`}
          </div>
        </div>
      </article>`;
  }
});

/* Paging for the two dashboard tables — view state on the page object
   itself, so it lives only as long as the tab is on Dashboard. */

Actions.on("dashboard-active-page", (el) => {
  const page = Router.page("dashboard");
  if (page) page.setActivePage(Number(el.dataset.page));
  Router.render();
});

Actions.on("dashboard-updates-page", (el) => {
  const page = Router.page("dashboard");
  if (page) page.setUpdatesPage(Number(el.dataset.page));
  Router.render();
});
