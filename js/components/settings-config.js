/**
 * Settings → Accounts / Users / Servers tabs: the add-forms and the
 * removable config lists.
 */

const SettingsConfig = (() => {
  const { escapeHtml, STATUS_LABEL } = Format;
  function el(id) { return document.getElementById(id); }

  let activeTab = "accounts";

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

  function render() {
    const accountSelect = el("form-add-server-account");
    const previousAccountId = accountSelect.value;
    accountSelect.innerHTML = State.getAccounts()
      .map((a) => `<option value="${a.id}">${escapeHtml(a.displayName)}</option>`).join("");
    accountSelect.value = previousAccountId || State.getAccounts()[0]?.id || "";
    populateServerFormRepoUrlInputs(accountSelect.value);

    el("list-servers").innerHTML = State.getServers().map((s) => {
      const account = State.getAccount(s.accountId);
      const repoSummary = Object.entries(s.repos).map(([name, r]) => `${name}${r.url ? "" : " (not configured)"}`).join(", ");
      const hasClaims = State.getServerTickets(s.id).length > 0;
      return `
      <li>
        <div class="config-item-main">
          <strong>${escapeHtml(s.name)}</strong>
          <span>${account ? escapeHtml(account.displayName) : "—"} · ${escapeHtml(repoSummary)} · ${STATUS_LABEL[State.getDisplayStatus(s)]}</span>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="remove-server" data-id="${s.id}" ${hasClaims ? "disabled title=\"Force-free active claims before removing\"" : ""}>Remove</button>
      </li>
    `;
    }).join("") || `<li class="config-item-main">No environments configured.</li>`;

    el("list-users").innerHTML = State.getUsers().map((u) => `
      <li>
        <div class="config-item-main">
          <strong>${escapeHtml(u.name)}</strong>
          <span>${escapeHtml(u.role)}</span>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="remove-user" data-id="${u.id}">Remove</button>
      </li>
    `).join("") || `<li class="config-item-main">No users configured.</li>`;

    el("list-accounts").innerHTML = State.getAccounts().map((a) => {
      const envCount = State.getServers().filter((s) => s.accountId === a.id).length;
      return `
      <li>
        <div class="config-item-main">
          <strong>${escapeHtml(a.displayName)}</strong>
          <span>${envCount} environment${envCount === 1 ? "" : "s"} · ${a.repositories.map(escapeHtml).join(", ")}</span>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="remove-account" data-id="${a.id}">Remove</button>
      </li>
    `;
    }).join("") || `<li class="config-item-main">No accounts configured.</li>`;

    setTab(activeTab);
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

    el("list-servers").addEventListener("click", (e) => {
      const target = e.target.closest("[data-action='remove-server']");
      if (!target || target.disabled) return;
      State.removeServer(target.dataset.id);
    });
    el("list-users").addEventListener("click", (e) => {
      const target = e.target.closest("[data-action='remove-user']");
      if (!target) return;
      State.removeUser(target.dataset.id);
    });
    el("list-accounts").addEventListener("click", (e) => {
      const target = e.target.closest("[data-action='remove-account']");
      if (!target) return;
      State.removeAccount(target.dataset.id);
    });
  }

  return { render, setTab, populateServerFormRepoUrlInputs, bindEvents };
})();
