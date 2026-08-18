/**
 * One modal host, several shapes. Every dialog renders into `#modal-host`
 * and closes the same way (backdrop, ✕, Escape), so nothing else in the UI
 * has to know a dialog is open.
 *
 * Validation is not duplicated here — the assign form hands its payload to
 * State.addClaim() and renders whatever errors come back.
 */

const Modals = (() => {
  let submitHandler = null;

  function host() { return document.getElementById("modal-host"); }

  function open({ title, subtitle, body, submitLabel, variant = "dark", onSubmit, wide }) {
    submitHandler = onSubmit || null;
    host().innerHTML = `
      <div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm sm:p-8"
           data-modal-backdrop>
        <div class="my-auto w-full ${wide ? "max-w-2xl" : "max-w-lg"} rounded-2xl bg-white shadow-2xl">
          <div class="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
            <div>
              <h2 class="text-base font-bold tracking-tight">${H.esc(title)}</h2>
              ${subtitle ? `<p class="mt-0.5 text-xs text-slate-400">${H.esc(subtitle)}</p>` : ""}
            </div>
            <button type="button" data-modal-close
              class="grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
              ${H.icon("close", "h-4 w-4")}
            </button>
          </div>
          <form id="modal-form" class="px-6 py-5">
            ${body}
            <p id="modal-error" class="mt-4 hidden rounded-xl bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-700"></p>
            <div class="mt-6 flex justify-end gap-2">
              ${H.btn("Cancel", { variant: "ghost", data: { "data-modal-close": "" } })}
              <button type="submit"
                class="rounded-full px-4 py-2.5 text-xs font-semibold transition ${
                  variant === "danger" ? "bg-rose-600 text-white hover:bg-rose-700" : "bg-slate-900 text-white hover:bg-slate-800"}">
                ${H.esc(submitLabel || "Save")}</button>
            </div>
          </form>
        </div>
      </div>`;
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
      body: `<p class="text-sm leading-relaxed text-slate-600">${H.esc(message)}</p>`,
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
      return `<label class="flex cursor-pointer items-center gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5">
        <input type="checkbox" name="repos" value="${H.esc(name)}"
               ${!taken.length && wholeEnv ? "checked" : ""} class="h-4 w-4 rounded accent-brand-500" />
        <span class="text-sm font-medium capitalize text-slate-700">${H.esc(name)}</span>
        ${taken.length ? `<span class="ml-auto text-[10px] font-semibold text-amber-600">held ×${taken.length}</span>` : ""}
      </label>`;
    }).join("");

    const userBoxes = users.length ? users.map((u) => `
      <label class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition hover:bg-white">
        <input type="checkbox" name="userIds" value="${H.esc(u.id)}" class="h-3.5 w-3.5 rounded accent-brand-500" />
        ${H.avatar(u, "h-6 w-6")}
        <span class="text-xs font-medium text-slate-700">${H.esc(u.name)}</span>
        <span class="ml-auto text-[10px] text-slate-400">${H.esc(u.role || "")}</span>
      </label>`).join("")
      : `<p class="px-2 py-3 text-xs text-slate-400">No users configured — add them in Settings.</p>`;

    open({
      title: "Claim repositories",
      subtitle: `${server.name} · ${row.accountName}`,
      wide: true,
      submitLabel: "Claim",
      body: `
        <div class="space-y-5">
          <div>
            <p class="pb-2 text-[11px] font-semibold text-slate-500">Which repositories</p>
            <div class="grid gap-2 sm:grid-cols-3">${repoBoxes}</div>
          </div>
          <div>
            <p class="pb-2 text-[11px] font-semibold text-slate-500">Who is holding it</p>
            <div class="max-h-40 space-y-0.5 overflow-y-auto rounded-xl bg-slate-50 p-2">${userBoxes}</div>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            ${H.field("Jira ticket", { data: { name: "jiraTicket" }, placeholder: "GLOP-1234" })}
            ${H.field("Note (optional)", { data: { name: "note" }, placeholder: "What's happening here?" })}
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="text-[11px] font-semibold text-slate-500">Start</span>
              <input type="datetime-local" name="startTime" value="${toLocalInput(new Date())}"
                class="mt-1.5 w-full rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-700 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-200" />
            </label>
            <label class="block">
              <span class="text-[11px] font-semibold text-slate-500">Ends</span>
              <input type="datetime-local" name="endTime" value="${toLocalInput(end)}"
                class="mt-1.5 w-full rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-700 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-200" />
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
        class="w-full rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-700 placeholder:text-slate-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-200"
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

  return { open, close, isOpen, showError, confirm, assign, note, repoUrl, bind };
})();
