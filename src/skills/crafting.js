'use strict';

function getMinecraftData(version) {
  try {
    return require('minecraft-data')(version);
  } catch {
    return null;
  }
}

// Craft `count` of `itemName`. Structured for future expansion; the v1
// goal (collect logs) does not require crafting.
async function craftItem(bot, itemName, count = 1) {
  if (typeof itemName !== 'string' || !/^[a-z0-9_]+$/.test(itemName)) {
    return { ok: false, error: 'Invalid itemName' };
  }
  let n = parseInt(count, 10);
  if (!Number.isFinite(n) || n < 1) {
    return { ok: false, error: 'count must be an integer >= 1' };
  }
  n = Math.min(n, 64);

  const mcData = getMinecraftData(bot.version);
  if (!mcData) {
    return { ok: false, error: `Unsupported Minecraft version: ${bot.version}` };
  }
  const item = mcData.findItemOrBlockByName(itemName);
  if (!item) {
    return { ok: false, error: `Unknown item: ${itemName}` };
  }

  let table = null;
  try {
    table = bot.findBlock({ matching: 'crafting_table', maxDistance: 6 });
  } catch {
    table = null;
  }

  let recipes = [];
  try {
    recipes = bot.recipesFor(item.id, null, n, table || null) || [];
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Failed to look up recipe' };
  }
  if (recipes.length === 0) {
    if (!table) {
      // Check whether a table would help before failing.
      return { ok: false, error: `No recipe available for ${itemName} (need materials or crafting table nearby)` };
    }
    return { ok: false, error: `No recipe available for ${itemName} (missing materials)` };
  }

  try {
    await bot.craft(recipes[0], n, table || null);
    return { ok: true, crafted: n, item: itemName };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Crafting failed' };
  }
}

module.exports = { craftItem };
