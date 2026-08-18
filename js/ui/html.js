/**
 * Presentational primitives — the only place that writes Tailwind classes
 * for shared UI shapes. Every function is pure: string in, string out, no
 * DOM and no State. Pages compose these instead of hand-rolling markup, so
 * a table on one page looks exactly like a table on another.
 */

const H = (() => {
  const esc = Format.escapeHtml;

  // ---------- text ----------

  const dash = `<span class="text-sm text-slate-300">—</span>`;
  const muted = (t) => `<span class="text-xs text-slate-400">${esc(t)}</span>`;

  // ---------- chips & badges ----------

  const chip = (cls, text) =>
    `<span class="inline-block whitespace-nowrap rounded-md ${cls} px-2 py-1 text-[10px] font-bold tracking-wide">${esc(text)}</span>`;

  const dotChip = (token) =>
    `<span class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full ${token.chip} px-2.5 py-1 text-[11px] font-semibold">
       <span class="h-1.5 w-1.5 rounded-full ${token.dot}"></span>${esc(token.label)}</span>`;

  const jiraChip = (status) => status ? chip(Tokens.jiraChip(status), status) : "";

  // ---------- people ----------

  const avatar = (user, size = "h-8 w-8") =>
    `<span title="${esc(user.name)}"
       class="grid ${size} shrink-0 place-items-center rounded-full ${Tokens.avatarTone(user.id)} text-[10px] font-bold ring-2 ring-white">${esc(Tokens.initials(user.name))}</span>`;

  const avatarStack = (users, max = 3) => {
    if (!users.length) return dash;
    const shown = users.slice(0, max);
    const rest = users.length - shown.length;
    return `<div class="flex items-center">
      <div class="flex -space-x-2">${shown.map((u) => avatar(u)).join("")}</div>
      ${rest > 0 ? `<span class="ml-2.5 text-[11px] font-semibold text-slate-400">+${rest}</span>` : ""}
    </div>`;
  };

  // ---------- repositories ----------

  // The SF/API/ADM strip: green free, amber held, red offline, grey no URL.
  // Reads identically on a card and in a table, which is the point.
  const repoStrip = (row) => `<div class="flex gap-1">` + row.repoNames.map((name) => {
    const repo = row.server.repos[name];
    const held = State.getRepoClaims(row.id, name).length > 0;
    const cls = repo.health === "offline" ? "bg-rose-500/85 text-white"
      : (!repo.url || repo.health === "unconfigured") ? "bg-slate-200 text-slate-500"
      : held ? "bg-amber-500/85 text-white"
      : "bg-emerald-500/85 text-white";
    const state = repo.health === "offline" ? "offline" : (!repo.url ? "no URL" : held ? "held" : "free");
    return `<span title="${esc(name)}: ${state}"
      class="w-9 rounded-md ${cls} py-0.5 text-center text-[9px] font-bold">${esc(Tokens.shortRepo(name))}</span>`;
  }).join("") + `</div>`;

  const bar = (pct, cls) =>
    `<div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
       <div class="h-full rounded-full ${cls}" style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>`;

  // ---------- buttons ----------

  const icon = (name, cls = "h-4 w-4") =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${Tokens.ICONS[name] || ""}</svg>`;

  const attrs = (o = {}) => Object.keys(o)
    .filter((k) => o[k] !== undefined && o[k] !== null)
    .map((k) => `${k}="${esc(o[k])}"`).join(" ");

  const btn = (label, opts = {}) => {
    const variants = {
      dark:  "bg-slate-900 text-white hover:bg-slate-800",
      ghost: "bg-white text-slate-600 shadow-sm ring-1 ring-slate-200 hover:text-brand-600",
      brand: "bg-brand-500 text-white hover:bg-brand-600",
      danger:"text-rose-600 ring-1 ring-rose-200 hover:bg-rose-50",
      quiet: "text-slate-500 ring-1 ring-slate-200 hover:bg-brand-50 hover:text-brand-600 hover:ring-brand-200"
    };
    const sizes = { sm: "px-3 py-1.5 text-[11px]", md: "px-4 py-2.5 text-xs" };
    return `<button type="button" ${attrs(opts.data)}
      class="rounded-full font-semibold transition ${sizes[opts.size || "md"]} ${variants[opts.variant || "ghost"]} ${opts.class || ""}">${esc(label)}</button>`;
  };

  const iconBtn = (iconName, title, data) =>
    `<button type="button" title="${esc(title)}" ${attrs(data)}
       class="grid h-8 w-8 place-items-center rounded-full text-slate-400 ring-1 ring-slate-200 transition hover:bg-brand-50 hover:text-brand-600 hover:ring-brand-200">${icon(iconName, "h-3.5 w-3.5")}</button>`;

  // ---------- page furniture ----------

  const page = (body) => `<div class="px-4 pb-6 sm:px-6 lg:px-7 lg:pb-8">${body}</div>`;

  const pageHead = (title, sub, actions = "") => `
    <div class="flex flex-wrap items-end justify-between gap-4 pb-5">
      <div>
        <h1 class="text-[22px] font-bold tracking-tight">${esc(title)}</h1>
        <p class="mt-1 text-sm text-slate-400">${sub}</p>
      </div>
      <div class="flex shrink-0 flex-wrap gap-2">${actions}</div>
    </div>`;

  const card = (title, sub, body, extra = "") => `
    <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100 ${extra}">
      ${title ? `<h2 class="text-[15px] font-bold tracking-tight">${esc(title)}</h2>` : ""}
      ${sub ? `<p class="mt-1 text-xs text-slate-400">${sub}</p>` : ""}
      <div class="${title ? "mt-5" : ""}">${body}</div>
    </div>`;

  const statTile = (tone, label, value, sub, iconName) => `
    <div class="flex items-center gap-3.5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
      <span class="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-${tone}-50 text-${tone}-600">${icon(iconName, "h-5 w-5")}</span>
      <div class="min-w-0">
        <p class="truncate text-sm font-bold">${esc(label)}</p>
        <p class="truncate text-xs text-slate-400">${esc(sub)}</p>
      </div>
      <span class="ml-auto shrink-0 text-2xl font-bold tracking-tight text-${tone}-600">${value}</span>
    </div>`;

  const notice = (tone, title, body) => `
    <div class="mb-5 flex items-start gap-3 rounded-2xl bg-${tone}-50 p-4 ring-1 ring-${tone}-100">
      <span class="mt-0.5 shrink-0 text-${tone}-600">${icon("alert", "h-5 w-5")}</span>
      <div class="min-w-0">
        <p class="text-sm font-bold text-${tone}-800">${esc(title)}</p>
        <p class="mt-0.5 text-xs text-${tone}-700">${body}</p>
      </div>
    </div>`;

  // ---------- tables ----------

  const th = (label, extra = "") => `<th class="px-5 py-3 font-bold ${extra}">${esc(label)}</th>`;
  const td = (content, extra = "") => `<td class="px-5 py-3.5 ${extra}">${content}</td>`;
  const tr = (cells, data, extraClass = "") =>
    `<tr ${attrs(data)} class="transition hover:bg-slate-50/60 ${extraClass}">${cells}</tr>`;

  const table = (head, rows, emptyMessage) => rows.length ? `
    <div class="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
      <div class="overflow-x-auto">
        <table class="w-full min-w-[880px] text-left">
          <thead><tr class="border-b border-slate-100 text-[10px] font-bold tracking-[0.12em] text-slate-400">${head}</tr></thead>
          <tbody class="divide-y divide-slate-50">${rows.join("")}</tbody>
        </table>
      </div>
    </div>` : empty(emptyMessage || "Nothing to show here.");

  const empty = (message) => `
    <div class="rounded-2xl bg-white p-12 text-center shadow-sm ring-1 ring-slate-100">
      <p class="text-sm text-slate-400">${esc(message)}</p>
    </div>`;

  // ---------- forms ----------

  const field = (label, opts = {}) => `
    <label class="block ${opts.span ? "sm:col-span-2" : ""}">
      <span class="text-[11px] font-semibold text-slate-500">${esc(label)}</span>
      <input type="${opts.type || "text"}" ${attrs(opts.data)}
             value="${esc(opts.value || "")}" placeholder="${esc(opts.placeholder || "")}"
             class="mt-1.5 w-full rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-700 placeholder:text-slate-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-200" />
    </label>`;

  const select = (label, options, opts = {}) => `
    <label class="flex items-center justify-between gap-4">
      <span class="text-sm text-slate-600">${esc(label)}</span>
      <select ${attrs(opts.data)}
        class="rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-200">
        ${options.map((o) => `<option value="${esc(o.value)}" ${o.value === opts.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
      </select>
    </label>`;

  const toggle = (on, data) =>
    `<button type="button" role="switch" aria-checked="${on ? "true" : "false"}" ${attrs(data)}
       class="relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-emerald-500" : "bg-slate-200"}">
       <span class="absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-all ${on ? "left-6" : "left-1"}"></span></button>`;

  const checkbox = (label, hint, on, data) => `
    <label class="flex cursor-pointer items-start gap-3">
      <input type="checkbox" ${on ? "checked" : ""} ${attrs(data)} class="mt-0.5 h-4 w-4 rounded accent-brand-500" />
      <span><span class="block text-sm font-medium text-slate-700">${esc(label)}</span>
            ${hint ? `<span class="block text-xs text-slate-400">${esc(hint)}</span>` : ""}</span>
    </label>`;

  return {
    esc, dash, muted, chip, dotChip, jiraChip, avatar, avatarStack, repoStrip, bar,
    icon, iconBtn, btn, attrs,
    page, pageHead, card, statTile, notice,
    th, td, tr, table, empty,
    field, select, toggle, checkbox
  };
})();
