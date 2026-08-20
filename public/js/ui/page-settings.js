/**
 * Jira connection, the rules that claim and free a server, booking defaults,
 * and the two directories.
 *
 * People used to be a third tab here. They are on the Users page now,
 * beside the sign-in accounts that point at them — one list, edited once.
 *
 * Directory rows edit in place; adding one opens a modal. All writes go
 * through State.* — this file never touches appData, and never persists
 * anything itself.
 */

// Which directory tab is open, which row is being edited, and the last
// validation message. This is view state, not app data, so it deliberately
// does not live in State and is never persisted.
const SettingsUi = { tab: "accounts", editing: null, error: null };

Router.register("settings", (() => {
  const ui = SettingsUi;

  // Credentials live server-side and are fetched once per page visit.
  let jiraConfig = null;
  let fetching = false;

  const TABS = [["accounts", "Accounts"], ["servers", "Servers"]];

  // ---------- directories ----------

  function directoryRows() {
    if (ui.tab === "servers") {
      return State.getServers().map((s) => {
        const account = State.getAccount(s.accountId);
        const repoNames = Object.keys(s.repos);
        const configured = repoNames.filter((r) => s.repos[r].url).length;
        return {
          key: "server:" + s.id,
          title: s.name,
          meta: `${account ? account.displayName : "—"} · ${configured}/${repoNames.length} URLs set`,
          fields:
            `<label class="block">
               <span class="text-[11px] font-semibold text-muted">Account</span>
               <select data-field="accountId"
                 class="mt-1.5 w-full rounded-xl bg-surface px-3 py-2.5 text-sm text-ink-2 ring-1 ring-line-2 focus:outline-none focus:ring-2 focus:ring-brand-soft">
                 ${State.getAccounts().map((a) =>
                   `<option value="${H.esc(a.id)}" ${a.id === s.accountId ? "selected" : ""}>${H.esc(a.displayName)}</option>`).join("")}
               </select>
             </label>` +
            H.field("Environment name", { value: s.name, data: { "data-field": "name" } }) +
            repoNames.map((r) => H.field(`${r.charAt(0).toUpperCase() + r.slice(1)} URL`, {
              value: s.repos[r].url || "", placeholder: "https://…", span: true,
              data: { "data-field": "url", "data-repo": r }
            })).join("")
        };
      });
    }

    return State.getAccounts().map((a) => {
      const envCount = State.getServers().filter((s) => s.accountId === a.id).length;
      return {
        key: "account:" + a.id,
        title: a.displayName,
        meta: `${envCount} environment${envCount === 1 ? "" : "s"} · ${a.repositories.join(", ")}`,
        fields: H.field("Display name", { value: a.displayName, data: { "data-field": "displayName" } }) +
                H.field("Repositories", { value: a.repositories.join(", "), data: { "data-field": "repositories" } })
      };
    });
  }

  function directoryRow(row) {
    const open = ui.editing === row.key;
    return `
      <div class="py-3" data-dir-row="${H.esc(row.key)}">
        <div class="flex items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-3">
            ${row.leading || ""}
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold">${H.esc(row.title)}</p>
              <p class="truncate text-[11px] text-faint">${H.esc(row.meta)}</p>
            </div>
          </div>
          <div class="flex shrink-0 gap-2">
            <button data-action="dir-edit" data-key="${H.esc(row.key)}"
              class="rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
                open ? "bg-brand-soft text-brand-fg ring-1 ring-brand-soft"
                     : "text-muted ring-1 ring-line-2 hover:bg-brand-soft hover:text-brand-fg hover:ring-brand-soft"}">Edit</button>
            <button data-action="dir-remove" data-key="${H.esc(row.key)}"
              class="rounded-full px-3 py-1.5 text-[11px] font-semibold text-muted ring-1 ring-line-2 transition hover:bg-bad-soft hover:text-bad hover:ring-bad-soft">Remove</button>
          </div>
        </div>
        ${open ? `
          <div class="mt-3 rounded-xl bg-subtle p-3">
            <div class="grid gap-2.5 sm:grid-cols-2">${row.fields}</div>
            ${ui.error ? `<p class="mt-2.5 rounded-lg bg-bad-soft px-3 py-2 text-[11px] font-medium text-bad">${H.esc(ui.error)}</p>` : ""}
            <div class="mt-3 flex justify-end gap-2">
              <button data-action="dir-cancel"
                class="rounded-full bg-surface px-3.5 py-1.5 text-[11px] font-semibold text-muted ring-1 ring-line-2 transition hover:text-ink-2">Cancel</button>
              <button data-action="dir-save" data-key="${H.esc(row.key)}"
                class="rounded-full bg-accent px-3.5 py-1.5 text-[11px] font-semibold text-on-accent transition hover:bg-accent-2">Save</button>
            </div>
          </div>` : ""}
      </div>`;
  }

  const ADD_LABEL = { accounts: "Add account", servers: "Add environment" };

  function directories() {
    const rows = directoryRows();
    return `
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex min-w-[220px] flex-1 gap-1 rounded-xl bg-subtle-2 p-1">
          ${TABS.map(([key, label]) => `
            <button data-action="dir-tab" data-tab="${key}"
              class="flex-1 rounded-lg px-3 py-1.5 text-xs transition ${
                ui.tab === key ? "bg-surface font-semibold text-ink shadow-sm" : "font-medium text-muted hover:text-ink-2"}">${label}</button>`).join("")}
        </div>
        ${H.btn(ADD_LABEL[ui.tab], { variant: "dark", size: "sm", data: { "data-action": "dir-add" } })}
      </div>
      <div class="mt-3 max-h-[420px] divide-y divide-line-soft overflow-y-auto no-scrollbar">
        ${rows.length ? rows.map(directoryRow).join("") : `<p class="py-6 text-center text-xs text-faint">Nothing here yet.</p>`}
      </div>`;
  }

  // ---------- jira ----------

  function jiraCard() {
    const jira = State.getSettings().jira;
    const managed = jiraConfig && jiraConfig.managedByEnv;

    const options = [
      ["requireTicket", "Require a ticket key when claiming", "Blocks a manual claim with no Jira reference."],
      ["pullTicketInfo", "Pull ticket title and assignee", "Shows the summary next to the booking."],
      ["commentOnRelease", "Comment on the ticket when force-freed", "Posts environment and duration back to Jira."]
    ];

    return H.card("Jira integration", "Link bookings to tickets so the board fills itself in.", `
      <div class="flex items-center justify-between gap-4 rounded-xl bg-subtle p-4">
        <div class="min-w-0">
          <p class="text-sm font-bold">Enable Jira</p>
          <p class="truncate text-xs text-faint">${H.esc(
            !jira.enabled ? "Off — ticket keys entered by hand"
            : jiraConfig && jiraConfig.baseUrl ? `Connected to ${jiraConfig.baseUrl.replace(/^https?:\/\//, "")}`
            : "On — add your site URL and token below")}</p>
        </div>
        ${H.toggle(jira.enabled, { "data-action": "jira-enabled" })}
      </div>

      ${managed ? `<p class="mt-4 rounded-xl bg-brand-soft px-3.5 py-2.5 text-[11px] font-medium text-brand-fg">
        Credentials come from this deployment's environment variables, so they are read-only here.</p>` : ""}

      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        ${H.field("Site URL", { value: jiraConfig ? jiraConfig.baseUrl : "", placeholder: "your-site.atlassian.net", data: { id: "jira-base-url", disabled: managed || undefined } })}
        ${H.field("Email", { value: jiraConfig ? jiraConfig.email : "", placeholder: "you@company.com", data: { id: "jira-email", disabled: managed || undefined } })}
        ${H.field("API token", { type: "password", placeholder: jiraConfig && jiraConfig.hasToken ? "Leave blank to keep current token" : "Paste your API token", data: { id: "jira-token", disabled: managed || undefined } })}
        ${H.field("Ticket key format", { value: "", placeholder: "GLOP-####", data: { disabled: "true" } })}
      </div>

      <div class="mt-5 space-y-3">
        ${options.map(([key, label, hint]) =>
          H.checkbox(label, hint, !!jira[key], { "data-change": "jira-option", "data-key": key })).join("")}
      </div>

      ${managed ? "" : `
      <div class="mt-5 flex flex-wrap gap-2">
        ${H.btn("Save connection", { variant: "dark", data: { "data-action": "jira-save" } })}
        ${H.btn("Test connection", { data: { "data-action": "jira-test" } })}
        <span id="jira-result" class="self-center text-xs font-medium"></span>
      </div>`}`);
  }

  /**
   * What "never fetched" costs, said plainly under the three lists.
   *
   * A status can be ticked in two columns at once and the sync will do
   * exactly what the ticks say — which for a status that is both occupying
   * and never fetched means it can never claim anything, because the
   * ticket is never pulled. That is a real setting, not an error, so this
   * says what will happen rather than refusing it.
   */
  function fetchNote(jira) {
    const ignored = jira.ignoredStatuses || [];
    if (!ignored.length) {
      return `<p class="pt-3 text-[11px] text-faint">
        Every status is fetched. Anything not occupying or releasing is listed on the ticket
        pages without holding a repository.</p>`;
    }
    const clash = ignored.filter((s) => (jira.occupyingStatuses || []).includes(s));
    return `
      <p class="pt-3 text-[11px] leading-relaxed text-faint">
        ${H.esc(ignored.join(", "))} ${ignored.length === 1 ? "is" : "are"} left out of the Jira
        query, so ${ignored.length === 1 ? "it" : "they"} cost nothing to sync and appear nowhere.
        A ticket already holding repositories is still fetched by key whatever status it reaches,
        so a claim can always be freed.
      </p>
      ${clash.length ? `<p class="pt-2 text-[11px] font-semibold leading-relaxed text-warn">
        ${H.esc(clash.join(", "))} ${clash.length === 1 ? "is" : "are"} also marked as occupying.
        A ticket at ${clash.length === 1 ? "that status" : "those statuses"} is never pulled, so it
        will never claim an environment — untick it in one column or the other.</p>` : ""}`;
  }

  function statusRulesCard() {
    const jira = State.getSettings().jira;
    // A finished or cancelled ticket frees its environment and can never
    // take one, whatever these lists say — so rather than offer a box that
    // decides nothing, those two columns show the answer and say why.
    const fixed = (kind, status) => {
      if (!statusIsTerminal(status)) return null;
      if (kind === "releasing") return { on: true, tag: "always", why: "A finished or cancelled ticket always frees its environment." };
      if (kind === "occupying") return { on: false, tag: "never", why: "A finished or cancelled ticket can't hold an environment." };
      return null;
    };

    const list = (selected, kind) => `
      <div class="max-h-44 space-y-1 overflow-y-auto rounded-xl bg-subtle p-2 no-scrollbar">
        ${JIRA_STATUS_VOCABULARY.map((status) => {
          const locked = fixed(kind, status);
          const on = locked ? locked.on : selected.includes(status);
          return `<label title="${H.esc(locked ? locked.why : "")}"
            class="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition ${
              locked ? "cursor-default" : "cursor-pointer hover:bg-surface"}">
            <input type="checkbox" ${on ? "checked" : ""} ${locked ? "disabled" : ""}
                   data-change="status-rule" data-kind="${kind}" data-status="${H.esc(status)}"
                   class="h-3.5 w-3.5 rounded accent-brand-500 ${locked ? "opacity-50" : ""}" />
            <span class="text-[11px] font-medium ${
              locked ? "text-faint" : on ? "text-ink" : "text-muted"}">${H.esc(status)}</span>
            ${locked ? `<span class="ml-auto text-[9px] font-bold uppercase tracking-wide text-faintest">${locked.tag}</span>` : ""}
          </label>`;
        }).join("")}
      </div>`;

    return H.card("Status rules",
      "A ticket claims its repositories on reaching an occupying status and frees them on a releasing one; any other status leaves an active claim alone. A status marked never fetched is not asked of Jira at all.",
      `
      <div class="grid gap-4 sm:grid-cols-3">
        <div>
          <p class="pb-2 text-[11px] font-semibold text-muted">Occupies a server</p>
          ${list(jira.occupyingStatuses || [], "occupying")}
        </div>
        <div>
          <p class="pb-2 text-[11px] font-semibold text-muted">Frees the server</p>
          ${list(jira.releasingStatuses || [], "releasing")}
        </div>
        <div>
          <p class="pb-2 text-[11px] font-semibold text-muted">Never fetched</p>
          ${list(jira.ignoredStatuses || [], "ignored")}
        </div>
      </div>
      <p class="pt-3 text-[11px] leading-relaxed text-faint">
        ${H.esc(JIRA_TERMINAL_STATUSES.join(", "))} are decided for you: a ticket that has been
        finished or cancelled frees whatever it was holding on the next sync, and can never take
        an environment. Nothing is left booked in the name of a ticket nobody will come back to.
      </p>
      ${fetchNote(jira)}
      <div class="mt-4">
        ${H.select("Poll interval", [1, 5, 15, 30].map((m) => ({ value: String(m), label: `Every ${m} minute${m === 1 ? "" : "s"}` })),
          { value: String(jira.pollIntervalMinutes || 1), data: { "data-change": "poll-interval" } })}
      </div>`);
  }

  function bookingCard() {
    const s = State.getSettings();
    return H.card("Booking rules", "", `
      <div class="space-y-4">
        ${H.select("Default booking length", [4, 8, 24, 48].map((h) => ({ value: String(h), label: `${h} hours` })),
          { value: String(s.defaultBookingHours || 4), data: { "data-change": "booking-length" } })}
        ${H.select("When time runs out", [
            { value: "remind", label: "Remind the holder" },
            { value: "remind-flag", label: "Remind and flag the row" },
            { value: "auto-release", label: "Auto-release" }
          ], { value: s.onExpiry || "remind", data: { "data-change": "on-expiry" } })}
        <label class="flex items-center justify-between gap-4">
          <span class="text-sm text-body">Assign whole environment at once</span>
          ${H.toggle(s.assignWholeEnv !== false, { "data-action": "toggle-assign-whole" })}
        </label>
      </div>`);
  }

  return {
    label: "Settings",

    render() {
      // Reachable by typing the hash even with the nav entry hidden, so the
      // page says no itself rather than painting controls that are refused.
      if (!Auth.can("configure")) {
        return H.page(
          H.pageHead("Settings", "Jira connection, status rules and directories", "") +
          H.empty("Your role can see the board but not change how it is set up. Ask an admin.")
        );
      }
      return H.page(`
        ${H.pageHead("Settings", "Jira connection, the rules that claim and free a server, and your directories", "")}
        <div class="grid grid-cols-1 items-start gap-5 xl:grid-cols-[1.15fr_1fr]">
          <div class="space-y-5">${jiraCard()}${statusRulesCard()}</div>
          <div class="space-y-5">${bookingCard()}${H.card("Directories", "", directories())}</div>
        </div>`);
    },

    // Credentials are server-side, so the first paint has no config yet.
    mount() {
      if (jiraConfig || fetching || !Auth.can("configure")) return;
      fetching = true;
      fetch("/api/jira-config")
        .then((r) => r.json())
        .then((config) => { jiraConfig = config; fetching = false; Router.render(); })
        .catch(() => { jiraConfig = { baseUrl: "", email: "", hasToken: false }; fetching = false; });
    },

    ui
  };
})());

/* ─────────────  settings actions  ───────────── */

(() => {
  Actions.on("dir-tab", (el) => { setUi({ tab: el.dataset.tab, editing: null, error: null }); });
  Actions.on("dir-edit", (el) => {
    const u = getUi();
    setUi({ editing: u.editing === el.dataset.key ? null : el.dataset.key, error: null });
  });
  Actions.on("dir-cancel", () => setUi({ editing: null, error: null }));

  Actions.on("dir-remove", (el) => {
    const [kind, id] = splitKey(el.dataset.key);
    const label = describe(kind, id);
    Modals.confirm({
      title: `Remove ${label}?`,
      message: removalWarning(kind, id),
      confirmLabel: "Remove",
      onConfirm: () => {
        if (kind === "account") State.removeAccount(id);
        else State.removeServer(id);
        setUi({ editing: null, error: null });
      }
    });
  });

  Actions.on("dir-save", (el) => {
    const key = el.dataset.key;
    const [kind, id] = splitKey(key);
    const row = document.querySelector(`[data-dir-row="${cssEscape(key)}"]`);
    if (!row) return;
    const val = (name) => {
      const node = row.querySelector(`[data-field="${name}"]`);
      return node ? node.value.trim() : "";
    };

    let result;
    if (kind === "account") {
      result = State.updateAccount(id, {
        displayName: val("displayName"),
        repositories: val("repositories").split(",").map((r) => r.trim()).filter(Boolean)
      });
    } else {
      const repoUrls = {};
      row.querySelectorAll('[data-field="url"]').forEach((node) => { repoUrls[node.dataset.repo] = node.value.trim(); });
      result = State.updateServer(id, { name: val("name"), accountId: val("accountId"), repoUrls });
    }

    if (result && result.ok === false) setUi({ error: (result.errors || ["Could not save."]).join(" ") });
    else setUi({ editing: null, error: null });
  });

  // The form lives in a modal so every field an entry needs — an account's
  // repositories, an environment's URLs — has room, and so a half-filled
  // one is not wiped by the repaint another viewer's edit triggers.
  Actions.on("dir-add", () => {
    Modals.directoryAdd(getUi().tab);
    setUi({ editing: null, error: null });
  });

  // ---------- settings toggles ----------

  Actions.on("jira-enabled", () => State.updateJiraOptions({ enabled: !State.getSettings().jira.enabled }));
  Actions.on("toggle-assign-whole", () => State.updateSettings({ assignWholeEnv: State.getSettings().assignWholeEnv === false }));

  Actions.onChange("jira-option", (el) => State.updateJiraOptions({ [el.dataset.key]: el.checked }));
  Actions.onChange("poll-interval", (el) => State.updateJiraOptions({ pollIntervalMinutes: Number(el.value) }));
  Actions.onChange("booking-length", (el) => State.updateSettings({ defaultBookingHours: Number(el.value) }));
  Actions.onChange("on-expiry", (el) => State.updateSettings({ onExpiry: el.value }));

  const STATUS_RULE_KEYS = {
    occupying: "occupyingStatuses",
    releasing: "releasingStatuses",
    ignored: "ignoredStatuses"
  };

  Actions.onChange("status-rule", (el) => {
    const jira = State.getSettings().jira;
    const key = STATUS_RULE_KEYS[el.dataset.kind];
    if (!key) return;
    const current = new Set(jira[key] || []);
    if (el.checked) current.add(el.dataset.status); else current.delete(el.dataset.status);
    State.updateJiraOptions({ [key]: [...current] });
  });

  // ---------- jira credentials ----------

  Actions.on("jira-save", async (el) => {
    const get = (id) => (document.getElementById(id) || {}).value || "";
    await Actions.withPending(el, "Saving…", async () => {
      try {
        const res = await fetch("/api/jira-config", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            ...(typeof Auth !== "undefined" ? Auth.csrfHeader("POST") : {})
          },
          body: JSON.stringify({
            baseUrl: get("jira-base-url").trim(),
            email: get("jira-email").trim(),
            apiToken: get("jira-token").trim()
          })
        });
        const data = await res.json();
        showResult(data.ok ? "Saved." : (data.error || "Couldn't save."), data.ok);
      } catch (err) {
        showResult("Couldn't reach the server.", false);
      }
    });
  });

  Actions.on("jira-test", async (el) => {
    await Actions.withPending(el, "Testing…", async () => {
      try {
        const data = await fetch("/api/jira-config/test", {
          method: "POST",
          credentials: "same-origin",
          headers: typeof Auth !== "undefined" ? Auth.csrfHeader("POST") : {}
        }).then((r) => r.json());
        showResult(data.ok ? `Connected as ${data.displayName}.` : data.error, data.ok);
      } catch (err) {
        showResult("Couldn't reach the server.", false);
      }
    });
  });

  function showResult(message, ok) {
    const el = document.getElementById("jira-result");
    if (el) {
      el.textContent = message;
      el.className = `self-center text-xs font-medium ${ok ? "text-ok" : "text-bad"}`;
    }
  }

  // ---------- helpers ----------

  function getUi() { return SettingsUi; }
  function setUi(patch) { Object.assign(SettingsUi, patch); Router.render(); }

  function splitKey(key) {
    const i = key.indexOf(":");
    return [key.slice(0, i), key.slice(i + 1)];
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
  }

  function describe(kind, id) {
    if (kind === "account") return (State.getAccount(id) || {}).displayName || "this account";
    return (State.getServer(id) || {}).name || "this environment";
  }

  function removalWarning(kind, id) {
    if (kind === "account") {
      const envs = State.getServers().filter((s) => s.accountId === id).length;
      return envs
        ? `${envs} environment${envs === 1 ? "" : "s"} belong to it and will be left without an account.`
        : "It has no environments, so nothing else is affected.";
    }
    const claims = State.getServerTickets(id).length;
    return claims
      ? `${claims} active claim${claims === 1 ? "" : "s"} and every note on it will be removed too.`
      : "It holds no claims, so nothing else is affected.";
  }
})();
