/**
 * One repo's block within an expanded environment: its URL/health, every
 * active claim on it (ticket, status, people, ends, Force free), and its
 * persistent note. Shared by the table's expanded row and the Details
 * modal — render() is pure, bindTo() attaches one delegated listener that
 * both callers can reuse.
 */

const RepoClaims = (() => {
  const { escapeHtml, userNames, remaining, statusBadgeStyle } = Format;
  function el(id) { return document.getElementById(id); }

  // The note lives under the repo row: just the text when there is one, and
  // the editor only while it's open. The button that opens it sits inline in
  // the repo row's action group.
  function renderNote(serverId, repoName) {
    const note = State.getRepoNote(serverId, repoName);
    if (UiState.isNoteOpen(serverId, repoName)) {
      return `
        <form class="note-edit-form" data-action="save-note" data-id="${serverId}" data-repo="${escapeHtml(repoName)}">
          <textarea placeholder="Note for this server — what's deployed, gotchas, who to ping.">${escapeHtml(note)}</textarea>
          <button type="submit" class="btn btn-primary btn-sm">Save note</button>
        </form>
      `;
    }
    return note ? `<div class="repo-note">${escapeHtml(note)}</div>` : "";
  }

  // One label for "what's happening on this repo", matching the design:
  // an unreachable server outranks everything, then the claim count.
  function repoState(repo, claims) {
    if (repo.health === "offline") return { label: "Offline", color: "var(--danger)" };
    if (claims.length > 1) return { label: `Shared ×${claims.length}`, color: "var(--warning)" };
    if (claims.length === 1) return { label: "In use", color: "var(--warning)" };
    if (repo.health === "checking") return { label: "Checking…", color: "var(--muted-2)" };
    return { label: "Available", color: "var(--success)" };
  }

  function render(server, repoName) {
    const repo = server.repos[repoName];
    const claims = State.getRepoClaims(server.id, repoName);
    const hasNote = !!State.getRepoNote(server.id, repoName);
    const noteOpen = UiState.isNoteOpen(server.id, repoName);

    const claimsHtml = claims.length ? claims.map((c) => `
      <div class="claim-row">
        ${c.source === "jira"
          ? `<button type="button" class="claim-ticket" data-action="lookup-ticket" data-ticket-id="${escapeHtml(c.id)}">${escapeHtml(c.id)}</button>`
          : `<span class="claim-ticket">${escapeHtml(c.id)}</span>`}
        ${c.status
          ? `<span class="claim-status" style="${statusBadgeStyle(c.status)}">${escapeHtml(c.status)}</span>`
          : `<span></span>`}
        <div class="claim-people">${escapeHtml(userNames(c.userIds) || (c.rawAssignees || []).join(", ") || "Unassigned")}</div>
        <div class="claim-summary">${escapeHtml(c.summary || c.note || "")}</div>
        <div class="claim-ends">${c.endTime ? remaining(c.endTime).text : ""}</div>
        <button type="button" class="claim-release" data-action="force-free-ticket" data-ticket-id="${escapeHtml(c.id)}">Force free</button>
      </div>
    `).join("") : "";

    const noteBtn = `<button type="button" class="btn btn-ghost btn-sm${noteOpen ? " is-active" : ""}" data-action="edit-note" data-id="${server.id}" data-repo="${escapeHtml(repoName)}">${hasNote ? "Note •" : "Note"}</button>`;

    const headerHtml = !repo.url ? `
      <div class="repo-row">
        <div class="repo-name">${escapeHtml(repoName)}</div>
        <div class="mono repo-state">Not configured</div>
        <div></div>
        <form class="repo-url-set-form" data-action="set-repo-url" data-id="${server.id}" data-repo="${escapeHtml(repoName)}">
          <input type="text" placeholder="https://…" required />
          <button type="submit" class="btn btn-ghost btn-sm">Set URL</button>
        </form>
      </div>
    ` : (() => {
      const state = repoState(repo, claims);
      return `
        <div class="repo-row">
          <div class="repo-name">${escapeHtml(repoName)}</div>
          <a class="repo-url" href="${escapeHtml(repo.url)}" target="_blank" rel="noopener">${escapeHtml(Format.repoUrlOrigin(repo.url))}</a>
          <div class="repo-state" style="color:${state.color}">${escapeHtml(state.label)}</div>
          <div class="repo-row-actions">
            ${noteBtn}
            <button type="button" class="btn btn-ghost btn-sm" data-action="copy-url" data-url="${escapeHtml(repo.url)}">Copy URL</button>
            <a class="btn btn-ghost btn-sm" href="${escapeHtml(repo.url)}" target="_blank" rel="noopener">Open</a>
          </div>
        </div>
      `;
    })();

    return `
      <div class="repo-block">
        ${headerHtml}
        ${claimsHtml ? `<div class="claims-list">${claimsHtml}</div>` : ""}
        ${renderNote(server.id, repoName)}
      </div>
    `;
  }

  // Delegated click/submit handling for everything a repo block can do.
  // Safe to call on any container that only ever holds repo blocks it owns
  // (the table's expanded rows, the Details modal body).
  function bindTo(container) {
    container.addEventListener("click", (e) => {
      const target = e.target.closest("[data-action]");
      if (!target) return;
      const { action, id } = target.dataset;
      if (action === "force-free-ticket") ClaimsActions.confirmForceFreeTicket(target.dataset.ticketId);
      else if (action === "lookup-ticket") ClaimsActions.openInJira(target.dataset.ticketId);
      else if (action === "copy-url") ClaimsActions.copyUrl(target);
      else if (action === "edit-note") {
        UiState.toggleNoteOpen(id, target.dataset.repo);
        Rerender.views();
      }
    });

    container.addEventListener("submit", (e) => {
      const urlForm = e.target.closest("[data-action='set-repo-url']");
      if (urlForm) {
        e.preventDefault();
        const url = urlForm.querySelector("input").value.trim();
        if (!url) return;
        State.updateServerRepoUrl(urlForm.dataset.id, urlForm.dataset.repo, url);
        return;
      }
      const noteForm = e.target.closest("[data-action='save-note']");
      if (noteForm) {
        e.preventDefault();
        const text = noteForm.querySelector("textarea").value;
        State.setRepoNote(noteForm.dataset.id, noteForm.dataset.repo, text);
        UiState.toggleNoteOpen(noteForm.dataset.id, noteForm.dataset.repo);
        Rerender.views();
      }
    });
  }

  return { render, bindTo };
})();
