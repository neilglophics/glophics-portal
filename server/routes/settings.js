const settings = require("../services/settings.service.js");

async function update(ctx) {
  const body = await ctx.readBody();
  const next = await settings.update(ctx, body);
  return { ok: true, settings: next };
}

module.exports = { update };
