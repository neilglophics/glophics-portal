/**
 * One modal host, several shapes. Every dialog renders into `#modal-host`
 * and closes the same way (backdrop, ✕, Escape), so nothing else in the UI
 * has to know a dialog is open.
 *
 * Validation is not duplicated here — a form hands its payload to the
 * matching State.* mutator and renders whatever errors come back.
 */

const Modals = (() => {
  let submitHandler = null;

  function host() { return document.getElementById("modal-host"); }

  function open({ title, subtitle, body, submitLabel, variant = "dark", onSubmit, onReady, wide }) {
    submitHandler = onSubmit || null;
    host().innerHTML = `
      <div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:p-8"
           data-modal-backdrop>
        <div class="my-auto w-full ${wide ? "max-w-2xl" : "max-w-lg"} rounded-2xl bg-surface shadow-2xl">
          <div class="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
            <div>
              <h2 class="text-base font-bold tracking-tight">${H.esc(title)}</h2>
              ${subtitle ? `<p class="mt-0.5 text-xs text-faint">${H.esc(subtitle)}</p>` : ""}
            </div>
            <button type="button" data-modal-close
              class="grid h-8 w-8 shrink-0 place-items-center rounded-full text-faint transition hover:bg-subtle-2 hover:text-ink-2">
              ${H.icon("close", "h-4 w-4")}
            </button>
          </div>
          <form id="modal-form" class="px-6 py-5">
            ${body}
            <p id="modal-error" class="mt-4 hidden rounded-xl bg-bad-soft px-3.5 py-2.5 text-xs font-medium text-bad"></p>
            <div class="mt-6 flex justify-end gap-2">
              ${H.btn("Cancel", { variant: "ghost", data: { "data-modal-close": "" } })}
              <button type="submit"
                class="rounded-full px-4 py-2.5 text-xs font-semibold transition ${
                  variant === "danger" ? "bg-rose-600 text-white hover:bg-rose-700" : "bg-accent text-on-accent hover:bg-accent-2"}">
                ${H.esc(submitLabel || "Save")}</button>
            </div>
          </form>
        </div>
      </div>`;
    // Bodies whose fields depend on one another wire themselves up here.
    if (onReady) onReady(host());
    const first = host().querySelector("input:not([type=checkbox]), textarea, select");
    if (first) first.focus();
  }

  function close() {
    host().innerHTML = "";
    submitHandler = null;
  }

  function isOpen() { return !!host().innerHTML; }

  function showError(messages) {
    const el = document.getElementById("modal-error");
    if (!el) return;
    el.textContent = [].concat(messages).join(" ");
    el.classList.remove("hidden");
  }

  function formValues() {
    const form = document.getElementById("modal-form");
    const out = {};
    form.querySelectorAll("[name]").forEach((el) => {
      if (el.type === "checkbox") {
        if (!out[el.name]) out[el.name] = [];
        if (el.checked) out[el.name].push(el.value);
      } else if (el.type === "radio") {
        // Only the chosen one counts; every radio in the group would
        // otherwise overwrite it in turn, leaving whichever came last.
        if (el.checked) out[el.name] = el.value;
      } else {
        out[el.name] = el.value;
      }
    });
    return out;
  }

  // ---------- confirm ----------

  function confirm({ title, message, confirmLabel, onConfirm }) {
    open({
      title,
      body: `<p class="text-sm leading-relaxed text-body">${H.esc(message)}</p>`,
      submitLabel: confirmLabel || "Confirm",
      variant: "danger",
      onSubmit: () => { onConfirm(); close(); }
    });
  }

  // ---------- claim repositories ----------

  function toLocalInput(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function assign(serverId) {
    const server = State.getServer(serverId);
    if (!server) return;
    const row = Model.envRow(server);
    const settings = State.getSettings();
    const wholeEnv = settings.assignWholeEnv !== false;
    const users = State.getUsers();

    const end = new Date(Date.now() + (settings.defaultBookingHours || 4) * 3600000);

    const repoBoxes = row.repoNames.map((name) => {
      const taken = State.getRepoClaims(serverId, name);
      return `<label class="flex cursor-pointer items-center gap-2.5 rounded-xl bg-subtle px-3 py-2.5">
        <input type="checkbox" name="repos" value="${H.esc(name)}"
               ${!taken.length && wholeEnv ? "checked" : ""} class="h-4 w-4 rounded accent-brand-500" />
        <span class="text-sm font-medium capitalize text-ink-2">${H.esc(name)}</span>
        ${taken.length ? `<span class="ml-auto text-[10px] font-semibold text-warn">held ×${taken.length}</span>` : ""}
      </label>`;
    }).join("");

    const userBoxes = users.length ? users.map((u) => `
      <label class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition hover:bg-surface">
        <input type="checkbox" name="userIds" value="${H.esc(u.id)}" class="h-3.5 w-3.5 rounded accent-brand-500" />
        ${H.avatar(u, "h-6 w-6")}
        <span class="text-xs font-medium text-ink-2">${H.esc(u.name)}</span>
        <span class="ml-auto text-[10px] text-faint">${H.esc(u.role || "")}</span>
      </label>`).join("")
      : `<p class="px-2 py-3 text-xs text-faint">No users configured — add them in Settings.</p>`;

    open({
      title: "Claim repositories",
      subtitle: `${server.name} · ${row.accountName}`,
      wide: true,
      submitLabel: "Claim",
      body: `
        <div class="space-y-5">
          <div>
            <p class="pb-2 text-[11px] font-semibold text-muted">Which repositories</p>
            <div class="grid gap-2 sm:grid-cols-3">${repoBoxes}</div>
          </div>
          <div>
            <p class="pb-2 text-[11px] font-semibold text-muted">Who is holding it</p>
            <div class="max-h-40 space-y-0.5 overflow-y-auto rounded-xl bg-subtle p-2">${userBoxes}</div>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            ${H.field("Jira ticket", { data: { name: "jiraTicket" }, placeholder: "GLOP-1234" })}
            ${H.field("Note (optional)", { data: { name: "note" }, placeholder: "What's happening here?" })}
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="text-[11px] font-semibold text-muted">Start</span>
              <input type="datetime-local" name="startTime" value="${toLocalInput(new Date())}"
                class="mt-1.5 w-full rounded-xl bg-subtle px-3.5 py-2.5 text-sm text-ink-2 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-soft" />
            </label>
            <label class="block">
              <span class="text-[11px] font-semibold text-muted">Ends</span>
              <input type="datetime-local" name="endTime" value="${toLocalInput(end)}"
                class="mt-1.5 w-full rounded-xl bg-subtle px-3.5 py-2.5 text-sm text-ink-2 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-soft" />
            </label>
          </div>
        </div>`,
      onSubmit: () => {
        const v = formValues();
        const result = State.addClaim(serverId, {
          repos: v.repos || [],
          userIds: v.userIds || [],
          jiraTicket: v.jiraTicket,
          note: v.note,
          startTime: v.startTime ? new Date(v.startTime).toISOString() : null,
          endTime: v.endTime ? new Date(v.endTime).toISOString() : null
        });
        if (!result.ok) { showError(result.errors); return; }
        close();
      }
    });
  }

  // ---------- per-repo note ----------

  function note(serverId, repoName) {
    const server = State.getServer(serverId);
    if (!server) return;
    open({
      title: "Note",
      subtitle: `${server.name} · ${repoName}`,
      submitLabel: "Save note",
      body: `<textarea name="note" rows="4" placeholder="What's deployed, gotchas, who to ping."
        class="w-full rounded-xl bg-subtle px-3.5 py-2.5 text-sm text-ink-2 placeholder:text-faintest focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-soft"
        >${H.esc(State.getRepoNote(serverId, repoName))}</textarea>`,
      onSubmit: () => {
        State.setRepoNote(serverId, repoName, formValues().note);
        close();
      }
    });
  }

  // ---------- repo URL ----------

  function repoUrl(serverId, repoName) {
    const server = State.getServer(serverId);
    if (!server) return;
    open({
      title: "Set repository URL",
      subtitle: `${server.name} · ${repoName}`,
      submitLabel: "Save URL",
      body: H.field("URL", {
        data: { name: "url" },
        value: server.repos[repoName] ? server.repos[repoName].url : "",
        placeholder: "https://…"
      }),
      onSubmit: () => {
        const url = (formValues().url || "").trim();
        if (!url) { showError("Enter a URL, or cancel."); return; }
        State.updateServerRepoUrl(serverId, repoName, url);
        close();
      }
    });
  }

  // ---------- add a directory entry (Settings) ----------

  // Each account carries its own repository list, so the URL fields on the
  // environment form are rebuilt whenever the account picker changes.
  function repoUrlFields(repoNames) {
    if (!repoNames.length) {
      return `<p class="rounded-xl bg-subtle px-3.5 py-2.5 text-xs text-faint">This account has no repositories yet.</p>`;
    }
    return `<div class="grid gap-3 sm:grid-cols-2">${repoNames.map((name) =>
      H.field(`${name.charAt(0).toUpperCase() + name.slice(1)} URL`, {
        data: { name: `url:${name}` }, placeholder: "https://…"
      })).join("")}</div>`;
  }

  function collectRepoUrls(values) {
    const urls = {};
    Object.keys(values).forEach((key) => {
      if (key.startsWith("url:")) urls[key.slice(4)] = values[key];
    });
    return urls;
  }

  function addAccount() {
    open({
      title: "Add account",
      subtitle: "A client or brand. Its repositories become the slots every environment under it carries.",
      submitLabel: "Add account",
      body: `
        <div class="space-y-4">
          ${H.field("Display name", { data: { name: "displayName" }, placeholder: "e.g. Northgate" })}
          ${H.field("Repositories", { data: { name: "repositories" }, value: "storefront, backend, admin" })}
          <p class="text-[11px] leading-relaxed text-faint">
            Comma separated. Jira matches tickets on the display name, so use the one your team writes on the board.</p>
        </div>`,
      onSubmit: () => {
        const v = formValues();
        const result = State.addAccount({
          displayName: v.displayName,
          repositories: (v.repositories || "").split(",")
        });
        if (!result.ok) { showError(result.errors); return; }
        close();
      }
    });
  }

  function addUser() {
    open({
      title: "Add user",
      subtitle: "Their display name is what Jira's assignee labels are matched against.",
      submitLabel: "Add user",
      body: `<div class="grid gap-3 sm:grid-cols-2">
        ${H.field("Display name", { data: { name: "name" }, placeholder: "e.g. [BE]_Sem" })}
        ${H.field("Role", { data: { name: "role" }, value: "Team", placeholder: "e.g. Backend" })}
      </div>`,
      onSubmit: () => {
        const v = formValues();
        const result = State.addUser({ name: v.name, role: v.role });
        if (!result.ok) { showError(result.errors); return; }
        close();
      }
    });
  }

  function addServer() {
    const accounts = State.getAccounts();

    // An environment cannot exist without an account to hang it on, so say
    // so outright rather than opening a form that can only fail.
    if (!accounts.length) {
      open({
        title: "Add environment",
        submitLabel: "Got it",
        body: `<p class="text-sm leading-relaxed text-body">
          Add an account first — every environment belongs to one, and the account's repository list
          decides which slots the environment carries.</p>`,
        onSubmit: close
      });
      return;
    }

    open({
      title: "Add environment",
      subtitle: "Its name is the branch Jira matches on.",
      submitLabel: "Add environment",
      wide: true,
      body: `
        <div class="space-y-5">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="text-[11px] font-semibold text-muted">Account</span>
              <select name="accountId" data-account-picker
                class="mt-1.5 w-full rounded-xl bg-subtle px-3.5 py-2.5 text-sm text-ink-2 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-soft">
                ${accounts.map((a) => `<option value="${H.esc(a.id)}">${H.esc(a.displayName)}</option>`).join("")}
              </select>
            </label>
            ${H.field("Environment name", { data: { name: "name" }, placeholder: "e.g. hotfix-4" })}
          </div>
          <div>
            <p class="pb-2 text-[11px] font-semibold text-muted">
              Repository URLs <span class="font-medium text-faint">— optional, health checks start once a URL is set</span></p>
            <div data-repo-urls>${repoUrlFields(State.getRepositoriesForAccount(accounts[0].id))}</div>
          </div>
        </div>`,
      onReady: (root) => {
        const picker = root.querySelector("[data-account-picker]");
        const slot = root.querySelector("[data-repo-urls]");
        picker.addEventListener("change", () => {
          slot.innerHTML = repoUrlFields(State.getRepositoriesForAccount(picker.value));
        });
      },
      onSubmit: () => {
        const v = formValues();
        const result = State.addServer({ name: v.name, accountId: v.accountId, repoUrls: collectRepoUrls(v) });
        if (!result.ok) { showError(result.errors); return; }
        close();
      }
    });
  }

  // The three directory tabs share one Add button; this picks its form.
  function directoryAdd(tab) {
    if (tab === "users") addUser();
    else if (tab === "servers") addServer();
    else addAccount();
  }

  // ---------- sign-in credentials (super admin) ----------

  // A role is picked from cards rather than a <select> so what each one
  // actually allows is on screen at the moment it is handed out.
  function roleChooser(selectedId) {
    return `<div class="space-y-2">${Auth.roles().map((role) => `
      <label class="flex cursor-pointer items-start gap-3 rounded-xl bg-subtle p-3 transition hover:bg-subtle-2">
        <input type="radio" name="role" value="${H.esc(role.id)}"
               ${role.id === selectedId ? "checked" : ""} class="mt-0.5 h-4 w-4 accent-brand-500" />
        <span class="min-w-0">
          <span class="block text-sm font-semibold text-ink-2">${H.esc(role.label)}</span>
          <span class="block text-[11px] leading-relaxed text-faint">${H.esc(role.description)}</span>
        </span>
      </label>`).join("")}</div>`;
  }

  function passwordPair(labels) {
    return `<div class="grid gap-3 sm:grid-cols-2">
      ${H.field(labels[0], { type: "password", data: { name: "password", autocomplete: "new-password" }, placeholder: "At least 8 characters" })}
      ${H.field(labels[1], { type: "password", data: { name: "confirm", autocomplete: "new-password" }, placeholder: "Type it again" })}
    </div>`;
  }

  // Both password forms check the pair match here; everything else about a
  // password (length, whether the current one is right) is the server's
  // call, and its message is what gets shown.
  function passwordsMatch(values) {
    if (!values.password) { showError("Enter a password."); return false; }
    if (values.password !== values.confirm) { showError("Those two passwords do not match."); return false; }
    return true;
  }

  function authUserAdd(onDone) {
    open({
      title: "Add user",
      subtitle: "Creates the credentials they sign in with, and the role that decides what they can do.",
      submitLabel: "Create user",
      wide: true,
      body: `
        <div class="space-y-5">
          <div class="grid gap-3 sm:grid-cols-2">
            ${H.field("Display name", { data: { name: "displayName" }, placeholder: "e.g. Jerome Cruz" })}
            ${H.field("Username", { data: { name: "username", autocapitalize: "none", spellcheck: "false" }, placeholder: "e.g. jerome" })}
          </div>
          ${passwordPair(["Password", "Confirm password"])}
          <div>
            <p class="pb-2 text-[11px] font-semibold text-muted">Role</p>
            ${roleChooser("member")}
          </div>
        </div>`,
      onSubmit: async () => {
        const v = formValues();
        if (!passwordsMatch(v)) return;
        const result = await Auth.createUser({
          displayName: v.displayName, username: v.username,
          role: v.role, password: v.password
        });
        if (!result.ok) { showError(result.errors || result.error || "Couldn't create that user."); return; }
        close();
        if (onDone) onDone();
      }
    });
  }

  function authUserEdit(user, onDone) {
    open({
      title: "Edit user",
      subtitle: `@${user.username}`,
      submitLabel: "Save changes",
      wide: true,
      body: `
        <div class="space-y-5">
          <div class="grid gap-3 sm:grid-cols-2">
            ${H.field("Display name", { data: { name: "displayName" }, value: user.displayName })}
            ${H.field("Username", { data: { name: "username", autocapitalize: "none", spellcheck: "false" }, value: user.username })}
          </div>
          <div>
            <p class="pb-2 text-[11px] font-semibold text-muted">Role</p>
            ${roleChooser(user.role)}
          </div>
          <div class="rounded-xl bg-subtle p-3">
            ${H.checkbox("Account is active", "Turning this off signs them out and blocks them from signing back in.",
              user.active !== false, { name: "active", value: "on" })}
          </div>
        </div>`,
      onSubmit: async () => {
        const v = formValues();
        const result = await Auth.updateUser(user.id, {
          displayName: v.displayName, username: v.username,
          role: v.role, active: !!(v.active && v.active.length)
        });
        if (!result.ok) { showError(result.errors || result.error || "Couldn't save that user."); return; }
        close();
        if (onDone) onDone();
      }
    });
  }

  function authUserPassword(user, onDone) {
    open({
      title: "Reset password",
      subtitle: `${user.displayName} · @${user.username}`,
      submitLabel: "Set password",
      body: `
        <div class="space-y-4">
          <p class="text-sm leading-relaxed text-body">
            Sets a new password without needing the old one, and signs
            ${H.esc(user.displayName)} out everywhere. Pass it on yourself — it is not shown again.
          </p>
          ${passwordPair(["New password", "Confirm password"])}
        </div>`,
      onSubmit: async () => {
        const v = formValues();
        if (!passwordsMatch(v)) return;
        const result = await Auth.setPassword(user.id, v.password);
        if (!result.ok) { showError(result.errors || result.error || "Couldn't set that password."); return; }
        close();
        if (onDone) onDone();
      }
    });
  }

  // Anyone changing their own password — the one credential action that
  // isn't limited to a super admin.
  function changeOwnPassword() {
    open({
      title: "Change password",
      subtitle: `Signed in as @${Auth.user().username}`,
      submitLabel: "Change password",
      body: `
        <div class="space-y-4">
          ${H.field("Current password", { type: "password", data: { name: "currentPassword", autocomplete: "current-password" } })}
          ${passwordPair(["New password", "Confirm new password"])}
        </div>`,
      onSubmit: async () => {
        const v = formValues();
        if (!passwordsMatch(v)) return;
        const result = await Auth.changeOwnPassword(v.currentPassword, v.password);
        if (!result.ok) { showError(result.errors || result.error || "Couldn't change your password."); return; }
        close();
      }
    });
  }

  // A dead end with nothing to fill in — used when an action is refused.
  function info({ title, message }) {
    open({
      title,
      body: `<p class="text-sm leading-relaxed text-body">${H.esc(message)}</p>`,
      submitLabel: "Got it",
      onSubmit: close
    });
  }

  // ---------- wiring ----------

  function bind() {
    host().addEventListener("click", (e) => {
      if (e.target.closest("[data-modal-close]")) { close(); return; }
      if (e.target.hasAttribute && e.target.hasAttribute("data-modal-backdrop")) close();
    });
    host().addEventListener("submit", (e) => {
      e.preventDefault();
      if (submitHandler) submitHandler();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen()) close();
    });
  }

  return {
    open, close, isOpen, showError, confirm, info,
    assign, note, repoUrl, directoryAdd,
    authUserAdd, authUserEdit, authUserPassword, changeOwnPassword,
    bind
  };
})();
