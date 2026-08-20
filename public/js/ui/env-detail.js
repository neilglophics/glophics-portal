/**
 * The expandable detail for one environment: a block per repository showing
 * whether it is free, offline, or held — and by which ticket.
 *
 * Shared by Environments and In use. Repositories of an environment are
 * independent (storefront can be on one ticket while backend is on another),
 * so this is the only place that renders that breakdown, and both pages stay
 * identical without either owning it.
 *
 * Open rows are tracked per page, so expanding something on one page does
 * not silently expand it on the other.
 */

const EnvDetail = (() => {
  const openByPage = {};

  function bucket(pageId) {
    return openByPage[pageId] || (openByPage[pageId] = new Set());
  }

  const isOpen = (pageId, envId) => bucket(pageId).has(envId);
  const openCount = (pageId) => bucket(pageId).size;

  function toggle(pageId, envId) {
    const set = bucket(pageId);
    if (set.has(envId)) set.delete(envId); else set.add(envId);
  }

  function expandAll(pageId, ids) { ids.forEach((id) => bucket(pageId).add(id)); }
  function collapseAll(pageId) { bucket(pageId).clear(); }

  // The twisty in the first cell of an expandable row.
  const caret = (open) => `
    <span class="grid h-5 w-5 shrink-0 place-items-center rounded-md text-faint transition ${
      open ? "rotate-90 bg-subtle-2 text-body" : ""}">${H.icon("chevron", "h-3 w-3")}</span>`;

  const repoLabel = (repoName, repo, held) => `
    <div class="flex w-40 shrink-0 items-center gap-2.5">
      ${H.repoChip({
        name: repoName,
        url: repo.url,
        state: repo.health === "offline" ? "offline" : !repo.url ? "no URL configured" : held ? "held" : "free",
        cls: repo.health === "offline" ? "bg-bad-strong/85 text-white"
          : !repo.url ? "bg-line-2 text-muted"
          : held ? "bg-warn-strong/85 text-white" : "bg-ok-strong/85 text-white"
      })}
      <span class="truncate text-xs font-semibold capitalize text-body">${H.esc(repoName)}</span>
    </div>`;

  // A repository nobody is holding — still shown, so it is obvious what is
  // bookable on an environment that is only partly held.
  function freeBlock(row, repoName, repo) {
    const offline = repo.health === "offline";
    return `<div class="flex flex-wrap items-center gap-3 rounded-xl bg-surface px-3 py-2.5 ring-1 ring-line">
      ${repoLabel(repoName, repo, false)}
      <span class="text-xs ${offline ? "font-medium text-bad" : !repo.url ? "text-faint" : "text-ok"}">
        ${offline ? "Offline — not bookable until it responds"
          : !repo.url ? "No URL configured" : "Available"}</span>
      <div class="ml-auto flex gap-2">
        ${!repo.url
          ? H.btn("Set URL", { size: "sm", data: { "data-action": "set-repo-url", "data-id": row.id, "data-repo": repoName } })
          : H.btn("Assign", { variant: "dark", size: "sm", data: { "data-action": "assign", "data-id": row.id } })}
      </div>
    </div>`;
  }

  function claimBlock(row, repoName, repo, claim, index) {
    const minutes = Model.minutesLeft(claim);
    const urgent = Model.isUrgent(minutes);
    return `<div class="flex flex-wrap items-center gap-3 rounded-xl bg-surface px-3 py-2.5 ring-1 ring-line">
      ${index === 0 ? repoLabel(repoName, repo, true)
        : `<div class="w-40 shrink-0 pl-11 text-[10px] font-semibold text-warn">also shared with</div>`}
      <button data-action="open-ticket" data-ticket="${H.esc(claim.id)}"
        class="w-24 shrink-0 text-left text-xs font-semibold text-brand-fg hover:underline">${H.esc(claim.id)}</button>
      <div class="w-36 shrink-0">${H.jiraChip(claim.status)}</div>
      <div class="w-24 shrink-0">${H.avatarStack(Model.peopleOf([claim]), 2)}</div>
      <div class="min-w-0 flex-1">
        <p class="truncate text-xs text-muted">${H.esc(claim.summary || claim.note || "—")}</p>
        <p class="text-[10px] text-faint">Held since ${H.esc(claim.startTime ? Format.formatDateTime(claim.startTime) : "—")}</p>
      </div>
      <span class="w-20 shrink-0 text-xs font-semibold ${urgent ? "text-warn" : "text-muted"}">${H.esc(Model.leftText(minutes))}</span>
      ${H.btn("Force free", { variant: "danger", size: "sm",
        data: { "data-action": "force-free-ticket", "data-ticket": claim.id } })}
    </div>`;
  }

  function repoBlocks(row) {
    return row.repoNames.map((repoName) => {
      const repo = row.server.repos[repoName];
      const claims = State.getRepoClaims(row.id, repoName);
      if (!claims.length) return freeBlock(row, repoName, repo);
      return claims.map((claim, i) => claimBlock(row, repoName, repo, claim, i)).join("");
    }).join("");
  }

  // Tickets Jira matched to this environment that are not at an occupying
  // status — on the branch, but holding nothing. Worth saying out loud: the
  // row reads as free while someone may already be working on it.
  function waitingNote(row) {
    if (!row.waiting.length) return "";
    const n = row.waiting.length;
    return `<p class="px-1 pt-3 text-[11px] text-faint">
      ${n} more ticket${n === 1 ? " is" : "s are"} on this branch but not at an occupying status,
      so ${n === 1 ? "it holds" : "they hold"} nothing:
      ${row.waiting.map((w) => H.esc(w.key)).join(", ")}.</p>`;
  }

  // The full-width row that follows an expanded environment.
  function detailRow(row, colspan) {
    return `<tr class="bg-subtle/60">
      <td colspan="${colspan}" class="px-5 pb-5 pt-1">
        <div class="ml-8 space-y-2">${repoBlocks(row)}</div>
        ${waitingNote(row)}
      </td>
    </tr>`;
  }

  return { isOpen, openCount, toggle, expandAll, collapseAll, caret, repoBlocks, detailRow };
})();

/* One toggle for every expandable table — the page is inferred, so neither
   Environments nor In use has to register its own. */

Actions.on("toggle-env", (el) => {
  EnvDetail.toggle(Router.currentId(), el.dataset.id);
  Router.render();
});

Actions.on("toggle-all-envs", () => {
  const pageId = Router.currentId();
  const page = Router.page(pageId);
  if (EnvDetail.openCount(pageId)) EnvDetail.collapseAll(pageId);
  else EnvDetail.expandAll(pageId, page && page.expandableIds ? page.expandableIds() : []);
  Router.render();
});
