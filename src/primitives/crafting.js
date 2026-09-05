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
    // Structured diagnosis from the installed recipe APIs (no guessing):
    // recipesFor(..., true) answers "would materials suffice WITH a table?".
    // Table-required + materials-ready + no table nearby => the planner
    // must place/find a table, not farm more materials.
    let reason = 'missing_materials';
    try {
      if (typeof bot.recipesFor === 'function') {
        const withTable = bot.recipesFor(item.id, null, n, true) || [];
        if (withTable.length > 0 && !table) reason = 'crafting_table_required';
      }
    } catch {
      // keep default; diagnostics stay bounded, never throw
    }
    return {
      ok: false, primitive: 'craft_item', item: itemName, reason,
      error: reason === 'crafting_table_required'
        ? `Cannot craft ${itemName}: materials ready but no crafting table nearby (place one with place_block_nearby)`
        : `No recipe available for ${itemName} (missing materials)`,
    };
  }
  try {
    await bot.craft(recipes[0], n, table || null);
    const out = { ok: true, primitive: 'craft_item', item: itemName, crafted: n };
    // Trusted workstation fact: when a real table was used, report WHERE
    // it was so the loop can anchor/refresh station memory. Only present
    // when a table actually participated — never guessed.
    try {
      if (table && table.position && Number.isFinite(table.position.x)) {
        out.craftingTablePosition = {
          x: Math.round(table.position.x),
          y: Math.round(table.position.y),
          z: Math.round(table.position.z),
        };
      }
    } catch {
      // ignore
    }
    return out;
  } catch (err) {
    return { ok: false, primitive: 'craft_item', item: itemName, error: err?.message || 'Crafting failed' };
  }
}

module.exports = { craftItem };
