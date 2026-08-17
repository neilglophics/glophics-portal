/**
 * Jira sync/refresh bar: manual refresh, auto-refresh toggle, the
 * occupies/frees explainer, and the skipped-tickets diagnostics panel —
 * all on one row, with the diagnostics sitting to the right of the
 * explainer so a mis-filled ticket is visible without opening anything.
 */

const SyncBar = (() => {
  const { escapeHtml, agoText, statusTextStyle } = Format;
  function el(id) { return document.getElementById(id); }

  // "A", "A or B", "A, B or C" — the explainer reads as a sentence, so the
  // status lists have to as well.
  function joinOr(list) {
    const parts = list.map((s) => `<strong style="${statusTextStyle(s)}">${escapeHtml(s)}</strong>`);
    if (!parts.length) return "<strong>—</strong>";
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
  }

  function render() {
    const jira = State.getSettings().jira;

    const pill = el("jira-autosync-toggle");
    const mins = jira.pollIntervalMinutes || 1;
    pill.classList.toggle("on", !!jira.autoSync);
    pill.setAttribute("aria-checked", jira.autoSync ? "true" : "false");
    pill.textContent = jira.autoSync
      ? `Auto-refresh every ${mins} min`
      : "Auto-refresh off";

    const ageEl = el("jira-sync-age");
    if (!jira.enabled) {
      ageEl.textContent = "Jira integration is off";
    } else {
      const last = State.getLastJiraSyncAt();
      ageEl.textContent = last ? `Jira synced ${agoText(last)} ago` : "Not synced yet";
    }

    const occ = jira.occupyingStatuses || [];
    const free = jira.releasingStatuses || [];
    el("jira-sync-explain").innerHTML = jira.enabled
      ? `A ticket appears here only while its status is ${joinOr(occ)}, and it leaves — freeing the repository — at ${joinOr(free)}. Matching needs Account Name, Branch, Repository and Status all filled correctly on the ticket.`
      : "Turn on Jira in Settings so matching tickets auto-populate environments.";

    const skipped = State.getSkippedTickets();
    const panel = el("skipped-panel");
    if (!jira.enabled || !skipped.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    el("skipped-title").textContent = `${skipped.length} ticket${skipped.length === 1 ? "" : "s"} not tracked`;
    el("skipped-list").innerHTML = skipped
      .map((s) => `<li><span class="mono">${escapeHtml(s.key)}</span> — ${escapeHtml(s.reason)}</li>`)
      .join("");
  }

  function bindEvents() {
    let syncing = false;
    el("jira-sync-refresh").addEventListener("click", async () => {
      if (syncing) return;
      syncing = true;
      const btn = el("jira-sync-refresh");
      const original = btn.textContent;
      btn.textContent = "Syncing…";
      btn.disabled = true;
      try {
        await fetch("/api/jira/sync-now", { method: "POST" });
      } catch (err) {
        // ignore — sync bar just won't advance its "synced Xs ago" text
      }
      btn.textContent = original;
      btn.disabled = false;
      syncing = false;
      render();
    });

    el("jira-autosync-toggle").addEventListener("click", () => {
      State.updateJiraOptions({ autoSync: !State.getSettings().jira.autoSync });
    });

    // Keeps "synced Xs ago" fresh between actual syncs, not just when one completes.
    setInterval(render, 15000);
  }

  return { render, bindEvents };
})();
