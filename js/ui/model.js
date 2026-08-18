/**
 * View-models: the shapes the pages actually want, derived from State.
 *
 * Pages never walk `server.repos` or filter tickets themselves — they ask
 * Model for a row. That keeps "what counts as held" in one place, and means
 * a change to the data layer lands here rather than in seven page files.
 */

const Model = (() => {

  // ---------- environments ----------

  // One row per environment, with everything the tables and cards need.
  function envRow(server) {
    const account = State.getAccount(server.accountId);
    const claims = State.getServerTickets(server.id);
    const repoNames = Object.keys(server.repos);
    const held = new Set(claims.flatMap((c) => c.repos));
    const freeRepos = repoNames.filter((r) => !held.has(r));
    const offline = repoNames.filter((r) => server.repos[r].health === "offline");

    // The claim that frees up first is the one the row reports on.
    const withEnd = claims.filter((c) => c.endTime).sort((a, b) => new Date(a.endTime) - new Date(b.endTime));
    const withStart = claims.filter((c) => c.startTime).sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    return {
      server,
      id: server.id,
      name: server.name,
      account,
      accountName: account ? account.displayName : "—",
      state: State.getDisplayStatus(server),
      claims,
      repoNames,
      freeRepos,
      offline,
      waiting: State.getWaitingTickets(server.id),
      soonest: withEnd[0] || null,
      earliest: withStart[0] || null,
      people: peopleOf(claims),
      ticketIds: [...new Set(claims.map((c) => c.id))]
    };
  }

  function envRows() {
    return State.getServers().map(envRow);
  }

  function filteredEnvRows() {
    return State.getFilteredServers().map(envRow);
  }

  // ---------- repositories ----------

  // One row per repository across every environment — the health table.
  function repoRows() {
    const rows = [];
    State.getServers().forEach((server) => {
      const account = State.getAccount(server.accountId);
      Object.keys(server.repos).forEach((repoName) => {
        const repo = server.repos[repoName];
        rows.push({
          serverId: server.id,
          env: server.name,
          accountName: account ? account.displayName : "—",
          repo: repoName,
          url: repo.url || null,
          health: repo.health || (repo.url ? "checking" : "unconfigured"),
          claims: State.getRepoClaims(server.id, repoName),
          note: State.getRepoNote(server.id, repoName)
        });
      });
    });
    // A health page whose failures sit twenty rows down is not a health page.
    const rank = { offline: 0, checking: 1, unconfigured: 2, online: 3 };
    return rows.sort((a, b) =>
      (rank[a.health] - rank[b.health]) ||
      a.accountName.localeCompare(b.accountName) ||
      a.env.localeCompare(b.env) ||
      a.repo.localeCompare(b.repo));
  }

  // ---------- claims ----------

  // One row per (claim × repository) — what "in use" actually means.
  function claimRepoRows() {
    const rows = [];
    State.getServers().forEach((server) => {
      const account = State.getAccount(server.accountId);
      State.getServerTickets(server.id).forEach((claim) => {
        claim.repos.forEach((repo) => {
          rows.push({
            claim, repo, server,
            env: server.name,
            accountName: account ? account.displayName : "—",
            minutesLeft: minutesLeft(claim)
          });
        });
      });
    });
    // Soonest to free first — the question people actually ask.
    return rows.sort((a, b) => nullsLast(a.minutesLeft) - nullsLast(b.minutesLeft));
  }

  function allClaims() {
    return State.getServers().flatMap((s) => State.getServerTickets(s.id));
  }

  function claimRows() {
    return State.getServers().flatMap((server) => {
      const account = State.getAccount(server.accountId);
      return State.getServerTickets(server.id).map((claim) => ({
        claim, server,
        env: server.name,
        accountName: account ? account.displayName : "—",
        minutesLeft: minutesLeft(claim)
      }));
    }).sort((a, b) => nullsLast(a.minutesLeft) - nullsLast(b.minutesLeft));
  }

  // ---------- shared helpers ----------

  function minutesLeft(claim) {
    if (!claim.endTime) return null;
    return Math.round((new Date(claim.endTime).getTime() - Date.now()) / 60000);
  }

  function nullsLast(v) { return v === null ? Infinity : v; }

  // "3h 30m" — the bare duration, since the surrounding column already says
  // what it measures. Null end time means an open-ended manual claim.
  function leftText(minutes) {
    if (minutes === null || minutes === undefined) return "—";
    if (minutes <= 0) return "Expired";
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const m = minutes % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // How far through its booking a claim is, for the progress bars.
  function progress(claim) {
    if (!claim.startTime || !claim.endTime) return 0;
    const start = new Date(claim.startTime).getTime();
    const end = new Date(claim.endTime).getTime();
    if (end <= start) return 100;
    return Math.round(((Date.now() - start) / (end - start)) * 100);
  }

  const isUrgent = (minutes) => minutes !== null && minutes <= 120;

  // Unique people across a set of claims, as user records. Falls back to the
  // raw Jira assignee label when nobody matched a configured user.
  function peopleOf(claims) {
    const seen = new Map();
    claims.forEach((c) => {
      (c.userIds || []).forEach((id) => {
        const user = State.getUser(id);
        if (user && !seen.has(id)) seen.set(id, user);
      });
      if (!(c.userIds || []).length) {
        (c.rawAssignees || []).forEach((label) => {
          if (!seen.has(label)) seen.set(label, { id: label, name: label, unmatched: true });
        });
      }
    });
    return [...seen.values()];
  }

  // ---------- summary ----------

  function summary() {
    const rows = envRows();
    const repos = repoRows();
    const claims = allClaims();
    const soon = claims.filter((c) => {
      const m = minutesLeft(c);
      return m !== null && m > 0 && m < 120;
    });
    return {
      total: rows.length,
      free: rows.filter((r) => r.state === "free").length,
      partial: rows.filter((r) => r.state === "partial").length,
      inuse: rows.filter((r) => r.state === "inuse").length,
      issue: rows.filter((r) => r.state === "issue").length,
      held: rows.filter((r) => r.state !== "free").length,
      claims: claims.length,
      people: peopleOf(claims).length,
      soon: soon.length,
      repoTotal: repos.length,
      repoOnline: repos.filter((r) => r.health === "online").length,
      repoOffline: repos.filter((r) => r.health === "offline").length,
      repoUnconfigured: repos.filter((r) => r.health === "unconfigured").length,
      reposHeld: claimRepoRows().length,
      skipped: State.getSkippedTickets().length
    };
  }

  return {
    envRow, envRows, filteredEnvRows,
    repoRows, claimRepoRows, claimRows, allClaims,
    minutesLeft, leftText, progress, isUrgent, peopleOf, summary
  };
})();
