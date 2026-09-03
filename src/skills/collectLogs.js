'use strict';

function getLogLimit() {
  const v = parseInt(process.env.MAX_LOG_COLLECTION_AMOUNT || '8', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 64) : 8;
}

function getSearchDistance() {
  const v = parseInt(process.env.MAX_BLOCK_SEARCH_DISTANCE || '64', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 128) : 64;
}

function countLogs(bot) {
  let total = 0;
  try {
    for (const item of bot.inventory.items()) {
      if (item && typeof item.name === 'string' && item.name.endsWith('_log')) {
        total += item.count;
      }
    }
  } catch {
    // inventory not ready
  }
  return total;
}

function findLogBlock(bot, maxDistance) {
  try {
    return bot.findBlock({
      matching: (block) => block && typeof block.name === 'string' && block.name.endsWith('_log'),
      maxDistance,
    });
  } catch {
    return null;
  }
}

// Collect up to `amount` logs. Returns structured results for both
// success and ordinary Minecraft failures (no logs, no path, etc.).
async function collectLogs(bot, amount) {
  const limit = getLogLimit();
  let target = parseInt(amount, 10);
  if (!Number.isFinite(target)) {
    return { ok: false, collected: 0, error: 'amount must be an integer 1..' + limit };
  }
  target = Math.max(1, Math.min(limit, target));

  const maxDistance = getSearchDistance();
  const startCount = countLogs(bot);
  let collected = 0;

  for (let i = 0; i < target; i++) {
    const block = findLogBlock(bot, maxDistance);
    if (!block) {
      if (collected === 0 && countLogs(bot) === startCount) {
        return { ok: false, collected, error: `No log found within ${maxDistance} blocks` };
      }
      return { ok: collected > 0, collected, error: collected > 0 ? `Only ${collected} of ${target} logs collected; no more logs nearby` : `No log found within ${maxDistance} blocks` };
    }
    try {
      await bot.collectBlock.collect(block);
      collected = countLogs(bot) - startCount;
    } catch (err) {
      const msg = err && err.message ? err.message : 'Block collection failed';
      return { ok: false, collected, error: msg };
    }
    // Re-check: may have picked up extra logs per block; stop early.
    if (countLogs(bot) - startCount >= target) {
      collected = countLogs(bot) - startCount;
      break;
    }
  }

  collected = countLogs(bot) - startCount;
  return { ok: true, collected };
}

module.exports = { collectLogs, countLogs };
