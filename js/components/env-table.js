/**
 * Table view: one row per environment, expandable into its per-repo claims
 * (rendered by RepoClaims).
 */

const EnvTable = (() => {
  const { escapeHtml, userNames, pillHtml, remaining } = Format;
  function el(id) { return document.getElementById(id); }

  // Reads back what the row's expanded contents add up to: how many
  // tickets hold it, plus any that Jira matched to this environment but
  // that aren't at an occupying status yet (so they hold nothing).
  function summaryNote(server, claims, repoCount) {
    const held = claims.length
      ? `${claims.length} ticket${claims.length > 1 ? "s" : ""} in QA testing ${claims.length > 1 ? "share" : "holds"} this environment.`
      : `No ticket in QA testing. All ${repoCount} repositories are free.`;
    const waiting = State.getWaitingTickets(server.id);
    if (!waiting.length) return held;
    const plural = waiting.length > 1;
    return `${held} ${waiting.length} more ticket${plural ? "s" : ""} on this branch ${plural ? "are" : "is"} not in QA testing yet, so ${plural ? "they hold" : "it holds"} nothing.`;
  }

  function renderRow(server) {
    const account = State.getAccount(server.accountId);
    const displayStatus = State.getDisplayStatus(server);
    const claims = State.getServerTickets(server.id);
    const dash = `<span class="muted-dash">—</span>`;
    const isOpen = UiState.isRowOpen(server.id);
    const repoNames = Object.keys(server.repos);
    const downCount = repoNames.filter((r) => server.repos[r].health === "offline").length;

    const allUserIds = [...new Set(claims.flatMap((c) => c.userIds))];
    const names = userNames(allUserIds);
    const ticketIds = [...new Set(claims.map((c) => c.id))];
    const ticketLabel = ticketIds.length
      ? (ticketIds.length > 2 ? `${ticketIds.slice(0, 2).join(", ")} +${ticketIds.length - 2}` : ticketIds.join(", "))
      : null;

    // "Booked" reads as when it started over when the soonest claim frees up.
    const withStart = claims.filter((c) => c.startTime).sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    const withEnd = claims.filter((c) => c.endTime).sort((a, b) => new Date(a.endTime) - new Date(b.endTime));
    let endCell = claims.length ? "" : dash;
    if (withStart.length) {
      endCell += `<div class="env-since">${escapeHtml(Format.formatDateTime(withStart[0].startTime))}</div>`;
    }
    if (withEnd.length) {
      const r = remaining(withEnd[0].endTime);
      const suffix = withEnd.length > 1 ? " (first)" : "";
      endCell += `<div class="env-ends ${r.level === "expired" ? "expired" : r.level === "warning" ? "warn" : ""}" data-end="${withEnd[0].endTime}">${r.text}${suffix}</div>`;
    }
    if (!endCell) endCell = dash;

    const freeRepos = repoNames.filter((r) => !claims.some((c) => c.repos.includes(r)));
    const primary = freeRepos.length
      ? `<button class="btn btn-primary btn-sm" data-action="assign" data-id="${server.id}">Assign</button>`
      : `<button class="btn btn-danger btn-sm" data-action="force-free-server" data-id="${server.id}">Force free</button>`;
    const actions = `<button class="btn btn-ghost btn-sm" data-action="toggle-row" data-id="${server.id}">Details</button>${primary}`;

    const main = `
      <div class="grid-row-cols grid-row-main">
        <div class="env-cell" data-action="toggle-row" data-id="${server.id}">
          <span class="env-caret">${isOpen ? "▾" : "▸"}</span>
          <div>
            <div class="env-name">${escapeHtml(server.name)}</div>
            <div class="env-meta">${account ? escapeHtml(account.displayName) : "—"} · ${downCount ? `${downCount} of ${repoNames.length} offline` : `${repoNames.length} repos`}</div>
          </div>
        </div>
        <div>${pillHtml(displayStatus)}</div>
        <div class="env-people">${names ? escapeHtml(names) : dash}</div>
        <div class="env-ticket mono">${ticketLabel ? escapeHtml(ticketLabel) : dash}</div>
        <div>${endCell}</div>
        <div class="row-actions">${actions}</div>
      </div>
    `;

    const detail = isOpen ? `
      <div class="repo-detail">
        ${repoNames.map((repoName) => RepoClaims.render(server, repoName)).join("")}
        <div class="env-note">${escapeHtml(summaryNote(server, claims, repoNames.length))}</div>
      </div>
    ` : "";

    return `<div class="grid-body-row" data-server-row="${server.id}">${main}${detail}</div>`;
  }

  function render() {
    if (UiState.getViewMode() !== "table") return;
    const servers = State.getFilteredServers();
    const grid = el("grid-table");
    const emptyState = el("empty-state");

    if (!servers.length) {
      grid.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    grid.innerHTML = `
      <div class="grid-row-cols grid-head">
        <div>Environment</div><div>Status</div><div>Assigned to</div><div>Ticket</div><div>Booked</div><div></div>
      </div>
      ${servers.map(renderRow).join("")}
    `;
  }

  function updateCountdowns() {
    document.querySelectorAll(".env-ends[data-end]").forEach((elm) => {
      const r = remaining(elm.getAttribute("data-end"));
      elm.textContent = r.text;
      elm.className = `env-ends ${r.level === "expired" ? "expired" : r.level === "warning" ? "warn" : ""}`;
    });
  }

  function bindEvents() {
    const grid = el("grid-table");
    grid.addEventListener("click", (e) => {
      const target = e.target.closest("[data-action]");
      if (!target) return;
      const { action, id } = target.dataset;
      if (action === "toggle-row") { UiState.toggleRowOpen(id); render(); }
      else if (action === "assign") AssignModal.open(id);
      else if (action === "force-free-server") ClaimsActions.confirmForceFreeServer(id);
    });
    RepoClaims.bindTo(grid);

    setInterval(updateCountdowns, 1000);
  }

  return { render, updateCountdowns, bindEvents };
})();
