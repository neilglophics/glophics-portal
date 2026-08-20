const claims = require("../services/claims.service.js");

async function create(ctx) {
  const body = await ctx.readBody();
  const claim = await claims.create(ctx, body.serverId, body);
  return { ok: true, ticket: claim };
}

async function release(ctx) {
  return claims.release(ctx, ctx.params.id);
}

async function releaseAllForServer(ctx) {
  return claims.releaseAllForServer(ctx, ctx.params.serverId);
}

module.exports = { create, release, releaseAllForServer };
