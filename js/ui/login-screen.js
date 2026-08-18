/**
 * The sign-in screen.
 *
 * Not a page: pages live behind the router and assume a shell around them,
 * and there is no shell until someone is signed in. This renders into
 * #auth-root instead, with the app shell hidden, and hands control back to
 * app.js once the session exists.
 *
 * It binds its own submit listener rather than going through Actions —
 * nothing repaints it, so there is no dead-listener problem to avoid, and a
 * form that keeps working while the app around it hasn't booted is worth
 * the one exception.
 */

const LoginScreen = (() => {

  function root() { return document.getElementById("auth-root"); }
  function shell() { return document.getElementById("shell"); }

  // Shown for the moment between "page loaded" and "we know who you are",
  // so a signed-in reload never flashes the sign-in form.
  function renderChecking() {
    shell().classList.add("hidden");
    root().classList.remove("hidden");
    root().innerHTML = `
      <div class="grid h-full place-items-center bg-canvas">
        <p class="text-sm text-faint">Checking your session…</p>
      </div>`;
  }

  function brandPanel() {
    return `
      <div class="relative hidden overflow-hidden bg-gradient-to-br from-brand-500 to-brand-700 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <svg class="pointer-events-none absolute -right-16 top-1/2 h-96 w-96 -translate-y-1/2 text-white/10" viewBox="0 0 100 100" fill="currentColor">
          <path d="M50 4c2 26 18 42 44 46-26 4-42 20-46 46-4-26-20-42-46-46 26-4 42-20 48-46z"/>
        </svg>
        <div class="relative flex items-center gap-3">
          <span class="grid h-10 w-10 place-items-center rounded-xl bg-white/15 backdrop-blur">
            ${H.icon("servers", "h-5 w-5")}
          </span>
          <span class="text-lg font-bold tracking-tight">Server Management</span>
        </div>
        <div class="relative max-w-md">
          <h2 class="text-[28px] font-bold leading-tight tracking-tight">
            Know which environment is free before you deploy.
          </h2>
          <p class="mt-3 text-sm leading-relaxed text-white/75">
            Every QA and staging box, who is holding it, and which ticket claimed it —
            live for the whole team.
          </p>
        </div>
        <p class="relative text-xs text-white/50">Ask a super admin for an account.</p>
      </div>`;
  }

  function formPanel(error) {
    return `
      <div class="flex items-center justify-center bg-surface px-6 py-12 sm:px-12">
        <form id="login-form" class="w-full max-w-sm" autocomplete="on">
          <div class="flex items-center gap-2.5 lg:hidden">
            <span class="grid h-9 w-9 place-items-center rounded-xl bg-brand-500 text-white shadow-lg shadow-brand-500/30">
              ${H.icon("servers", "h-4.5 w-4.5")}
            </span>
            <span class="text-[17px] font-bold tracking-tight">Servers</span>
          </div>

          <h1 class="mt-8 text-2xl font-bold tracking-tight lg:mt-0">Sign in</h1>
          <p class="mt-1.5 text-sm text-faint">Use the credentials your super admin gave you.</p>

          <div class="mt-7 space-y-4">
            ${H.field("Username", {
              value: "", placeholder: "e.g. jerome",
              data: { id: "login-username", name: "username", autocomplete: "username", autocapitalize: "none", spellcheck: "false" }
            })}
            ${H.field("Password", {
              type: "password", placeholder: "••••••••",
              data: { id: "login-password", name: "password", autocomplete: "current-password" }
            })}
          </div>

          <p id="login-error" class="mt-4 ${error ? "" : "hidden"} rounded-xl bg-bad-soft px-3.5 py-2.5 text-xs font-medium text-bad">${H.esc(error || "")}</p>

          <button type="submit" id="login-submit"
            class="mt-6 w-full rounded-full bg-accent px-4 py-3 text-sm font-semibold text-on-accent transition hover:bg-accent-2 disabled:opacity-60">
            Sign in
          </button>

          <p class="mt-6 text-center text-[11px] leading-relaxed text-faint">
            Sessions last a week. Signing out, a password change, or a role change ends them.
          </p>
        </form>
      </div>`;
  }

  function showError(message) {
    const el = document.getElementById("login-error");
    if (!el) return;
    el.textContent = message;
    el.classList.remove("hidden");
  }

  /**
   * Paints the sign-in screen and resolves once the credentials are
   * accepted — app.js awaits it and then boots the app as normal.
   */
  function show() {
    return new Promise((resolve) => {
      shell().classList.add("hidden");
      root().classList.remove("hidden");
      root().innerHTML = `
        <div class="grid h-full grid-cols-1 overflow-y-auto bg-surface lg:grid-cols-2">
          ${brandPanel()}
          ${formPanel(null)}
        </div>`;

      const form = document.getElementById("login-form");
      const submit = document.getElementById("login-submit");
      const username = document.getElementById("login-username");
      username.focus();

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const password = document.getElementById("login-password");
        if (!username.value.trim() || !password.value) {
          showError("Enter your username and password.");
          return;
        }

        submit.disabled = true;
        submit.textContent = "Signing in…";
        try {
          const result = await Auth.signIn(username.value.trim(), password.value);
          if (result.ok) { resolve(result.user); return; }
          showError(result.error || "Couldn't sign you in.");
        } catch (err) {
          showError("Couldn't reach the server. Is it running?");
        }
        submit.disabled = false;
        submit.textContent = "Sign in";
        password.value = "";
        password.focus();
      });
    });
  }

  // Hands the screen back to the app once a session exists.
  function hide() {
    root().classList.add("hidden");
    root().innerHTML = "";
    shell().classList.remove("hidden");
  }

  return { show, hide, renderChecking };
})();
