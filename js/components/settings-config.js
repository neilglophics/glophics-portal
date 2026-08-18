/**
 * Settings → Accounts / Users / Servers tabs: the add-forms, the config
 * lists, and the inline edit row any entry in those lists can open.
 */

const SettingsConfig = (() => {
  const { escapeHtml, STATUS_LABEL } = Format;
  function el(id) { return document.getElementById(id); }

  const LISTS = ["accounts", "users", "servers"];
  const LIST_ELEMENT_ID = { accounts: "list-accounts", users: "list-users", servers: "list-servers" };

  let activeTab = "accounts";

  // At most one inline edit row is open at a time across the three tabs:
  // { list, id, draft, error }. The whole settings panel re-renders on
  // every state change — including pushes from other viewers and Jira sync
  // ticks — so the row's half-typed values live here and the caret is
  // re-taken afterwards, instead of being reset under the user's hands.
  let editing = null;

  function setTab(tab) {
    activeTab = tab;
    document.querySelectorAll("#settings-tabs .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".settings-tab-body").forEach((p) => { p.hidden = p.dataset.tabPanel !== tab; });
  }

  function populateServerFormRepoUrlInputs(accountId) {
    const repoNames = State.getRepositoriesForAccount(accountId);
    el("form-add-server-repo-urls").innerHTML = repoNames.map((r) => `
      <input type="text" data-repo="${escapeHtml(r)}" placeholder="${escapeHtml(r)} URL (optional)" />
    `).join("");
  }

  // ---------- inline edit rows ----------

  function isEditing(list, id) {
    return !!editing && editing.list === list && editing.id === id;
  }

  // The entry being edited may have been removed by another viewer while
  // the row was open.
  function editingEntityExists() {
    if (!editing) return true;
    if (editing.list === "accounts") return !!State.getAccount(editing.id);
    if (editing.list === "users") return !!State.getUser(editing.id);
    return !!State.getServer(editing.id);
  }

  function captureEditFocus() {
    const active = document.activeElement;
    const form = active && active.closest ? active.closest("form[data-edit-list]") : null;
    if (!form) return null;
    return {
      list: form.dataset.editList,
      selector: active.dataset.repo ? `[data-repo="${active.dataset.repo}"]` : `[name="${active.name}"]`,
      start: active.selectionStart,
      end: active.selectionEnd
    };
  }

  function restoreEditFocus(focus) {
    if (!focus) return;
    const input = el(LIST_ELEMENT_ID[focus.list]).querySelector(focus.selector);
    if (!input) return;
    input.focus();
    // A <select> has no text selection to put back.
    if (focus.start !== null && focus.start !== undefined) input.setSelectionRange(focus.start, focus.end);
  }

  function startEdit(list, id, draft, focusField) {
    editing = { list, id, draft, error: "" };
    render();
    const input = el(LIST_ELEMENT_ID[list]).querySelector(`[name="${focusField}"]`);
    if (input) { input.focus(); input.select(); }
  }

  function cancelEdit() {
    editing = null;
    render();
  }

  // Cleared up front: a successful update notifies (re-rendering these
  // lists) before it returns, so the edit row has to be gone by then.
  function commitEdit(apply) {
    const open = editing;
    editing = null;
    const result = apply();
    if (!result.ok) {
      editing = { ...open, error: result.errors.join(" ") };
      render();
    }
  }

  function editRow(list, id, fieldsHtml, hint) {
    return `
      <li class="config-item-editing">
        <form class="config-edit-form" data-edit-list="${list}" data-edit-id="${escapeHtml(id)}">
          <div class="config-edit-fields">${fieldsHtml}</div>
          <div class="config-edit-actions">
            <button type="submit" class="btn btn-primary btn-sm">Save</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-edit">Cancel</button>
          </div>
          ${editing.error ? `<p class="config-edit-error">${escapeHtml(editing.error)}</p>` : ""}
          ${hint ? `<p class="config-edit-hint">${hint}</p>` : ""}
        </form>
      </li>`;
  }

  function textField(name, label) {
    return `<input type="text" name="${name}" value="${escapeHtml(editing.draft[name])}" aria-label="${escapeHtml(label)}" placeholder="${escapeHtml(label)}" required />`;
  }

  function itemActions(list, id, removeAttrs) {
    return `
      <div class="config-item-actions">
        <button class="btn btn-ghost btn-sm" data-action="edit" data-list="${list}" data-id="${escapeHtml(id)}">Edit</button>
        <button class="btn btn-ghost btn-sm" data-action="remove" data-list="${list}" data-id="${escapeHtml(id)}" ${removeAttrs || ""}>Remove</button>
      </div>`;
  }

  function accountEditRow(account) {
    const envCount = State.getServers().filter((s) => s.accountId === account.id).length;
    const fields = textField("id", "Account id")
      + textField("displayName", "Display name")
      + textField("repositories", "Repositories (comma separated)");
    return editRow("accounts", account.id, fields,
      `The display name is what Jira tickets are matched on. Repository changes apply to ${envCount} environment${envCount === 1 ? "" : "s"} under this account.`);
  }

  function userEditRow(user) {
    const fields = textField("name", "Display name") + textField("role", "Role");
    return editRow("users", user.id, fields,
      "The display name is what a ticket's Assignee label is matched against.");
  }

  function serverEditRow(server) {
    const draft = editing.draft;
    const accountOptions = State.getAccounts()
      .map((a) => `<option value="${escapeHtml(a.id)}"${a.id === draft.accountId ? " selected" : ""}>${escapeHtml(a.displayName)}</option>`)
      .join("");
    // Repo slots follow whichever account is picked in the row right now,
    // not the one the environment is currently under.
    const repoInputs = State.getRepositoriesForAccount(draft.accountId).map((r) => `
      <input type="text" data-repo="${escapeHtml(r)}" value="${escapeHtml(draft.repoUrls[r] || "")}" aria-label="${escapeHtml(r)} URL" placeholder="${escapeHtml(r)} URL (optional)" />
    `).join("");
    const fields = `
      <select name="accountId" aria-label="Account">${accountOptions}</select>
      ${textField("name", "Environment name")}
      <div class="repo-url-inputs">${repoInputs}</div>`;

    const newAccount = State.getAccount(draft.accountId);
    const movedAccount = draft.accountId !== server.accountId && newAccount;
    return editRow("servers", server.id, fields,
      movedAccount
        ? `Moving this environment to ${escapeHtml(newAccount.displayName)} rebuilds its repos from that account's list.`
        : "The environment name is the Branch that Jira tickets are matched on.");
  }

  function openEdit(list, id) {
    if (list === "accounts") {
      const account = State.getAccount(id);
      if (!account) return;
      startEdit(list, id, {
        id: account.id,
        displayName: account.displayName,
        repositories: account.repositories.join(", ")
      }, "displayName");
      return;
    }
    if (list === "users") {
      const user = State.getUser(id);
      if (!user) return;
      startEdit(list, id, { name: user.name, role: user.role }, "name");
      return;
    }
    const server = State.getServer(id);
    if (!server) return;
    const repoUrls = {};
    Object.keys(server.repos).forEach((r) => { repoUrls[r] = server.repos[r].url; });
    startEdit(list, id, { name: server.name, accountId: server.accountId, repoUrls }, "name");
  }

  // ---------- render ----------

  function render() {
    const editFocus = captureEditFocus();
    if (!editingEntityExists()) editing = null;

    const accountSelect = el("form-add-server-account");
    const previousAccountId = accountSelect.value;
    accountSelect.innerHTML = State.getAccounts()
      .map((a) => `<option value="${a.id}">${escapeHtml(a.displayName)}</option>`).join("");
    accountSelect.value = previousAccountId || State.getAccounts()[0]?.id || "";
    populateServerFormRepoUrlInputs(accountSelect.value);

    el("list-servers").innerHTML = State.getServers().map((s) => {
      if (isEditing("servers", s.id)) return serverEditRow(s);
      const account = State.getAccount(s.accountId);
      const repoSummary = Object.entries(s.repos).map(([name, r]) => `${name}${r.url ? "" : " (not configured)"}`).join(", ");
      const hasClaims = State.getServerTickets(s.id).length > 0;
      return `
      <li>
        <div class="config-item-main">
          <strong>${escapeHtml(s.name)}</strong>
          <span>${account ? escapeHtml(account.displayName) : "—"} · ${escapeHtml(repoSummary)} · ${STATUS_LABEL[State.getDisplayStatus(s)]}</span>
        </div>
        ${itemActions("servers", s.id, hasClaims ? "disabled title=\"Force-free active claims before removing\"" : "")}
      </li>
    `;
    }).join("") || `<li class="config-item-main">No environments configured.</li>`;

    el("list-users").innerHTML = State.getUsers().map((u) => {
      if (isEditing("users", u.id)) return userEditRow(u);
      return `
      <li>
        <div class="config-item-main">
          <strong>${escapeHtml(u.name)}</strong>
          <span>${escapeHtml(u.role)}</span>
        </div>
        ${itemActions("users", u.id)}
      </li>
    `;
    }).join("") || `<li class="config-item-main">No users configured.</li>`;

    el("list-accounts").innerHTML = State.getAccounts().map((a) => {
      if (isEditing("accounts", a.id)) return accountEditRow(a);
      const envCount = State.getServers().filter((s) => s.accountId === a.id).length;
      return `
      <li>
        <div class="config-item-main">
          <strong>${escapeHtml(a.displayName)}</strong>
          <span>${envCount} environment${envCount === 1 ? "" : "s"} · ${a.repositories.map(escapeHtml).join(", ")}</span>
        </div>
        ${itemActions("accounts", a.id)}
      </li>
    `;
    }).join("") || `<li class="config-item-main">No accounts configured.</li>`;

    restoreEditFocus(editFocus);
    setTab(activeTab);
  }

  // ---------- saving an edit row ----------

  function submitAccountEdit(accountId, fd) {
    const account = State.getAccount(accountId);
    if (!account) return;
    const values = {
      id: fd.get("id"),
      displayName: fd.get("displayName"),
      repositories: fd.get("repositories").split(",")
    };
    const nextRepos = values.repositories.map((r) => r.trim()).filter(Boolean);
    const removedRepos = account.repositories.filter((r) => !nextRepos.includes(r));
    const envCount = State.getServers().filter((s) => s.accountId === accountId).length;
    const apply = () => commitEdit(() => State.updateAccount(accountId, values));

    // Dropping a repo deletes its url, notes and any live booking on every
    // environment under the account — worth an explicit yes.
    if (removedRepos.length && envCount) {
      ConfirmModal.open({
        title: "Remove repositories?",
        message: `${removedRepos.join(", ")} will be removed from all ${envCount} environment${envCount === 1 ? "" : "s"} under ${account.displayName}, along with their URLs, notes and any active bookings on them.`,
        confirmLabel: "Remove & save",
        onConfirm: apply
      });
      return;
    }
    apply();
  }

  function submitServerEdit(serverId, form, fd) {
    const server = State.getServer(serverId);
    if (!server) return;
    const repoUrls = {};
    form.querySelectorAll("[data-repo]").forEach((input) => { repoUrls[input.dataset.repo] = input.value.trim(); });
    const values = { name: fd.get("name"), accountId: fd.get("accountId"), repoUrls };
    const apply = () => commitEdit(() => State.updateServer(serverId, values));

    // Moving to an account with a different repo list drops the repos that
    // account doesn't have — only worth asking about when that actually
    // costs something (a configured url, or a booking holding one of them).
    const nextRepos = State.getRepositoriesForAccount(values.accountId);
    const droppedRepos = Object.keys(server.repos).filter((r) => !nextRepos.includes(r));
    const losesUrls = droppedRepos.some((r) => server.repos[r].url);
    const losesClaims = State.getServerTickets(serverId).some((t) => t.repos.some((r) => droppedRepos.includes(r)));

    if (droppedRepos.length && (losesUrls || losesClaims)) {
      const account = State.getAccount(values.accountId);
      const one = droppedRepos.length === 1;
      ConfirmModal.open({
        title: "Move environment?",
        message: `${account ? account.displayName : "That account"} has no ${droppedRepos.join(", ")}, so ${one ? "that repo" : "those repos"} will be removed from ${server.name} along with ${one ? "its URL" : "their URLs"}, notes and any active bookings on ${one ? "it" : "them"}.`,
        confirmLabel: "Move & save",
        onConfirm: apply
      });
      return;
    }
    apply();
  }

  // ---------- events ----------

  function onListClick(e) {
    const target = e.target.closest("[data-action]");
    if (!target || target.disabled) return;
    const { action, list, id } = target.dataset;
    if (action === "cancel-edit") cancelEdit();
    else if (action === "edit") openEdit(list, id);
    else if (action === "remove") {
      if (list === "accounts") State.removeAccount(id);
      else if (list === "users") State.removeUser(id);
      else State.removeServer(id);
    }
  }

  function onListInput(e) {
    if (!editing) return;
    if (e.target.dataset.repo) editing.draft.repoUrls[e.target.dataset.repo] = e.target.value;
    else if (e.target.name in editing.draft) editing.draft[e.target.name] = e.target.value;
  }

  function onListChange(e) {
    if (!editing || e.target.name !== "accountId") return;
    editing.draft.accountId = e.target.value;
    render();
  }

  function onListSubmit(e) {
    const form = e.target.closest("form[data-edit-list]");
    if (!form) return;
    e.preventDefault();
    const { editList, editId } = form.dataset;
    const fd = new FormData(form);
    if (editList === "accounts") submitAccountEdit(editId, fd);
    else if (editList === "users") commitEdit(() => State.updateUser(editId, { name: fd.get("name"), role: fd.get("role") }));
    else submitServerEdit(editId, form, fd);
  }

  function bindEvents() {
    el("settings-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest(".tab-btn");
      if (!btn) return;
      setTab(btn.dataset.tab);
    });

    el("form-add-server-account").addEventListener("change", (e) => {
      populateServerFormRepoUrlInputs(e.target.value);
    });

    el("form-add-server").addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const repoUrls = {};
      e.target.querySelectorAll("#form-add-server-repo-urls input").forEach((input) => {
        repoUrls[input.dataset.repo] = input.value.trim();
      });
      State.addServer({
        name: fd.get("name").trim(),
        accountId: fd.get("accountId"),
        repoUrls
      });
      e.target.reset();
      populateServerFormRepoUrlInputs(el("form-add-server-account").value);
    });

    el("form-add-user").addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      State.addUser({ name: fd.get("name").trim(), role: fd.get("role").trim() });
      e.target.reset();
    });

    el("form-add-account").addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = fd.get("name").trim().toLowerCase().replace(/\s+/g, "-");
      const repositories = fd.get("repositories").split(",").map((r) => r.trim()).filter(Boolean);
      if (!name || !repositories.length) return;
      State.addAccount({ id: name, displayName: fd.get("displayName").trim(), repositories });
      e.target.reset();
    });

    LISTS.forEach((list) => {
      const node = el(LIST_ELEMENT_ID[list]);
      node.addEventListener("click", onListClick);
      node.addEventListener("input", onListInput);
      node.addEventListener("change", onListChange);
      node.addEventListener("submit", onListSubmit);
    });
  }

  return { render, setTab, populateServerFormRepoUrlInputs, bindEvents };
})();
