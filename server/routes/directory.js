const directory = require("../services/directory.service.js");

async function create(ctx) {
  const body = await ctx.readBody();
  const user = await directory.create(ctx, body);
  return { ok: true, user };
}

async function update(ctx) {
  const body = await ctx.readBody();
  const user = await directory.update(ctx, ctx.params.id, body);
  return { ok: true, user };
}

async function remove(ctx) {
  return directory.remove(ctx, ctx.params.id);
}

module.exports = { create, update, remove };
