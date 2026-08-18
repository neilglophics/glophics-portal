/**
 * Every colour, label and icon the UI uses. Views never hardcode a class
 * string — they ask for a token — so a palette change happens here and
 * nowhere else.
 *
 * Values are Tailwind utility strings because views compose HTML directly.
 */

const Tokens = (() => {

  // Derived environment status, from State.getDisplayStatus().
  const ENV_STATE = {
    free:    { label: "Free",        chip: "bg-ok-soft text-ok", dot: "bg-emerald-500", bar: "bg-emerald-500", tone: "ok" },
    partial: { label: "Partly free", chip: "bg-brand-soft text-brand-fg",     dot: "bg-brand-500",   bar: "bg-brand-500",   tone: "brand"   },
    inuse:   { label: "In use",      chip: "bg-warn-soft text-warn",     dot: "bg-amber-500",   bar: "bg-amber-500",   tone: "warn"   },
    issue:   { label: "Server down", chip: "bg-bad-soft text-bad",       dot: "bg-rose-500",    bar: "bg-rose-500",    tone: "bad"    }
  };

  // Per-repo reachability, from server.repos[name].health.
  const HEALTH = {
    online:       { label: "Online",         chip: "bg-ok-soft text-ok", dot: "bg-emerald-500" },
    offline:      { label: "Offline",        chip: "bg-bad-soft text-bad",       dot: "bg-rose-500"    },
    checking:     { label: "Checking",       chip: "bg-subtle-2 text-muted",    dot: "bg-faint"   },
    unconfigured: { label: "No URL set",     chip: "bg-subtle-2 text-muted",    dot: "bg-faintest"   }
  };

  // Jira workflow statuses arrive in Jira's own casing ("QA Testing (Stg)"),
  // so matching is case-insensitive and anything unknown gets a neutral chip.
  const JIRA_CHIPS = {
    "qa testing (dev)": "bg-info-soft text-info",
    "qa testing (stg)": "bg-alt-soft text-alt",
    "qa testing (live)": "bg-ok-soft text-ok",
    "final checking":   "bg-ok-soft text-ok",
    "done":             "bg-ok-soft text-ok",
    "qa failed":        "bg-bad-soft text-bad"
  };

  function jiraChip(status) {
    return JIRA_CHIPS[String(status || "").trim().toLowerCase()] || "bg-subtle-2 text-muted";
  }

  // Avatar colour is derived from the user id so a person keeps the same
  // colour everywhere, across reloads, without storing anything.
  const AVATAR_TONES = [
    "bg-violet-100 text-alt",
    "bg-blue-100 text-info",
    "bg-ok-soft text-ok",
    "bg-warn-soft text-warn",
    "bg-bad-soft text-bad",
    "bg-teal-100 text-ok"
  ];

  function avatarTone(key) {
    let hash = 0;
    for (let i = 0; i < String(key).length; i++) hash = (hash * 31 + String(key).charCodeAt(i)) >>> 0;
    return AVATAR_TONES[hash % AVATAR_TONES.length];
  }

  // Repo chips are too narrow for full names. Known repos get the label the
  // team already uses; anything custom falls back to its first three letters.
  const REPO_SHORT = { storefront: "SF", backend: "API", admin: "ADM" };
  function shortRepo(name) {
    return REPO_SHORT[name] || String(name).slice(0, 3).toUpperCase();
  }

  // Initials for an avatar, from names shaped like "[BE]_Sem".
  function initials(name) {
    const bare = String(name || "").replace(/^\[[^\]]*\]_?/, "").trim();
    const parts = bare.split(/[\s_.-]+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  const ICONS = {
    grid:     '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    servers:  '<rect x="2.5" y="5" width="19" height="6" rx="2"/><rect x="2.5" y="14" width="19" height="6" rx="2"/>',
    pulse:    '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
    clock:    '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    list:     '<path d="M4 6h16M4 12h16M4 18h10"/>',
    alert:    '<path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="8.5"/>',
    gear:     '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3"/>',
    check:    '<path d="M4 12.5l5 5L20 6.5"/>',
    plug:     '<path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 01-12 0z"/><path d="M12 18v3"/>',
    refresh:  '<path d="M20 11a8 8 0 10-2.3 5.6"/><path d="M20 4.5V11h-6.5"/>',
    search:   '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
    bell:     '<path d="M18 8.5a6 6 0 10-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5z"/><path d="M10.5 19a2 2 0 003 0"/>',
    logout:   '<path d="M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 01-2-2V6a2 2 0 012-2h6"/>',
    external: '<path d="M7 17L17 7M9 7h8v8"/>',
    note:     '<path d="M4 4.5h16v11l-4 4H4z"/><path d="M20 15.5h-4v4"/>',
    copy:     '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
    close:    '<path d="M6 6l12 12M18 6L6 18"/>',
    chevron:  '<path d="M9 5l7 7-7 7"/>',
    plus:     '<path d="M12 5v14M5 12h14"/>'
  };

  return { ENV_STATE, HEALTH, jiraChip, avatarTone, shortRepo, initials, ICONS };
})();
