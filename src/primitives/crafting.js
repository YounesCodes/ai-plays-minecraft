'use strict';

const { matchBlockName, findItemOrBlock } = require('../blocks');

// Crafting primitive (trusted): recipe lookup + craft, bounded count.

function getMinecraftData(version) {
  try {
    return require('minecraft-data')(version);
  } catch {
    return null;
  }
}

async function craftItem(bot, args) {
  const itemName = args.item;
  const n = Math.max(1, Math.min(64, parseInt(args.count ?? 1, 10) || 1));
  const mcData = getMinecraftData(bot.version);
  if (!mcData) {
    return { ok: false, primitive: 'craft_item', item: itemName, error: `Unsupported Minecraft version: ${bot.version}` };
  }
  const item = findItemOrBlock(mcData, itemName);
  if (!item) {
    return { ok: false, primitive: 'craft_item', item: itemName, error: `Unknown item: ${itemName}` };
  }
  let table = null;
  try {
    if (typeof bot.findBlock === 'function') {
      table = bot.findBlock({ matching: matchBlockName('crafting_table'), maxDistance: 6 });
    }
  } catch {
    table = null;
  }
  let recipes = [];
  try {
    if (typeof bot.recipesFor !== 'function') {
      return { ok: false, primitive: 'craft_item', item: itemName, error: 'Recipe lookup unavailable' };
    }
    recipes = bot.recipesFor(item.id, null, n, table || null) || [];
  } catch (err) {
    return { ok: false, primitive: 'craft_item', item: itemName, error: err?.message || 'Failed to look up recipe' };
  }
  if (recipes.length === 0) {
    return {
      ok: false, primitive: 'craft_item', item: itemName,
      error: table
        ? `No recipe available for ${itemName} (missing materials)`
        : `No recipe available for ${itemName} (need materials or crafting table nearby)`,
    };
  }
  try {
    await bot.craft(recipes[0], n, table || null);
    return { ok: true, primitive: 'craft_item', item: itemName, crafted: n };
  } catch (err) {
    return { ok: false, primitive: 'craft_item', item: itemName, error: err?.message || 'Crafting failed' };
  }
}

module.exports = { craftItem };
