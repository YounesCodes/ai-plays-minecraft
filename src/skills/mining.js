'use strict';

// Generic single-block-type mining abstraction built on collectblock.
// Intentionally simple: no cave exploration, no tool management yet.
function getSearchDistance() {
  const v = parseInt(process.env.MAX_BLOCK_SEARCH_DISTANCE || '64', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 128) : 64;
}

function countItem(bot, itemName) {
  let total = 0;
  try {
    for (const item of bot.inventory.items()) {
      if (item && item.name === itemName) total += item.count;
    }
  } catch {
    // inventory not ready
  }
  return total;
}

async function mineBlockType(bot, blockName, amount = 1) {
  if (typeof blockName !== 'string' || !/^[a-z0-9_]+$/.test(blockName)) {
    return { ok: false, collected: 0, error: 'Invalid blockName' };
  }
  let target = parseInt(amount, 10);
  if (!Number.isFinite(target) || target < 1) {
    return { ok: false, collected: 0, error: 'amount must be an integer >= 1' };
  }
  target = Math.min(target, 64);

  const maxDistance = getSearchDistance();
  const startCount = countItem(bot, blockName);
  let collected = 0;

  for (let i = 0; i < target; i++) {
    let block = null;
    try {
      block = bot.findBlock({ matching: blockName, maxDistance });
    } catch {
      block = null;
    }
    if (!block) {
      const msg = `No ${blockName} found within ${maxDistance} blocks`;
      return collected > 0
        ? { ok: false, collected, error: `Only ${collected} of ${target} collected; ${msg.charAt(0).toLowerCase()}${msg.slice(1)}` }
        : { ok: false, collected: 0, error: msg };
    }
    try {
      await bot.collectBlock.collect(block);
      collected = countItem(bot, blockName) - startCount;
    } catch (err) {
      return { ok: false, collected, error: err && err.message ? err.message : 'Block collection failed' };
    }
  }

  collected = countItem(bot, blockName) - startCount;
  return { ok: true, collected };
}

module.exports = { mineBlockType };
