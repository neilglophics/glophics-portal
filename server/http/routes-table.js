/**
 * Every /api/ route, in one table.
 *
 * Each entry declares exactly one access rule -- `public: true`,
 * `capability: "<name>"`, or `authenticated: true` for a route that needs a
 * session but no particular capability. Router.assertSound() checks this at
 * startup and refuses to run if any route is missing one; see
 * server/http/router.js for why that is the point.
 */

const auth = require("../routes/auth.js");
const board = require("../routes/board.js");
const claims = require("../routes/claims.js");
const notes = require("../routes/notes.js");
const servers = require("../routes/servers.js");
const accounts = require("../routes/accounts.js");
const directory = require("../routes/directory.js");
const settings = require("../routes/settings.js");
const jira = require("../routes/jira.js");
const health = require("../routes/health.js");

function buildRoutes({ sseHub }) {
  return [
    // ---------------------------------------------------------- auth -----
    { method: "POST", path: "/api/auth/login", public: true, csrf: "origin-only", handler: auth.login, id: "auth.login" },
    { method: "POST", path: "/api/auth/logout", public: true, handler: auth.logout, id: "auth.logout" },
    { method: "GET", path: "/api/auth/me", public: true, handler: auth.me, id: "auth.me" },
    { method: "POST", path: "/api/auth/password", authenticated: true, handler: auth.changeOwnPassword, id: "auth.password" },
    { method: "GET", path: "/api/auth/users", capability: "manage-users", handler: auth.listUsers, id: "auth.users.list" },
    { method: "POST", path: "/api/auth/users", capability: "manage-users", handler: auth.createUser, id: "auth.users.create" },
    { method: "POST", path: "/api/auth/users/:id", capability: "manage-users", handler: auth.updateUser, id: "auth.users.update" },
    { method: "DELETE", path: "/api/auth/users/:id", capability: "manage-users", handler: auth.removeUser, id: "auth.users.remove" },
    { method: "POST", path: "/api/auth/users/:id/password", capability: "manage-users", handler: auth.resetPassword, id: "auth.users.resetPassword" },

    // --------------------------------------------------------- board -----
    { method: "GET", path: "/api/state", capability: "view", handler: board.getState, id: "board.state" },
    { method: "GET", path: "/api/events", capability: "view", handler: board.makeStreamHandler(sseHub), id: "board.stream" },
    { method: "POST", path: "/api/health/check-now", capability: "view", handler: health.checkNow, id: "health.checkNow" },

    // -------------------------------------------------------- claims -----
    { method: "POST", path: "/api/claims", capability: "claim", handler: claims.create, id: "claims.create" },
    { method: "DELETE", path: "/api/claims/:id", capability: "claim", handler: claims.release, id: "claims.release" },
    { method: "DELETE", path: "/api/servers/:serverId/claims", capability: "claim", handler: claims.releaseAllForServer, id: "claims.releaseAllForServer" },

    // --------------------------------------------------------- notes -----
    { method: "PUT", path: "/api/servers/:serverId/repos/:repo/note", capability: "claim", handler: notes.set, id: "notes.set" },

    // ------------------------------------------------------- servers -----
    { method: "POST", path: "/api/servers", capability: "configure", handler: servers.create, id: "servers.create" },
    { method: "PATCH", path: "/api/servers/:id", capability: "configure", handler: servers.update, id: "servers.update" },
    { method: "DELETE", path: "/api/servers/:id", capability: "configure", handler: servers.remove, id: "servers.remove" },
    { method: "PUT", path: "/api/servers/:id/repos/:repo/url", capability: "configure", handler: servers.setRepoUrl, id: "servers.setRepoUrl" },

    // ------------------------------------------------------ accounts -----
    { method: "POST", path: "/api/accounts", capability: "configure", handler: accounts.create, id: "accounts.create" },
    { method: "PATCH", path: "/api/accounts/:id", capability: "configure", handler: accounts.update, id: "accounts.update" },
    { method: "DELETE", path: "/api/accounts/:id", capability: "configure", handler: accounts.remove, id: "accounts.remove" },

    // ----------------------------------------------------- directory -----
    { method: "POST", path: "/api/directory/users", capability: "configure", handler: directory.create, id: "directory.create" },
    { method: "PATCH", path: "/api/directory/users/:id", capability: "configure", handler: directory.update, id: "directory.update" },
    { method: "DELETE", path: "/api/directory/users/:id", capability: "configure", handler: directory.remove, id: "directory.remove" },

    // ------------------------------------------------------ settings -----
    { method: "PATCH", path: "/api/settings", capability: "configure", handler: settings.update, id: "settings.update" },

    // ----------------------------------------------------------- jira -----
    { method: "GET", path: "/api/jira-config", capability: "view", handler: jira.getConfig, id: "jira.config.get" },
    { method: "POST", path: "/api/jira-config", capability: "configure", handler: jira.updateConfig, id: "jira.config.update" },
    { method: "POST", path: "/api/jira-config/test", capability: "configure", handler: jira.testConfig, id: "jira.config.test" },
    { method: "POST", path: "/api/jira/comment", capability: "claim", handler: jira.comment, id: "jira.comment" },
    { method: "POST", path: "/api/jira/sync-now", capability: "view", handler: jira.syncNow, id: "jira.syncNow" },
    { method: "GET", path: "/api/jira/:key", capability: "view", handler: jira.lookup, id: "jira.lookup" }
  ];
}

module.exports = { buildRoutes };
