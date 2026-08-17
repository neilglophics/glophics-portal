/**
 * Ticket-key parsing and single-ticket lookup rendering — the small piece
 * of Jira integration the Assign modal needs for its "paste a ticket, get
 * autofill" convenience. The bulk sync that actually populates claims
 * lives server-side (server.js); this is just a one-off GET + render.
 */

const JiraLookup = (() => {
  const { escapeHtml } = Format;
  const STATUS_PILL_CLASS = { new: "pill-checking", indeterminate: "pill-inuse", done: "pill-free" };

  function extractKey(raw) {
    if (!raw) return null;
    const trimmed = raw.trim();
    const urlMatch = trimmed.match(/\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)/i);
    if (urlMatch) return urlMatch[1].toUpperCase();
    if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(trimmed)) return trimmed.toUpperCase();
    return null;
  }

  function loadingHtml(key) {
    return `<div class="jira-info jira-info-loading">Looking up ${escapeHtml(key)}…</div>`;
  }
  function errorHtml(message) {
    return `<div class="jira-info jira-info-error">${escapeHtml(message)}</div>`;
  }
  function resultHtml(data, autofillNote) {
    const pillClass = STATUS_PILL_CLASS[data.statusCategory] || "pill-checking";
    const metaBits = [];
    if (data.accountName) metaBits.push(`Account: ${escapeHtml(data.accountName)}`);
    if (data.branch) metaBits.push(`Branch: ${escapeHtml(data.branch)}`);
    if (data.repository && data.repository.length) metaBits.push(`Repos: ${escapeHtml(data.repository.join(", "))}`);
    return `
      <div class="jira-info jira-info-result">
        <div class="jira-info-row">
          <a href="${escapeHtml(data.url)}" target="_blank" rel="noopener">${escapeHtml(data.key)}</a>
          <span class="pill ${pillClass}"><span class="dot"></span>${escapeHtml(data.status)}</span>
          <button type="button" class="btn-link jira-refresh" data-action="refresh-jira">Refresh</button>
        </div>
        <div class="jira-info-summary">${escapeHtml(data.summary)}</div>
        <div class="jira-info-assignee">Assignee: ${data.assignee ? escapeHtml(data.assignee) : "Unassigned"}</div>
        ${metaBits.length ? `<div class="jira-info-assignee">${metaBits.join(" · ")}</div>` : ""}
        ${autofillNote ? `<div class="jira-info-assignee">${escapeHtml(autofillNote)}</div>` : ""}
      </div>
    `;
  }

  let requestSeq = 0;

  // Fetches the ticket and renders the result (or error) into `container`.
  // Returns the resolved data (or null on failure/skip) so callers can
  // decide whether to autofill a form from it.
  async function loadInto(container, ticketKeyRaw) {
    if (!container) return null;

    const key = extractKey(ticketKeyRaw);
    if (!key || !State.getSettings().jira.pullTicketInfo) {
      container.hidden = true;
      container.innerHTML = "";
      container.dataset.jiraKey = "";
      return null;
    }

    const seq = ++requestSeq;
    container.hidden = false;
    container.dataset.jiraKey = key;
    container.innerHTML = loadingHtml(key);

    try {
      const res = await fetch(`/api/jira/${encodeURIComponent(key)}`);
      const data = await res.json();
      if (seq !== requestSeq) return null;
      container.innerHTML = data.ok ? resultHtml(data) : errorHtml(data.error);
      return data.ok ? data : null;
    } catch (err) {
      if (seq !== requestSeq) return null;
      container.innerHTML = errorHtml("Couldn't reach the server to look up this ticket.");
      return null;
    }
  }

  return { extractKey, loadInto, resultHtml };
})();
