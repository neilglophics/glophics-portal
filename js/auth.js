/**
 * Who is signed in, and what they are allowed to do.
 *
 * Part of the data layer: it talks to /api/auth/* and holds the current
 * user. The UI asks `Auth.can("configure")` and hides what the answer says
 * to hide — but hiding is only courtesy. Every one of these routes is
 * checked again on the server with the same roleCan() from js/data.js, so
 * a hidden button and a forged request are refused by the same rule.
 *
 * Credentials never live here. The session is an HttpOnly cookie the
 * browser attaches on its own; no script in this app can read it.
 */

const Auth = (() => {
  let current = null;

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      ...options
    });
    // Handlers answer with a body on both success and failure, so the body
    // is the answer and the status only says which kind it is.
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }

  // ---------- session ----------

  // Resolves to the signed-in user, or null. Called once at boot, and again
  // whenever a request comes back 401 (the session expired, or a super
  // admin revoked it while the tab was open).
  async function refresh() {
    try {
      const data = await api("/api/auth/me");
      current = data.ok ? data.user : null;
    } catch (err) {
      // No server at all — file:// or it's down. There is nothing to sign
      // in to, so treat it as signed out rather than silently unlocked.
      current = null;
    }
    return current;
  }

  async function signIn(username, password) {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    if (data.ok) current = data.user;
    return data;
  }

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    current = null;
  }

  function changeOwnPassword(currentPassword, newPassword) {
    return api("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword })
    });
  }

  // ---------- what this user may do ----------

  function user() { return current; }
  function isSignedIn() { return !!current; }

  function can(capability) {
    return !!current && roleCan(current.role, capability);
  }

  function roleName() {
    return current ? roleLabel(current.role) : "";
  }

  function roles() { return AUTH_ROLES; }

  // The Jira "Ticket Assignee" labels this login answers to — what "mine"
  // means on the By assignee page. Empty until a super admin sets it.
  function jiraNames() {
    return (current && Array.isArray(current.jiraNames)) ? current.jiraNames : [];
  }

  // ---------- managing other people's credentials (super admin) ----------

  async function listUsers() {
    const data = await api("/api/auth/users");
    return data.ok ? data.users : [];
  }

  function createUser(payload) {
    return api("/api/auth/users", { method: "POST", body: JSON.stringify(payload) });
  }

  function updateUser(id, payload) {
    return api(`/api/auth/users/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(payload) });
  }

  function removeUser(id) {
    return api(`/api/auth/users/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  function setPassword(id, password) {
    return api(`/api/auth/users/${encodeURIComponent(id)}/password`, {
      method: "POST",
      body: JSON.stringify({ password })
    });
  }

  return {
    refresh, signIn, signOut, changeOwnPassword,
    user, isSignedIn, can, roleName, roles, jiraNames,
    listUsers, createUser, updateUser, removeUser, setPassword
  };
})();
