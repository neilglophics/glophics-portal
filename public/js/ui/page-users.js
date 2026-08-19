/**
 * Users — everyone on the board, and which of them can sign in.
 *
 * These were two lists. The directory (State.getUsers()) held the people a
 * claim can be assigned to; auth.json held the sign-in accounts. Both
 * described the same colleagues, and both carried their own copy of the Jira
 * assignee labels — so the same person could be spelled two ways and the
 * board would quietly disagree with itself about whose ticket was whose.
 *
 * Now an account points at a directory person by id and reads their labels
 * through that link, and this page is the join: one row per person, showing
 * their login if they have one. Most rows will not — being assignable and
 * being able to sign in are different things, and most of the board is only
 * ever the first.
 *
 * So it draws from both layers at once, which nothing else here does:
 *   - people come from State, and repaint on their own when it changes
 *   - accounts come from /api/auth/* and are reloaded after every change
 *
 * Reaching this page at all needs `manage-users`, and so does every account
 * route behind it — the check below decides what to draw, not what is
 * allowed. Editing a person writes through State, which needs `configure`;
 * a super admin holds both.
 */

Router.register("users", (() => {
  let accounts = [];
  let loaded = false;
  let loading = false;

  function reload() {
    loading = true;
    Auth.listUsers()
      .then((list) => { accounts = list; loaded = true; loading = false; Router.render(); })
      .catch(() => { accounts = []; loaded = true; loading = false; Router.render(); });
  }

  /**
   * One row per person, each carrying the account that points at it.
   *
   * An account whose link is empty — or whose person has been removed from
   * the directory — gets a row of its own at the end. It would otherwise be
   * invisible here, which for the record that grants access is the one thing
   * this page must never do.
   */
  function rows() {
    const byPerson = new Map();
    accounts.forEach((a) => { if (a.directoryUserId) byPerson.set(a.directoryUserId, a); });

    const people = State.getUsers().slice().sort((a, b) => a.name.localeCompare(b.name));
    const paired = people.map((person) => ({ person, account: byPerson.get(person.id) || null }));

    const unlinked = accounts
      .filter((a) => !a.directoryUserId)
      .sort((a, b) => a.username.localeCompare(b.username))
      .map((account) => ({ person: null, account }));

    return paired.concat(unlinked);
  }

  // ---------- cells ----------

  function personCell({ person, account }) {
    // A row with no person is an account nobody has pointed at the board
    // yet, so its own display name is all there is to show.
    const label = person ? person.name : account.displayName;
    const avatarFor = person ? person : { id: account.id, name: account.displayName };
    const isSelf = account && Auth.user() && account.id === Auth.user().id;

    return H.td(`
      <div class="flex items-center gap-3">
        ${H.avatar(avatarFor, "h-9 w-9")}
        <div class="min-w-0">
          <p class="flex items-center gap-2 truncate text-sm font-semibold">
            ${H.esc(label)}
            ${isSelf ? `<span class="rounded-md bg-subtle-2 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-muted">YOU</span>` : ""}
          </p>
          <p class="truncate text-[11px] text-faint">${
            person ? H.esc(person.role || "No role set")
                   : `<span class="text-warn">Not on the board</span>`}</p>
        </div>
      </div>`);
  }

  function jiraCell({ person }) {
    if (!person) return H.td(H.muted("—"));
    const names = userJiraNames(person);
    if (!names.length) {
      return H.td(`<button data-action="person-edit" data-id="${H.esc(person.id)}"
        class="text-[11px] font-semibold text-faint hover:text-brand-fg hover:underline">No Jira name</button>`);
    }
    return H.td(`<div class="flex flex-wrap gap-1">${
      names.map((n) => H.chip("bg-subtle-2 text-muted", n)).join("")}</div>`);
  }

  function signInCell({ person, account }) {
    if (!account) {
      return H.td(`<button data-action="auth-user-add" data-person="${H.esc(person.id)}"
        class="text-[11px] font-semibold text-faint hover:text-brand-fg hover:underline">No login — give access</button>`);
    }
    return H.td(`
      <div class="min-w-0">
        <p class="truncate text-xs font-semibold text-body">@${H.esc(account.username)}</p>
        <div class="mt-1 flex flex-wrap items-center gap-1">
          ${H.chip(Tokens.roleChip(account.role), roleLabel(account.role))}
          ${account.active ? "" : H.chip("bg-neutral-soft text-neutral", "Deactivated")}
        </div>
      </div>`);
  }

  function lastSeenCell({ account }) {
    if (!account) return H.td(H.dash);
    return H.td(account.lastLoginAt
      ? `<span class="whitespace-nowrap text-xs text-body">${H.esc(Format.agoText(account.lastLoginAt))} ago</span>`
      : H.muted("Never"));
  }

  function actionsCell({ person, account }) {
    const isSelf = account && Auth.user() && account.id === Auth.user().id;
    const buttons = [];

    if (person) {
      buttons.push(H.btn("Edit person", { size: "sm", variant: "quiet", class: "whitespace-nowrap",
        data: { "data-action": "person-edit", "data-id": person.id } }));
    }
    if (account) {
      buttons.push(H.btn("Login", { size: "sm", variant: "quiet", class: "whitespace-nowrap",
        data: { "data-action": "auth-user-edit", "data-id": account.id } }));
      buttons.push(H.btn("Reset password", { size: "sm", variant: "quiet", class: "whitespace-nowrap",
        data: { "data-action": "auth-user-password", "data-id": account.id } }));
      if (!isSelf) {
        buttons.push(H.btn("Remove login", { size: "sm", variant: "danger", class: "whitespace-nowrap",
          data: { "data-action": "auth-user-remove", "data-id": account.id } }));
      }
    } else if (person) {
      buttons.push(H.btn("Remove", { size: "sm", variant: "danger", class: "whitespace-nowrap",
        data: { "data-action": "person-remove", "data-id": person.id } }));
    }

    return H.td(`<div class="flex justify-end gap-2">${buttons.join("")}</div>`, "text-right");
  }

  function usersTable() {
    if (!loaded) return H.empty(loading ? "Loading logins…" : "Loading…");
    return H.table(
      H.th("Person") + H.th("Jira assignee") + H.th("Sign-in") +
        H.th("Last sign-in", "whitespace-nowrap") + H.th("", "text-right"),
      rows().map((row) => H.tr(
        personCell(row) + jiraCell(row) + signInCell(row) + lastSeenCell(row) + actionsCell(row)
      )),
      "Nobody here yet."
    );
  }

  /**
   * Names on tickets that no login answers to. Every ticket under one of
   * them is invisible on its owner's My tickets page — and since a login
   * reads its names through the person it points at, the fix is either to
   * give that person access or to point an existing account at them. Both
   * are one click away in the row, which is why the list belongs here.
   */
  function coverageNotice() {
    const missing = Model.namesWithoutAccount(accounts);
    if (!missing.length) return "";
    const tickets = missing.reduce((n, m) => n + m.tickets, 0);
    return H.notice("warn",
      `${tickets} ticket${tickets === 1 ? " is" : "s are"} assigned to ${missing.length} name${missing.length === 1 ? "" : "s"} no login answers to`,
      `${missing.slice(0, 8).map((m) => `<strong>${H.esc(m.name)}</strong> (${m.tickets})`).join(" · ")}${
        missing.length > 8 ? ` and ${missing.length - 8} more` : ""}.
       Give that person a login — or point an existing one at them — and they
       will see their own tickets under <strong>My tickets</strong>.`);
  }

  // What each role actually unlocks, straight from the shared list — the
  // same one the server enforces, so this table cannot describe a rule
  // that isn't real.
  function rolesCard() {
    return H.card("What each role can do", "Roles are fixed; who holds them is not.", `
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        ${Auth.roles().map((role) => `
          <div class="rounded-xl bg-subtle p-3.5">
            ${H.chip(Tokens.roleChip(role.id), role.label)}
            <p class="mt-2 text-xs leading-relaxed text-body">${H.esc(role.description)}</p>
          </div>`).join("")}
      </div>
      <p class="mt-4 text-[11px] leading-relaxed text-faint">
        A role only means anything to someone with a login. Changing it, deactivating them, or
        resetting their password ends their open sessions immediately — they do not keep the old
        access until a reload.
      </p>`);
  }

  return {
    label: "Users",

    render() {
      if (!Auth.can("manage-users")) {
        return H.page(`
          ${H.pageHead("Users", "Who is on the board, and who can sign in", "")}
          ${H.empty("Only a super admin can manage sign-in credentials.")}`);
      }

      const people = State.getUsers();
      const withLogin = new Set(accounts.map((a) => a.directoryUserId).filter(Boolean)).size;
      const active = accounts.filter((a) => a.active).length;

      return H.page(`
        ${H.pageHead("Users", "Everyone on the board, and which of them can sign in", `
          <div class="flex flex-wrap gap-2">
            ${H.btn("Add person", { data: { "data-action": "person-add" } })}
            ${H.btn("Give someone a login", { variant: "dark", data: { "data-action": "auth-user-add" } })}
          </div>`)}

        <section class="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
          ${H.statTile("brand", "People", people.length, "assignable to a claim", "users")}
          ${H.statTile("alt", "With a login", withLogin, `of ${people.length} can sign in`, "list")}
          ${H.statTile("ok", "Active logins", active, `${accounts.length - active} deactivated`, "check")}
        </section>

        ${loaded ? coverageNotice() : ""}
        ${usersTable()}
        <div class="mt-5">${rolesCard()}</div>`);
    },

    // Logins are server-side, so the first paint has no list yet. People
    // come from State and are already there.
    mount() {
      if (loaded || loading || !Auth.can("manage-users")) return;
      reload();
    },

    reload,
    list() { return accounts; }
  };
})());

/* ─────────────  people  ───────────── */

(() => {
  const page = () => Router.page("users");

  Actions.on("person-add", () => Modals.personAdd());

  Actions.on("person-edit", (el) => {
    const person = State.getUser(el.dataset.id);
    if (person) Modals.personEdit(person);
  });

  Actions.on("person-remove", (el) => {
    const person = State.getUser(el.dataset.id);
    if (!person) return;

    // A person with a login is two records, and removing only the directory
    // half would leave an account pointing at nobody — able to sign in, and
    // shown none of its own tickets. Refuse rather than half-do it.
    const account = page().list().find((a) => a.directoryUserId === person.id);
    if (account) {
      Modals.info({
        title: `${person.name} has a login`,
        message: `Remove @${account.username} first — an account left pointing at nobody can still sign in but is shown none of its own tickets.`
      });
      return;
    }

    const held = Model.assigneeRows().find((r) => r.user && r.user.id === person.id);
    Modals.confirm({
      title: `Remove ${person.name}?`,
      message: held && held.tickets
        ? `${held.tickets} ticket${held.tickets === 1 ? "" : "s"} name them. Those claims stay, but nobody will be listed as holding them.`
        : "They hold nothing, so nothing else is affected.",
      confirmLabel: "Remove person",
      onConfirm: () => { State.removeUser(person.id); }
    });
  });
})();

/* ─────────────  logins  ───────────── */

(() => {
  const page = () => Router.page("users");
  // The page already holds the list it just drew; a row action reads that
  // rather than asking the server again for something on screen.
  const find = (id) => page().list().find((u) => u.id === id);

  Actions.on("auth-user-add", (el) => {
    // Opened either from the page header, or from one person's row — in
    // which case that person arrives preselected.
    Modals.authUserAdd(page().list(), () => page().reload(), el.dataset.person || null);
  });

  Actions.on("auth-user-edit", (el) => {
    const user = find(el.dataset.id);
    if (user) Modals.authUserEdit(user, page().list(), () => page().reload());
  });

  Actions.on("auth-user-password", (el) => {
    const user = find(el.dataset.id);
    if (user) Modals.authUserPassword(user, () => page().reload());
  });

  Actions.on("auth-user-remove", (el) => {
    const user = find(el.dataset.id);
    if (!user) return;
    Modals.confirm({
      title: `Remove @${user.username}?`,
      message: `They lose access immediately and any open session of theirs is dropped. They stay on the board as a person, so their claims and tickets are untouched — this only takes away the login.`,
      confirmLabel: "Remove login",
      onConfirm: async () => {
        const result = await Auth.removeUser(user.id);
        if (!result.ok) {
          Modals.info({ title: "Couldn't remove that login", message: [].concat(result.errors || result.error || "Try again.").join(" ") });
          return;
        }
        page().reload();
      }
    });
  });

  // Both of these are reached from the account dropdown, which has to get
  // out of the way before the dialog it opens lands on top of it.
  Actions.on("change-own-password", () => {
    Shell.toggleMenu(false);
    Modals.changeOwnPassword();
  });

  Actions.on("sign-out", async () => {
    Shell.toggleMenu(false);
    await Auth.signOut();
    // A full reload is the cleanest way back to the sign-in screen: it
    // drops the SSE stream, every cached view-model and the local copy of
    // the board along with it.
    location.reload();
  });
})();
