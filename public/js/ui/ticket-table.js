/**
 * The ticket table: one row per ticket, and the status chips that cut it.
 *
 * Shared by Active tickets and My tickets. Both pages ask the same
 * question — "which ticket is where, and until when?" — and differ only in
 * which tickets they hand over and whether an Assignees column makes
 * sense, so neither owns the table and the two cannot drift apart.
 *
 * A row is either holding repositories (a claim) or not (anything else the
 * last sync saw). Both are listed: a ticket at TO REVIEW is still someone's
 * ticket, and the point of the chips is to reach it. Holding rows carry the
 * amber repository chips and the countdown; the rest are plainly not on an
 * environment, and read that way.
 *
 * Status is the cut that matters, so it is chips rather than a dropdown:
 * the whole workflow is visible with a count against each before anything
 * is clicked, which a <select> can't do. Which cut a page is on is view
 * state and lives on the page, not here — this module only reads it.
 */

const TicketTable = (() => {

  // ---------- status ----------

  // Jira reports statuses in its own casing and a manual claim may carry
  // none at all, so grouping and matching both go through here.
  function statusOf(claim) {
    return (claim.status || "").trim() || "Unknown";
  }

  // "all" is every ticket, "holding" is the ones actually on an
  // environment, anything else is a status label.
  function matches(row, selected) {
    if (!selected || selected === "all") return true;
    if (selected === "holding") return !!row.holding;
    return statusOf(row.claim).toLowerCase() === String(selected).toLowerCase();
  }

  function filter(rows, selected) {
    return rows.filter((row) => matches(row, selected));
  }

  /**
   * One entry per status, in workflow order: the whole vocabulary, whether
   * or not anything sits at it today. A status with nothing on it is worth
   * a chip — reading "QA FAILED 0" answers the question the click was
   * going to ask.
   *
   * Statuses off the vocabulary (a manual claim's, or one Jira gained since
   * this list was written) follow, biggest first, in their own casing.
   */
  function options(rows, selected) {
    const chosen = String(selected || "all").toLowerCase();
    const counts = new Map();
    const labels = new Map();
    rows.forEach((row) => {
      const label = statusOf(row.claim);
      const key = label.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!labels.has(key)) labels.set(key, label);
    });

    const known = new Set(JIRA_STATUS_VOCABULARY.map((s) => s.toLowerCase()));
    const entry = (label) => {
      const key = label.toLowerCase();
      return { label, count: counts.get(key) || 0, on: key === chosen };
    };

    const workflow = JIRA_STATUS_VOCABULARY.map(entry);
    const extra = [...labels.keys()]
      .filter((key) => !known.has(key))
      .map((key) => entry(labels.get(key)))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    // A status cut to from somewhere else, now on neither list, still needs
    // its chip: one that vanishes under the pointer leaves the table
    // looking broken rather than filtered.
    const listed = [...workflow, ...extra];
    if (chosen !== "all" && chosen !== "holding" && !listed.some((o) => o.on)) {
      listed.push({ label: selected, count: 0, on: true });
    }
    return listed;
  }

  // ---------- which chips are on the row ----------

  /**
   * Thirteen statuses is a lot of chips, and most weeks touch four. Which
   * ones a reader keeps is a per-browser preference, like the theme: it
   * changes what is on screen, not what the table can be cut to, and it
   * moves nobody else's view — so it stays in localStorage rather than
   * going through State.
   *
   * What is stored is the hidden ones. A status Jira gains later then
   * shows up on its own instead of being silently missing.
   */
  const HIDDEN_KEY = "serverManager.hiddenStatusChips";
  let hidden = null;

  function hiddenSet() {
    if (hidden) return hidden;
    hidden = new Set();
    try {
      const raw = localStorage.getItem(HIDDEN_KEY);
      if (raw) JSON.parse(raw).forEach((s) => hidden.add(String(s).toLowerCase()));
    } catch (err) { /* storage blocked, or written by an older version — show everything */ }
    return hidden;
  }

  const isHidden = (label) => hiddenSet().has(String(label).toLowerCase());

  // Takes the statuses to *show*, out of the ones that were on offer —
  // everything else on that list is what gets hidden.
  function setShown(shown, offered) {
    const keep = new Set(shown.map((s) => String(s).toLowerCase()));
    hidden = new Set(offered.map((s) => String(s).toLowerCase()).filter((s) => !keep.has(s)));
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch (err) { /* storage blocked */ }
  }

  const chip = (label, count, on, status) =>
    H.filterChip(label, count, on, { "data-action": "filter-ticket-status", "data-status": status });

  // The chip row above a table. Nothing to cut means nothing to show —
  // a lone "All statuses (0)" is furniture, not a filter.
  function chips(rows, selected) {
    if (!rows.length) return "";
    const chosen = String(selected || "all");
    const holding = rows.filter((r) => r.holding).length;
    // The cut currently in force always keeps its chip, hidden or not: one
    // that vanishes under the pointer leaves the table looking broken.
    const all = options(rows, chosen);
    const listed = all.filter((o) => o.on || !isHidden(o.label));
    const off = all.length - listed.length;

    return `<div class="flex flex-wrap items-center gap-2 pb-4">
      ${chip("All statuses", rows.length, chosen === "all", "all")}
      ${chip("Holding a repo", holding, chosen === "holding", "holding")}
      <span class="mx-1 h-5 w-px bg-line-2"></span>
      ${listed.map((o) => chip(o.label, o.count, o.on, o.label)).join("")}
      <button type="button" data-action="edit-status-chips" title="Choose which statuses show here"
        class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-semibold text-faint transition hover:bg-brand-soft hover:text-brand-fg">
        ${H.icon("gear", "h-3 w-3")}Edit${off ? ` <span class="text-faintest">· ${off} hidden</span>` : ""}
      </button>
    </div>`;
  }

  // ---------- rows ----------

  // A date, or why the row hasn't got one — a manual claim can be
  // open-ended, and a ticket nobody has scheduled has neither.
  function when(iso, fallback) {
    return iso
      ? `<p class="whitespace-nowrap text-xs font-medium text-body">${H.esc(Format.formatDateTime(iso))}</p>`
      : `<p class="whitespace-nowrap text-xs italic text-faintest">${H.esc(fallback)}</p>`;
  }

  // The SF/API/ADM strip. Amber is "this ticket is holding it"; grey is the
  // repositories the ticket names but does not hold, because its status
  // does not claim anything.
  function repos({ claim, server, holding }) {
    if (!claim.repos || !claim.repos.length) return H.dash;
    return `<div class="flex gap-1">${claim.repos.map((r) => H.repoChip({
      name: r,
      url: ((server && server.repos[r]) || {}).url,
      state: holding ? "held" : "named on the ticket, not held at this status",
      cls: holding ? "bg-warn-strong/85 text-white" : "bg-line-2 text-muted"
    })).join("")}</div>`;
  }

  function row(r, assignees) {
    const { claim, env, accountName, minutesLeft, holding } = r;
    return H.tr(
      H.td(`<button data-action="open-ticket" data-ticket="${H.esc(claim.id)}"
              class="whitespace-nowrap text-xs font-bold text-brand-fg hover:underline">${H.esc(claim.id)}</button>
            ${claim.source === "manual" ? `<span class="ml-1 text-[10px] font-semibold text-faint">manual</span>` : ""}`) +
      H.td(`<span class="line-clamp-2 block max-w-[320px] text-sm text-body">${H.esc(claim.summary || claim.note || "—")}</span>`) +
      H.td(H.jiraChip(claim.status)) +
      H.td(`<p class="text-sm font-semibold ${holding ? "" : "text-muted"}">${H.esc(accountName)}</p>
            <p class="text-[11px] text-faint">${H.esc(claim.branch || env)}</p>`) +
      H.td(repos(r)) +
      (assignees ? H.td(H.avatarStack(Model.peopleOf([claim]))) : "") +
      H.td(when(claim.startTime, "Not set")) +
      H.td(`${when(claim.endTime, holding ? "Open-ended" : "No due date")}
            ${holding && claim.endTime
              ? `<p class="text-[11px] font-semibold ${Model.isUrgent(minutesLeft) ? "text-warn" : "text-faint"}">${H.esc(Model.leftText(minutesLeft))}</p>`
              : ""}`)
    );
  }

  /**
   * The table itself. `assignees` adds the avatar column — on a page that
   * is already one person's tickets it would be the same face all the way
   * down, so My tickets leaves it off.
   */
  function table(rows, opts = {}) {
    return H.table(
      H.th("Ticket") + H.th("Title") + H.th("Status") + H.th("Account / environment") +
      H.th("Repositories") + (opts.assignees ? H.th("Assignees") : "") + H.th("Start") + H.th("End"),
      rows.map((r) => row(r, !!opts.assignees)),
      opts.empty
    );
  }

  // What separates the amber rows from the grey ones — the statuses a
  // ticket has to reach before it holds anything, and the ones that hand
  // it back.
  function statusNote() {
    const jira = State.getSettings().jira;
    const occupying = jira.occupyingStatuses || [];
    if (!occupying.length) return "";
    // Terminal statuses free an environment whether or not anyone listed
    // them, so they belong in the sentence that says what frees one.
    const seen = new Set();
    const releasing = [...(jira.releasingStatuses || []), ...JIRA_TERMINAL_STATUSES]
      .filter((s) => !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));

    return `<p class="pt-4 text-center text-[11px] text-faint">
      A ticket holds its repositories while Jira has it at ${H.esc(occupying.join(", "))},
      and hands them back at ${H.esc(releasing.join(", "))} —
      every other status is on this list without holding anything.
    </p>`;
  }

  return { statusOf, matches, filter, options, chips, table, statusNote, isHidden, setShown, repos };
})();

/* The chips above every ticket table. Narrowing is view state, so these
   only re-render — nothing is written back to State. The page is inferred
   the way toggle-env infers it, so neither table registers its own
   handlers; a page with a ticket table answers ticketRows(). */

Actions.on("filter-ticket-status", (el) => {
  const page = Router.page(Router.currentId());
  if (page && page.setStatusFilter) page.setStatusFilter(el.dataset.status);
  Router.render();
});

Actions.on("edit-status-chips", () => {
  const page = Router.page(Router.currentId());
  const rows = page && page.ticketRows ? page.ticketRows() : [];
  const options = TicketTable.options(rows, "all");
  Modals.statusChips(options, TicketTable.isHidden, (shown) => {
    TicketTable.setShown(shown, options.map((o) => o.label));
    Router.render();
  });
});
