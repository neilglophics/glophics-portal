/**
 * The "Claim Repos" modal — pick which free (or already-claimed, for a
 * deliberate "Shared" booking) repos to claim, who for, and optionally a
 * Jira ticket to autofill from and hand tracking over to.
 */

const AssignModal = (() => {
  const { escapeHtml } = Format;
  function el(id) { return document.getElementById(id); }

  function populateUserOptions() {
    el("assign-user-group").innerHTML = State.getUsers().map((u) => `
      <label class="checkbox-item">
        <input type="checkbox" name="assign-user" value="${u.id}" />
        <span>${escapeHtml(u.name)}</span>
      </label>
    `).join("");
    updateUserTriggerLabel();
  }

  function getSelectedUserIds() {
    return Array.from(el("assign-user-group").querySelectorAll("input:checked")).map((cb) => cb.value);
  }

  function getSelectedRepos() {
    return Array.from(el("assign-repo-group").querySelectorAll("input:checked")).map((cb) => cb.value);
  }

  function updateUserTriggerLabel() {
    const names = Array.from(el("assign-user-group").querySelectorAll("input:checked"))
      .map((cb) => cb.nextElementSibling.textContent);
    el("assign-user-trigger-label").textContent = names.length ? names.join(", ") : "Select people";
  }

  function closeUserDropdown() { el("assign-user-group").hidden = true; }
  function toggleUserDropdown() { el("assign-user-group").hidden = !el("assign-user-group").hidden; }

  function selectUsers(userIds) {
    el("assign-user-group").querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.checked = userIds.includes(cb.value);
    });
    updateUserTriggerLabel();
  }

  function toLocalInputValue(iso) {
    const d = iso ? new Date(iso) : new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Fills the form from a resolved ticket lookup — matches "Ticket
  // Assignee" label values against configured users, checks the repo boxes
  // the ticket's Repository field resolves to, and sets Start/End from the
  // ticket's Start date / Due date.
  function applyAutofill(data) {
    const { matched: matchedIds, unmatched } = State.matchUserIdsByLabels(data.ticketAssignees);
    if (matchedIds.length) selectUsers(matchedIds);

    if (data.startDate) el("assign-start").value = `${data.startDate}T09:00`;
    if (data.dueDate) el("assign-end").value = `${data.dueDate}T18:00`;
    if (!el("assign-note").value && data.summary) el("assign-note").value = data.summary;

    const notes = [];
    if (matchedIds.length || data.startDate || data.dueDate) notes.push("Auto-filled from ticket");
    if (unmatched.length) notes.push(`Not matched to a user: ${unmatched.join(", ")}`);

    const server = State.getServer(el("assign-server-id").value);
    if (server && data.repository && data.repository.length) {
      const repoCheck = State.matchRepositoriesToKeys(data.repository, Object.keys(server.repos));
      if (repoCheck.matched.length) {
        el("assign-repo-group").querySelectorAll("input[type=checkbox]").forEach((cb) => {
          cb.checked = repoCheck.matched.includes(cb.value);
        });
      }
      if (repoCheck.unmatched.length) {
        notes.push(`Ticket's Repository (${repoCheck.unmatched.join(", ")}) doesn't match a repo on ${server.name}`);
      }
    }

    if (notes.length) {
      el("assign-jira-info").innerHTML = JiraLookup.resultHtml(data, notes.join(" — "));
    }
  }

  function open(serverId) {
    const server = State.getServer(serverId);
    if (!server) return;
    const account = State.getAccount(server.accountId);
    const claims = State.getServerTickets(server.id);

    el("assign-modal-title").textContent = "Claim Repos";
    el("assign-submit").textContent = "Claim";
    el("assign-server-id").value = server.id;
    el("assign-server-name").value = server.name;
    el("assign-account-name").value = account ? account.displayName : "—";
    el("assign-form-error").hidden = true;

    const wholeEnv = State.getSettings().assignWholeEnv !== false;
    el("assign-repo-group").innerHTML = Object.keys(server.repos).map((r) => {
      const existing = claims.filter((c) => c.repos.includes(r));
      return `
        <label class="checkbox-item">
          <input type="checkbox" name="assign-repo" value="${escapeHtml(r)}" ${!existing.length && wholeEnv ? "checked" : ""} />
          <span>${escapeHtml(r)}${existing.length ? ` <span class="muted-dash">(already claimed ×${existing.length})</span>` : ""}</span>
        </label>
      `;
    }).join("");

    populateUserOptions();
    selectUsers([]);
    closeUserDropdown();
    el("assign-jira").value = "";
    el("assign-jira-info").hidden = true;
    el("assign-jira-info").innerHTML = "";
    el("assign-note").value = "";

    el("assign-start").value = toLocalInputValue(null);
    const hours = State.getSettings().defaultBookingHours || 4;
    const end = new Date(Date.now() + hours * 3600000);
    el("assign-end").value = toLocalInputValue(end.toISOString());

    el("assign-modal-overlay").hidden = false;
  }

  function close() { el("assign-modal-overlay").hidden = true; }

  function showError(messages) {
    const box = el("assign-form-error");
    box.textContent = messages.join(" ");
    box.hidden = false;
  }

  function bindEvents() {
    el("assign-cancel").addEventListener("click", close);
    el("assign-modal-close").addEventListener("click", close);
    el("assign-modal-overlay").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) close();
    });

    async function lookupAndAutofill(ticketValue) {
      const data = await JiraLookup.loadInto(el("assign-jira-info"), ticketValue);
      if (data) applyAutofill(data);
    }

    // Debounced on "input" (while they're still typing/pausing) rather than
    // "blur" — blur fires right as focus moves toward Submit, and the info
    // panel appearing at that exact instant shifts the button out from
    // under an in-flight click.
    let jiraLookupTimer = null;
    el("assign-jira").addEventListener("input", (e) => {
      clearTimeout(jiraLookupTimer);
      const value = e.target.value;
      jiraLookupTimer = setTimeout(() => lookupAndAutofill(value), 400);
    });
    el("assign-jira").addEventListener("blur", (e) => {
      const key = JiraLookup.extractKey(e.target.value);
      if (key) e.target.value = key;
    });

    el("assign-jira-info").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action='refresh-jira']");
      if (!btn) return;
      lookupAndAutofill(el("assign-jira-info").dataset.jiraKey);
    });

    el("assign-user-trigger").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleUserDropdown();
    });
    el("assign-user-group").addEventListener("change", updateUserTriggerLabel);
    document.addEventListener("click", (e) => {
      if (!el("assign-user-dropdown").contains(e.target)) closeUserDropdown();
    });

    el("assign-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const serverId = el("assign-server-id").value;
      const payload = {
        repos: getSelectedRepos(),
        userIds: getSelectedUserIds(),
        jiraTicket: el("assign-jira").value,
        note: el("assign-note").value,
        startTime: new Date(el("assign-start").value).toISOString(),
        endTime: new Date(el("assign-end").value).toISOString()
      };

      const result = State.addClaim(serverId, payload);
      if (!result.ok) {
        showError(result.errors);
        return;
      }
      close();
    });
  }

  return { open, close, showError, bindEvents };
})();
