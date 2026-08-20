const notes = require("../services/notes.service.js");

async function set(ctx) {
  const body = await ctx.readBody();
  return notes.set(ctx, ctx.params.serverId, ctx.params.repo, body.text);
}

module.exports = { set };
