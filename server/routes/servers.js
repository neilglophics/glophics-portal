const servers = require("../services/servers.service.js");

async function create(ctx) {
  const body = await ctx.readBody();
  const server = await servers.create(ctx, body);
  return { ok: true, server };
}

async function update(ctx) {
  const body = await ctx.readBody();
  const server = await servers.update(ctx, ctx.params.id, body);
  return { ok: true, server };
}

async function remove(ctx) {
  return servers.remove(ctx, ctx.params.id);
}

async function setRepoUrl(ctx) {
  const body = await ctx.readBody();
  const repo = await servers.setRepoUrl(ctx, ctx.params.id, ctx.params.repo, body.url);
  return { ok: true, repo };
}

module.exports = { create, update, remove, setRepoUrl };
