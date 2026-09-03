'use strict';

// Mining primitives. Report objective outcomes (block broken? drop obtained?)
// so the agent can learn tool-tier lessons (e.g. stone pickaxe + diamond ore).

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

function countAll(bot) {
  const map = {};
  try {
    for (const item of bot.inventory.items()) {
      if (item && item.name) map[item.name] = (map[item.name] || 0) + item.count;
    }
  } catch {
    // ignore
  }
  return map;
}

function heldToolName(bot) {
  try {
    if (bot.heldItem && bot.heldItem.name) return bot.heldItem.name;
    if (bot.inventory?.heldItem?.name) return bot.inventory.heldItem.name;
  } catch {
    // ignore
  }
  return null;
}

function expectedDropFor(blockType) {
  const map = {
    diamond_ore: 'diamond',
    deepslate_diamond_ore: 'diamond',
    coal_ore: 'coal',
    deepslate_coal_ore: 'coal',
    iron_ore: 'raw_iron',
    deepslate_iron_ore: 'raw_iron',
    gold_ore: 'raw_gold',
    deepslate_gold_ore: 'raw_gold',
    nether_gold_ore: 'gold_nugget',
    redstone_ore: 'redstone',
    deepslate_redstone_ore: 'redstone',
    lapis_ore: 'lapis_lazuli',
    deepslate_lapis_ore: 'lapis_lazuli',
    emerald_ore: 'emerald',
    deepslate_emerald_ore: 'emerald',
  };
  return map[blockType] || null;
}

function withTimeout(promise, ms, primitive, extra = {}) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, primitive, timedOut: true, error: `Timed out after ${ms}ms`, ...extra }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

async function mineBlock(bot, args, ctx = {}) {
  const timeoutMs = ctx.timeoutMs || 45000;
  const before = countAll(bot);
  const tool = heldToolName(bot);
  const run = (async () => {
    try {
      let block = null;
      const pos = { x: Math.floor(args.x), y: Math.floor(args.y), z: Math.floor(args.z) };
      try {
        block = bot.blockAt && bot.blockAt(pos);
      } catch {
        block = null;
      }
      if (!block || block.name === 'air') {
        return { ok: false, primitive: 'mine_block', error: `No solid block at ${pos.x},${pos.y},${pos.z}`, tool };
      }
      const blockType = block.name;
      const expectedDrop = expectedDropFor(blockType);
      const startDrop = expectedDrop ? (before[expectedDrop] || 0) : null;
      try {
        if (typeof bot.dig === 'function') {
          await bot.dig(block);
        } else if (bot.collectBlock && typeof bot.collectBlock.collect === 'function') {
          await bot.collectBlock.collect(block);
        } else {
          return { ok: false, primitive: 'mine_block', block: blockType, tool, error: 'Dig unavailable' };
        }
      } catch (err) {
        return { ok: false, primitive: 'mine_block', block: blockType, tool, error: err?.message || 'Dig failed' };
      }
      const after = countAll(bot);
      let dropObtained = null;
      let expectedDropObserved = null;
      if (expectedDrop && startDrop !== null) {
        dropObtained = (after[expectedDrop] || 0) > startDrop;
        expectedDropObserved = dropObtained;
      }
      return {
        ok: true, primitive: 'mine_block', block: blockType, tool,
        blockBroken: true, dropObtained, expectedDropObserved,
      };
    } catch (err) {
      return { ok: false, primitive: 'mine_block', tool, error: err?.message || 'Mine failed' };
    }
  })();
  return withTimeout(run, timeoutMs, 'mine_block', { tool });
}

async function mineBlockType(bot, args, ctx = {}) {
  const timeoutMs = ctx.timeoutMs || 90000;
  const count = Math.max(1, Math.min(16, parseInt(args.count ?? 1, 10) || 1));
  const maxDistance = Math.min(128, Number(ctx.maxBlockSearchDistance) || parseInt(process.env.MAX_BLOCK_SEARCH_DISTANCE || '64', 10) || 64);
  const blockType = args.blockType;
  const expectedDrop = expectedDropFor(blockType);
  const tool = heldToolName(bot);
  const run = (async () => {
    const startCount = expectedDrop ? countItem(bot, expectedDrop) : countItem(bot, blockType);
    let broken = 0;
    for (let i = 0; i < count; i++) {
      let block = null;
      try {
        block = bot.findBlock({ matching: blockType, maxDistance });
      } catch {
        block = null;
      }
      if (!block) {
        const msg = `No ${blockType} found within ${maxDistance} blocks`;
        return {
          ok: false, primitive: 'mine_block_type', block: blockType, tool,
          broken, error: broken > 0 ? `Only broke ${broken} of ${count}; ${msg.charAt(0).toLowerCase()}${msg.slice(1)}` : msg,
        };
      }
      try {
        if (typeof bot.dig === 'function') {
          await bot.dig(block);
        } else if (bot.collectBlock && typeof bot.collectBlock.collect === 'function') {
          await bot.collectBlock.collect(block);
        } else {
          return { ok: false, primitive: 'mine_block_type', block: blockType, tool, broken, error: 'Dig unavailable' };
        }
        broken += 1;
      } catch (err) {
        return { ok: false, primitive: 'mine_block_type', block: blockType, tool, broken, error: err?.message || 'Dig failed' };
      }
    }
    const endCount = expectedDrop ? countItem(bot, expectedDrop) : countItem(bot, blockType);
    const dropObtained = expectedDrop ? endCount > startCount : endCount > startCount;
    return {
      ok: true, primitive: 'mine_block_type', block: blockType, tool,
      broken, dropObtained, expectedDropObserved: expectedDrop ? dropObtained : null,
    };
  })();
  return withTimeout(run, timeoutMs, 'mine_block_type', { block: blockType, tool });
}

module.exports = { mineBlock, mineBlockType, expectedDropFor };
