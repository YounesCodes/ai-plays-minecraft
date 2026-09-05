'use strict';

// Informational knowledge primitives. Read-only: they answer questions from
// the local minecraft-data knowledge layer or the fixed external reference
// provider. They never mutate the world, inventory, goals, or memory, and
// they never execute anything on the bot. Results become lastResult so the
// next cognition turn can use them.

const gameData = require('../knowledge/gameData');
const reference = require('../knowledge/reference');

function versionOf(bot) {
  return (bot && bot.version) || process.env.MC_VERSION || undefined;
}

async function lookupRecipe(bot, args) {
  const out = gameData.allRecipesFor(args.item, versionOf(bot));
  if (!out.ok) {
    return { ok: false, primitive: 'lookup_recipe', item: args.item, reason: out.reason, error: `Unknown item: ${args.item}` };
  }
  return { ok: true, primitive: 'lookup_recipe', ...out };
}

async function lookupUses(bot, args) {
  const out = gameData.usesOf(args.item, versionOf(bot));
  if (!out.ok) {
    return { ok: false, primitive: 'lookup_uses', item: args.item, reason: out.reason, error: `Unknown item: ${args.item}` };
  }
  return { ok: true, primitive: 'lookup_uses', ...out };
}

async function searchGameData(bot, args) {
  const out = gameData.searchGameData(args.query, versionOf(bot));
  if (!out.ok) {
    return { ok: false, primitive: 'search_game_data', query: args.query, reason: out.reason, error: 'Empty search query' };
  }
  return { ok: true, primitive: 'search_game_data', ...out };
}

async function lookupItem(bot, args) {
  const out = gameData.itemInfo(args.item, versionOf(bot));
  if (!out.ok) {
    return { ok: false, primitive: 'lookup_item', item: args.item, reason: out.reason, error: `Unknown item: ${args.item}` };
  }
  return { ok: true, primitive: 'lookup_item', ...out };
}

async function lookupBlock(bot, args) {
  const out = gameData.blockInfo(args.block, versionOf(bot));
  if (!out.ok) {
    return { ok: false, primitive: 'lookup_block', block: args.block, reason: out.reason, error: `Unknown block: ${args.block}` };
  }
  return { ok: true, primitive: 'lookup_block', ...out };
}

async function lookupMinecraftReference(bot, args) {
  void bot; // no bot access: pure read-only reference lookup
  const out = await reference.lookupReference(args.query);
  if (!out.ok) {
    return { ok: false, primitive: 'lookup_minecraft_reference', query: args.query, reason: out.reason || 'knowledge_unavailable', error: out.error || 'Reference provider unavailable' };
  }
  return { ok: true, primitive: 'lookup_minecraft_reference', ...out };
}

module.exports = { lookupRecipe, lookupUses, searchGameData, lookupItem, lookupBlock, lookupMinecraftReference };
