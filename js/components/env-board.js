/**
 * Board view: environments grouped by account, one card each with repo
 * chips and a compact ticket list.
 */

const EnvBoard = (() => {
  const { escapeHtml, pillHtml, userNames, statusBadgeStyle } = Format;
  function el(id) { return document.getElementById(id); }

  // Repo chips are too narrow for full names. These are the labels the
  // team already uses; anything unrecognised falls back to its first three
  // letters so a custom repo still gets a chip.
  const SHORT = { storefront: "SF", backend: "API", admin: "ADM" };
  function shortRepo(name) { return SHORT[name] || name.slice(0, 3).toUpperCase(); }

  // "QA TESTING (DEV)" reads as just "DEV" on a card this narrow; fall back
  // to the first word for any other workflow status.
  function shortStatus(status) {
    if (!status) return "";
    const inParens = status.match(/\(([^)]+)\)/);
    return (inParens ? inParens[1] : status.split(/\s+/)[0]).toUpperCase();
  }

  function renderCard(server) {
    const displayStatus = State.getDisplayStatus(server);
    const claims = State.getServerTickets(server.id);
    const repoNames = Object.keys(server.repos);
    const freeRepos = repoNames.filter((r) => !claims.some((c) => c.repos.includes(r)));

    const chips = repoNames.map((r) => {
      const repo = server.repos[r];
      const repoClaims = claims.filter((c) => c.repos.includes(r));
      let cls = "state-free";
      if (repo.health === "offline") cls = "state-issue";
      else if (repoClaims.length > 1) cls = "state-shared";
      else if (repoClaims.length === 1) cls = "state-inuse";
      const label = repoClaims.length > 1 ? `${shortRepo(r)}×${repoClaims.length}` : shortRepo(r);
      return `<span class="repo-chip ${cls}">${escapeHtml(label)}</span>`;
    }).join("");

    // Each claim gets its own line: which ticket, which repos it took, what
    // status it's sitting in, and who's on it.
    const ticketsHtml = claims.slice(0, 3).map((c) => `
      <div class="card-ticket">
        <div class="card-ticket-top">
          <span class="mono card-ticket-id">${escapeHtml(c.id)}</span>
          <span class="mono card-ticket-repos">${escapeHtml(c.repos.map(shortRepo).join(" + "))}</span>
          ${c.status ? `<span class="claim-status" style="${statusBadgeStyle(c.status)}">${escapeHtml(shortStatus(c.status))}</span>` : ""}
        </div>
        <div class="card-ticket-people">${escapeHtml(userNames(c.userIds) || (c.rawAssignees || []).join(", ") || "Unassigned")}</div>
      </div>
    `).join("") + (claims.length > 3 ? `<div class="card-ticket-more">+${claims.length - 3} more</div>` : "");

    const meta = claims.length ? "" : `Free — all ${repoNames.length} repositories ready.`;

    // One action per card, as designed. Details stays reachable by clicking
    // the card's header rather than spending a second button on it.
    const primary = freeRepos.length
      ? `<button type="button" class="btn btn-primary" data-action="assign" data-id="${server.id}">Assign</button>`
      : `<button type="button" class="btn btn-danger" data-action="force-free-server" data-id="${server.id}">Force free</button>`;

    return `
      <div class="board-card status-${displayStatus}">
        <div class="board-card-top">
          <div class="board-card-name">${escapeHtml(server.name)}</div>
          ${pillHtml(displayStatus)}
        </div>
        <div class="repo-chips">${chips}</div>
        <div class="board-card-meta">
          ${ticketsHtml}
          ${meta ? `<div class="board-card-free">${escapeHtml(meta)}</div>` : ""}
        </div>
        <div class="board-card-actions">${primary}</div>
      </div>
    `;
  }

  function render() {
    if (UiState.getViewMode() !== "board") return;
    const servers = State.getFilteredServers();
    const accounts = State.getAccounts();
    const container = el("view-board");

    const groups = accounts.map((account) => {
      const envs = servers.filter((s) => s.accountId === account.id);
      const free = envs.filter((s) => State.getDisplayStatus(s) === "free").length;
      return { account, envs, summary: `${envs.length} environments · ${free} free` };
    }).filter((g) => g.envs.length);

    if (!groups.length) {
      container.innerHTML = `<p class="empty-state">No environments match these filters.</p>`;
      return;
    }

    container.innerHTML = groups.map((g) => `
      <div class="board-group">
        <div class="board-group-header">
          <h2>${escapeHtml(g.account.displayName)}</h2>
          <span class="board-group-summary">${escapeHtml(g.summary)}</span>
        </div>
        <div class="board-grid">
          ${g.envs.map(renderCard).join("")}
        </div>
      </div>
    `).join("");
  }

  function bindEvents() {
    el("view-board").addEventListener("click", (e) => {
      const target = e.target.closest("[data-action]");
      if (!target) return;
      const { action, id } = target.dataset;
      if (action === "assign") AssignModal.open(id);
      else if (action === "force-free-server") ClaimsActions.confirmForceFreeServer(id);
    });
  }

  return { render, bindEvents };
})();
