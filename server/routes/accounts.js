const accounts = require("../services/accounts.service.js");

async function create(ctx) {
  const body = await ctx.readBody();
  const account = await accounts.create(ctx, body);
  return { ok: true, account, id: account.id };
}

async function update(ctx) {
  const body = await ctx.readBody();
  const account = await accounts.update(ctx, ctx.params.id, body);
  return { ok: true, account };
}

async function remove(ctx) {
  return accounts.remove(ctx, ctx.params.id);
}

module.exports = { create, update, remove };
