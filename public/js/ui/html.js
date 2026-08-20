/**
 * Presentational primitives — the only place that writes Tailwind classes
 * for shared UI shapes. Every function is pure: string in, string out, no
 * DOM and no State. Pages compose these instead of hand-rolling markup, so
 * a table on one page looks exactly like a table on another.
 */

const H = (() => {
  const esc = Format.escapeHtml;

  // ---------- text ----------

  const dash = `<span class="text-sm text-faintest">—</span>`;
  const muted = (t) => `<span class="text-xs text-faint">${esc(t)}</span>`;

  // ---------- chips & badges ----------

  const chip = (cls, text) =>
    `<span class="inline-block whitespace-nowrap rounded-md ${cls} px-2 py-1 text-[10px] font-bold tracking-wide">${esc(text)}</span>`;

  const dotChip = (token) =>
    `<span class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full ${token.chip} px-2.5 py-1 text-[11px] font-semibold">
       <span class="h-1.5 w-1.5 rounded-full ${token.dot}"></span>${esc(token.label)}</span>`;

  const jiraChip = (status) => status ? chip(Tokens.jiraChip(status), status) : "";

  // A count-bearing toggle for narrowing a list. Selected reads as a solid
  // brand pill, the rest as quiet outlines, so which way a table is cut is
  // legible without reading a single label. Uses the fixed brand colour on
  // purpose: it means the same thing in both themes.
  const filterChip = (label, count, on, data) => `
    <button type="button" ${attrs(data)}
      class="inline-flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
        on ? "bg-brand-500 text-white" : "bg-surface text-muted ring-1 ring-line-2 hover:text-brand-fg hover:ring-brand-soft"}">
      ${esc(label)}
      <span class="rounded-full px-1.5 text-[10px] font-bold ${on ? "bg-white/20 text-white" : "bg-subtle-2 text-muted"}">${count}</span>
    </button>`;

  // ---------- people ----------

  const avatar = (user, size = "h-8 w-8") =>
    `<span title="${esc(user.name)}"
       class="grid ${size} shrink-0 place-items-center rounded-full ${Tokens.avatarTone(user.id)} text-[10px] font-bold ring-2 ring-surface">${esc(Tokens.initials(user.name))}</span>`;

  const avatarStack = (users, max = 3) => {
    if (!users.length) return dash;
    const shown = users.slice(0, max);
    const rest = users.length - shown.length;
    return `<div class="flex items-center">
      <div class="flex -space-x-2">${shown.map((u) => avatar(u)).join("")}</div>
      ${rest > 0 ? `<span class="ml-2.5 text-[11px] font-semibold text-faint">+${rest}</span>` : ""}
    </div>`;
  };

  // ---------- repositories ----------

  // One SF/API/ADM chip. A repository with a URL becomes a link: the tooltip
  // carries the address and a click opens it in a new tab. Without a URL
  // there is nowhere to go, so it stays a plain badge and says so on hover.
  const repoChip = ({ name, cls, state, url, extra = "" }) => {
    const shape = `block w-9 shrink-0 rounded-md ${cls} py-0.5 text-center text-[9px] font-bold ${extra}`;
    const short = esc(Tokens.shortRepo(name));
    if (!url) return `<span title="${esc(`${name}: ${state}`)}" class="${shape}">${short}</span>`;
    return `<a href="${esc(url)}" target="_blank" rel="noopener"
      title="${esc(`${name}: ${state}
${url}`)}"
      class="${shape} cursor-pointer transition hover:brightness-110 hover:ring-2 hover:ring-brand-300">${short}</a>`;
  };

  // The SF/API/ADM strip: green free, amber held, red offline, grey no URL.
  // Reads identically on a card and in a table, which is the point.
  const repoStrip = (row) => `<div class="flex gap-1">` + row.repoNames.map((name) => {
    const repo = row.server.repos[name];
    const held = State.getRepoClaims(row.id, name).length > 0;
    const cls = repo.health === "offline" ? "bg-bad-strong/85 text-white"
      : (!repo.url || repo.health === "unconfigured") ? "bg-line-2 text-muted"
      : held ? "bg-warn-strong/85 text-white"
      : "bg-ok-strong/85 text-white";
    const state = repo.health === "offline" ? "offline" : (!repo.url ? "no URL configured" : held ? "held" : "free");
    return repoChip({ name, cls, state, url: repo.url });
  }).join("") + `</div>`;

  const bar = (pct, cls) =>
    `<div class="h-1.5 w-full overflow-hidden rounded-full bg-subtle-2">
       <div class="h-full rounded-full ${cls}" style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>`;

  // ---------- buttons ----------

  const icon = (name, cls = "h-4 w-4") =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${Tokens.ICONS[name] || ""}</svg>`;

  const attrs = (o = {}) => Object.keys(o)
    .filter((k) => o[k] !== undefined && o[k] !== null)
    .map((k) => `${k}="${esc(o[k])}"`).join(" ");

  const btn = (label, opts = {}) => {
    const variants = {
      dark:  "bg-accent text-on-accent hover:bg-accent-2",
      ghost: "bg-surface text-body shadow-sm ring-1 ring-line-2 hover:text-brand-fg",
      brand: "bg-brand-500 text-white hover:bg-brand-600",
      danger:"text-bad ring-1 ring-bad-soft hover:bg-bad-soft",
      quiet: "text-muted ring-1 ring-line-2 hover:bg-brand-soft hover:text-brand-fg hover:ring-brand-soft"
    };
    const sizes = { sm: "px-3 py-1.5 text-[11px]", md: "px-4 py-2.5 text-xs" };
    return `<button type="button" ${attrs(opts.data)}
      class="rounded-full font-semibold transition ${sizes[opts.size || "md"]} ${variants[opts.variant || "ghost"]} ${opts.class || ""}">${esc(label)}</button>`;
  };

  const iconBtn = (iconName, title, data) =>
    `<button type="button" title="${esc(title)}" ${attrs(data)}
       class="grid h-8 w-8 place-items-center rounded-full text-faint ring-1 ring-line-2 transition hover:bg-brand-soft hover:text-brand-fg hover:ring-brand-soft">${icon(iconName, "h-3.5 w-3.5")}</button>`;

  // ---------- page furniture ----------

  const page = (body) => `<div class="px-4 pb-6 sm:px-6 lg:px-7 lg:pb-8">${body}</div>`;

  const pageHead = (title, sub, actions = "") => `
    <div class="flex flex-wrap items-end justify-between gap-4 pb-5">
      <div>
        <h1 class="text-[22px] font-bold tracking-tight">${esc(title)}</h1>
        <p class="mt-1 text-sm text-faint">${sub}</p>
      </div>
      <div class="flex shrink-0 flex-wrap gap-2">${actions}</div>
    </div>`;

  const card = (title, sub, body, extra = "") => `
    <div class="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line ${extra}">
      ${title ? `<h2 class="text-[15px] font-bold tracking-tight">${esc(title)}</h2>` : ""}
      ${sub ? `<p class="mt-1 text-xs text-faint">${sub}</p>` : ""}
      <div class="${title ? "mt-5" : ""}">${body}</div>
    </div>`;

  // Semantic tones, resolved through a map rather than built by string
  // concatenation — the palette name never leaks into a component.
  const TONE = {
    ok:      { soft: "bg-ok-soft",      fg: "text-ok",       ring: "ring-ok-soft"      },
    warn:    { soft: "bg-warn-soft",    fg: "text-warn",     ring: "ring-warn-soft"    },
    bad:     { soft: "bg-bad-soft",     fg: "text-bad",      ring: "ring-bad-soft"     },
    info:    { soft: "bg-info-soft",    fg: "text-info",     ring: "ring-info-soft"    },
    alt:     { soft: "bg-alt-soft",     fg: "text-alt",      ring: "ring-alt-soft"     },
    brand:   { soft: "bg-brand-soft",   fg: "text-brand-fg", ring: "ring-brand-soft"   },
    neutral: { soft: "bg-neutral-soft", fg: "text-neutral",  ring: "ring-neutral-soft" }
  };

  const statTile = (tone, label, value, sub, iconName) => {
    const t = TONE[tone] || TONE.neutral;
    return `
    <div class="flex items-center gap-3.5 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
      <span class="grid h-11 w-11 shrink-0 place-items-center rounded-xl ${t.soft} ${t.fg}">${icon(iconName, "h-5 w-5")}</span>
      <div class="min-w-0">
        <p class="truncate text-sm font-bold">${esc(label)}</p>
        <p class="truncate text-xs text-faint">${esc(sub)}</p>
      </div>
      <span class="ml-auto shrink-0 text-2xl font-bold tracking-tight ${t.fg}">${value}</span>
    </div>`;
  };

  const notice = (tone, title, body) => {
    const t = TONE[tone] || TONE.neutral;
    return `
    <div class="mb-5 flex items-start gap-3 rounded-2xl ${t.soft} p-4 ring-1 ${t.ring}">
      <span class="mt-0.5 shrink-0 ${t.fg}">${icon("alert", "h-5 w-5")}</span>
      <div class="min-w-0">
        <p class="text-sm font-bold ${t.fg}">${esc(title)}</p>
        <p class="mt-0.5 text-xs ${t.fg} opacity-90">${body}</p>
      </div>
    </div>`;
  };

  // ---------- tables ----------

  const th = (label, extra = "") => `<th class="px-5 py-3 font-bold ${extra}">${esc(label)}</th>`;
  const td = (content, extra = "") => `<td class="px-5 py-3.5 ${extra}">${content}</td>`;
  const tr = (cells, data, extraClass = "") =>
    `<tr ${attrs(data)} class="transition hover:bg-subtle/60 ${extraClass}">${cells}</tr>`;

  // `narrow` drops the 880px floor for a table sharing a row with other
  // panels (e.g. a dashboard side column) — full-width tables want the
  // floor so columns don't crush; a side panel wants to fit its column.
  const table = (head, rows, emptyMessage, opts = {}) => rows.length ? `
    <div class="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
      <div class="overflow-x-auto">
        <table class="w-full text-left ${opts.narrow ? "" : "min-w-[880px]"}">
          <thead><tr class="border-b border-line text-[10px] font-bold tracking-[0.12em] text-faint">${head}</tr></thead>
          <tbody class="divide-y divide-line-soft">${rows.join("")}</tbody>
        </table>
      </div>
    </div>` : empty(emptyMessage || "Nothing to show here.");

  const empty = (message) => `
    <div class="rounded-2xl bg-surface p-12 text-center shadow-sm ring-1 ring-line">
      <p class="text-sm text-faint">${esc(message)}</p>
    </div>`;

  // ---------- forms ----------

  const field = (label, opts = {}) => `
    <label class="block ${opts.span ? "sm:col-span-2" : ""}">
      <span class="text-[11px] font-semibold text-muted">${esc(label)}</span>
      <input type="${opts.type || "text"}" ${attrs(opts.data)}
             value="${esc(opts.value || "")}" placeholder="${esc(opts.placeholder || "")}"
             class="mt-1.5 w-full rounded-xl bg-subtle px-3.5 py-2.5 text-sm text-ink-2 placeholder:text-faintest focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-soft" />
    </label>`;

  const select = (label, options, opts = {}) => `
    <label class="flex items-center justify-between gap-4">
      <span class="text-sm text-body">${esc(label)}</span>
      <select ${attrs(opts.data)}
        class="rounded-xl bg-subtle px-3 py-2 text-xs font-semibold text-ink-2 focus:outline-none focus:ring-2 focus:ring-brand-soft">
        ${options.map((o) => `<option value="${esc(o.value)}" ${o.value === opts.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
      </select>
    </label>`;

  const toggle = (on, data) =>
    `<button type="button" role="switch" aria-checked="${on ? "true" : "false"}" ${attrs(data)}
       class="relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-ok-strong" : "bg-line-2"}">
       <span class="absolute top-1 h-4 w-4 rounded-full bg-surface shadow transition-all ${on ? "left-6" : "left-1"}"></span></button>`;

  const checkbox = (label, hint, on, data) => `
    <label class="flex cursor-pointer items-start gap-3">
      <input type="checkbox" ${on ? "checked" : ""} ${attrs(data)} class="mt-0.5 h-4 w-4 rounded accent-brand-500" />
      <span><span class="block text-sm font-medium text-ink-2">${esc(label)}</span>
            ${hint ? `<span class="block text-xs text-faint">${esc(hint)}</span>` : ""}</span>
    </label>`;

  return {
    esc, dash, muted, chip, dotChip, jiraChip, filterChip, avatar, avatarStack, repoChip, repoStrip, bar,
    icon, iconBtn, btn, attrs,
    page, pageHead, card, statTile, notice, TONE,
    th, td, tr, table, empty,
    field, select, toggle, checkbox
  };
})();
