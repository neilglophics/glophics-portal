/**
 * Users — the sign-in credentials and the role each one carries.
 *
 * The only page whose data does not come from State: credentials live
 * server-side in auth.json and are reached over /api/auth/*, so this file
 * keeps its own copy and reloads it after every change rather than
 * subscribing to the shared state everyone else repaints from.
 *
 * Reaching this page at all needs `manage-users`, and so does every route
 * behind it — the check below decides what to draw, not what is allowed.
 */

Router.register("users", (() => {
  let users = [];
  let loaded = false;
  let loading = false;

  function reload() {
    loading = true;
    Auth.listUsers()
      .then((list) => { users = list; loaded = true; loading = false; Router.render(); })
      .catch(() => { users = []; loaded = true; loading = false; Router.render(); });
  }

  // ---------- rows ----------

  function userRow(user) {
    const isSelf = user.id === Auth.user().id;
    const person = { id: user.id, name: user.displayName };

    return H.tr(
      H.td(`
        <div class="flex items-center gap-3">
          ${H.avatar(person, "h-9 w-9")}
          <div class="min-w-0">
            <p class="flex items-center gap-2 truncate text-sm font-semibold">
              ${H.esc(user.displayName)}
              ${isSelf ? `<span class="rounded-md bg-subtle-2 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-muted">YOU</span>` : ""}
            </p>
            <p class="truncate text-[11px] text-faint">@${H.esc(user.username)}</p>
          </div>
        </div>`) +
      H.td(H.chip(Tokens.roleChip(user.role), roleLabel(user.role))) +
      H.td(user.active
        ? H.dotChip({ chip: "bg-ok-soft text-ok", dot: "bg-emerald-500", label: "Active" })
        : H.dotChip({ chip: "bg-neutral-soft text-neutral", dot: "bg-faintest", label: "Deactivated" })) +
      H.td(user.lastLoginAt
        ? `<span class="text-xs text-body">${H.esc(Format.agoText(user.lastLoginAt))} ago</span>`
        : H.muted("Never")) +
      H.td(user.createdAt ? `<span class="whitespace-nowrap text-xs text-body">${H.esc(Format.formatDateTime(user.createdAt))}</span>` : H.dash) +
      H.td(`
        <div class="flex justify-end gap-2">
          ${H.btn("Edit", { size: "sm", variant: "quiet", class: "whitespace-nowrap", data: { "data-action": "auth-user-edit", "data-id": user.id } })}
          ${H.btn("Reset password", { size: "sm", variant: "quiet", class: "whitespace-nowrap", data: { "data-action": "auth-user-password", "data-id": user.id } })}
          ${isSelf ? "" : H.btn("Remove", { size: "sm", variant: "danger", class: "whitespace-nowrap", data: { "data-action": "auth-user-remove", "data-id": user.id } })}
        </div>`, "text-right")
    );
  }

  function usersTable() {
    if (!loaded) return H.empty(loading ? "Loading users…" : "Loading…");
    return H.table(
      H.th("User") + H.th("Role") + H.th("Status") + H.th("Last sign-in", "whitespace-nowrap") +
        H.th("Created", "whitespace-nowrap") + H.th("", "text-right"),
      users.map(userRow),
      "No users yet."
    );
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
        Changing someone's role, deactivating them, or resetting their password ends their
        open sessions immediately — they do not keep the old access until a reload.
      </p>`);
  }

  return {
    label: "Users",

    render() {
      if (!Auth.can("manage-users")) {
        return H.page(`
          ${H.pageHead("Users", "Sign-in credentials and roles", "")}
          ${H.empty("Only a super admin can manage sign-in credentials.")}`);
      }

      const active = users.filter((u) => u.active).length;
      const supers = users.filter((u) => u.role === "superadmin" && u.active).length;

      return H.page(`
        ${H.pageHead("Users", "Who can sign in, and what each of them is allowed to do",
          H.btn("Add user", { variant: "dark", data: { "data-action": "auth-user-add" } }))}

        <section class="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
          ${H.statTile("brand", "Accounts", users.length, "with sign-in credentials", "list")}
          ${H.statTile("ok", "Active", active, `${users.length - active} deactivated`, "check")}
          ${H.statTile("alt", "Super admins", supers, "can manage users", "gear")}
        </section>

        ${usersTable()}
        <div class="mt-5">${rolesCard()}</div>`);
    },

    // Credentials are server-side, so the first paint has no list yet.
    mount() {
      if (loaded || loading || !Auth.can("manage-users")) return;
      reload();
    },

    reload,
    list() { return users; }
  };
})());

/* ─────────────  user actions  ───────────── */

(() => {
  const page = () => Router.page("users");
  // The page already holds the list it just drew; a row action reads that
  // rather than asking the server again for something on screen.
  const find = (id) => page().list().find((u) => u.id === id);

  Actions.on("auth-user-add", () => Modals.authUserAdd(() => page().reload()));

  Actions.on("auth-user-edit", (el) => {
    const user = find(el.dataset.id);
    if (user) Modals.authUserEdit(user, () => page().reload());
  });

  Actions.on("auth-user-password", (el) => {
    const user = find(el.dataset.id);
    if (user) Modals.authUserPassword(user, () => page().reload());
  });

  Actions.on("auth-user-remove", (el) => {
    const user = find(el.dataset.id);
    if (!user) return;
    Modals.confirm({
      title: `Remove ${user.displayName}?`,
      message: `@${user.username} loses access immediately and any open session of theirs is dropped. Environments they are holding stay claimed — free those separately if you want them back.`,
      confirmLabel: "Remove user",
      onConfirm: async () => {
        const result = await Auth.removeUser(user.id);
        if (!result.ok) {
          Modals.info({ title: "Couldn't remove that user", message: [].concat(result.errors || result.error || "Try again.").join(" ") });
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
