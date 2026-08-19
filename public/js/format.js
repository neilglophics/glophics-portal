/**
 * Pure formatting/escaping helpers shared by every component. No DOM
 * mutation and no State mutation happens here — components call these to
 * turn data into strings, nothing more.
 */

const Format = (() => {

  const STATUS_LABEL = { free: "Free", partial: "Partly free", inuse: "In use", issue: "Server down" };

  // Per-Jira-status color coding for claim badges — matches the design's
  // QA TESTING (DEV)/​(STG) distinction (blue vs. purple) rather than one
  // flat color for every status.
  const STATUS_COLOR = {
    "QA TESTING (DEV)": { bg: "#e8eef5", fg: "#2a5d8f" },
    "QA TESTING (STG)": { bg: "#ece7f6", fg: "#5b47a0" }
  };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function formatClock(date) {
    return date.toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  }

  function formatDateTime(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  function remaining(endIso) {
    const diffMs = new Date(endIso).getTime() - Date.now();
    if (diffMs <= 0) return { text: "Expired", level: "expired" };
    const totalMinutes = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const mins = totalMinutes % 60;
    let text;
    if (days > 0) text = `Ends in ${days}d ${hours}h`;
    else if (hours > 0) text = `Ends in ${hours}h ${mins}m`;
    else text = `Ends in ${mins}m`;
    const level = diffMs < 3600000 ? "warning" : "ok";
    return { text, level };
  }

  function agoText(iso) {
    const diffMs = Date.now() - new Date(iso).getTime();
    if (diffMs < 0) return "just now";
    const secs = Math.floor(diffMs / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  function userNames(userIds) {
    return userIds.map((id) => State.getUser(id)).filter(Boolean).map((u) => u.name).join(", ");
  }

  function pillHtml(status) {
    return `<span class="pill pill-${status}"><span class="dot"></span>${STATUS_LABEL[status]}</span>`;
  }

  // Jira reports statuses in its own casing ("QA Testing (Stg)"), so the
  // palette is matched case-insensitively rather than by exact key.
  function statusColor(status) {
    if (!status) return null;
    const key = Object.keys(STATUS_COLOR).find((k) => k.toLowerCase() === String(status).trim().toLowerCase());
    return key ? STATUS_COLOR[key] : null;
  }

  function statusTextStyle(status) {
    const c = statusColor(status);
    return c ? `color:${c.fg}` : "";
  }

  function statusBadgeStyle(status) {
    const c = statusColor(status);
    return c ? `background:${c.bg};color:${c.fg}` : "";
  }

  function repoUrlOrigin(url) {
    try { return new URL(url).origin + new URL(url).pathname; } catch (err) { return url; }
  }

  return {
    STATUS_LABEL,
    escapeHtml, formatClock, formatDateTime, remaining, agoText,
    userNames, pillHtml, statusBadgeStyle, statusTextStyle, repoUrlOrigin
  };
})();
