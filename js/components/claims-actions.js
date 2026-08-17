/**
 * Actions on a claim/ticket that apply regardless of which view triggered
 * them (table row, board card, details modal) — force-free, opening a
 * ticket in Jira, copying a repo URL. Kept separate from any one view so
 * EnvTable/EnvBoard/RepoClaims all call the same logic instead of each
 * re-implementing it.
 */

const ClaimsActions = (() => {

  function copyUrl(button) {
    const url = button.dataset.url;
    if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
    const original = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = original; }, 1500);
  }

  async function openInJira(key) {
    try {
      const res = await fetch("/api/jira-config");
      const config = await res.json();
      if (!config.baseUrl) return;
      const base = /^https?:\/\//i.test(config.baseUrl) ? config.baseUrl : `https://${config.baseUrl}`;
      window.open(`${base.replace(/\/$/, "")}/browse/${encodeURIComponent(key)}`, "_blank", "noopener");
    } catch (err) {
      // no server / not configured — nothing to open
    }
  }

  function commentIfNeeded(ticket) {
    const jira = State.getSettings().jira;
    if (ticket && ticket.source === "jira" && jira.enabled && jira.commentOnRelease) {
      fetch("/api/jira/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: ticket.id, comment: `${ticket.branch || "Environment"} was force-freed.` })
      }).catch(() => {});
    }
  }

  function confirmForceFreeTicket(ticketId) {
    const ticket = State.getTicket(ticketId);
    if (!ticket) return;
    const names = ticket.userIds.map((id) => State.getUser(id)?.name).filter(Boolean).join(", ");
    ConfirmModal.open({
      title: "Force free this claim?",
      message: `${ticket.id} is claiming ${ticket.repos.join(", ")}${names ? ` for ${names}` : ""}. If this is a live Jira ticket still at an occupying status, the next sync may re-claim it.`,
      confirmLabel: "Force free",
      onConfirm: () => {
        commentIfNeeded(ticket);
        State.forceFreeTicket(ticketId);
      }
    });
  }

  function confirmForceFreeServer(serverId) {
    const server = State.getServer(serverId);
    if (!server) return;
    const claims = State.getServerTickets(serverId);
    ConfirmModal.open({
      title: "Force free this environment?",
      message: `This removes all ${claims.length} active claim${claims.length === 1 ? "" : "s"} on ${server.name}. Live Jira tickets still at an occupying status may be re-claimed on the next sync.`,
      confirmLabel: "Force free all",
      onConfirm: () => {
        claims.forEach(commentIfNeeded);
        State.forceFreeServer(serverId);
      }
    });
  }

  return { copyUrl, openInJira, confirmForceFreeTicket, confirmForceFreeServer };
})();
