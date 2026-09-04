'use strict';

// Mining primitives. Report objective outcomes (block broken? drop spawned?
// drop collected? tool suitable?) so the agent learns true tool-tier lessons
// instead of concluding a tool is wrong when a drop merely sat uncollected.

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

function countTotalInventory(bot) {
  let total = 0;
  try {
    for (const item of bot.inventory.items()) {
      if (item && Number.isFinite(item.count)) total += item.count;
    }
  } catch {
    // inventory not ready
  }
  return total;
}

const { raceWithAbort } = require('./movement');
const { matchBlockName } = require('../blocks');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortedCheck(ctx) {
  try {
    if (ctx && typeof ctx.shouldAbort === 'function') return ctx.shouldAbort() || null;
  } catch {
    // ignore
  }
  return null;
}

function snapshotEntityIds(bot) {
  try {
    return new Set(Object.keys(bot.entities || {}));
  } catch {
    return new Set();
  }
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

// Buffer item-drop events near a position. Combined with the entity-diff in
// collectDrops this identifies fresh drops by timing + proximity, with no
// fragile NBT probing (the expected item itself is verified via inventory).
function watchDrops(bot, pos, radius) {
  const seen = [];
  const near = (p) => {
    if (!p) return false;
    const dx = p.x - pos.x;
    const dy = p.y - pos.y;
    const dz = p.z - pos.z;
    return dx * dx + dy * dy + dz * dz <= radius * radius;
  };
  const onDrop = (entity) => {
    try {
      if (entity && near(entity.position)) seen.push(entity);
    } catch {
      // ignore
    }
  };
  if (bot && typeof bot.on === 'function' && typeof bot.removeListener === 'function') {
    try {
      bot.on('itemDrop', onDrop);
    } catch {
      // ignore
    }
  }
  return {
    seen,
    stop() {
      try {
        if (bot && typeof bot.removeListener === 'function') bot.removeListener('itemDrop', onDrop);
      } catch {
        // ignore
      }
    },
  };
}

function collectDrops(bot, watch, beforeIds, pos, radius = 5) {
  const out = [...watch.seen];
  let entities = {};
  try {
    entities = bot.entities || {};
  } catch {
    return out;
  }
  for (const [id, e] of Object.entries(entities)) {
    if (beforeIds.has(id)) continue;
    try {
      const p = e && e.position;
      if (!p) continue;
      const dx = p.x - pos.x;
      const dy = p.y - pos.y;
      const dz = p.z - pos.z;
      if (dx * dx + dy * dy + dz * dz <= radius * radius) out.push(e);
    } catch {
      // ignore
    }
  }
  return out;
}

function getGoalNear() {
  try {
    const pf = require('mineflayer-pathfinder');
    if (pf && pf.goals && typeof pf.goals.GoalNear === 'function') return pf.goals.GoalNear;
  } catch {
    // ignore; caller treats missing pathfinder as already-adjacent
  }
  return null;
}

async function walkToDrop(bot, dropPos) {
  try {
    if (!bot.pathfinder || typeof bot.pathfinder.goto !== 'function') return false;
    const GoalNear = getGoalNear();
    if (!GoalNear) return false;
    const goal = new GoalNear(Math.floor(dropPos.x), Math.floor(dropPos.y), Math.floor(dropPos.z), 2);
    let timer = null;
    try {
      const arrived = await Promise.race([
        bot.pathfinder.goto(goal).then(() => true),
        sleep(6000).then(() => false),
      ]);
      return arrived;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      try {
        if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop();
      } catch {
        // ignore
      }
    }
  } catch {
    return false;
  }
}

// Break one block and deliberately collect its drop. Reports staged truth:
// blockBroken (dig worked), dropSpawned (an item entity appeared),
// dropCollected (expected item reached inventory), toolWasSuitable (false
// ONLY when a break produced no drop at all — never blame the tool for an
// uncollected drop sitting on the ground).
async function breakOne(bot, block, ctx = {}) {
  const tool = heldToolName(bot);
  const blockType = block.name;
  const expectedDrop = expectedDropFor(blockType);
  const pos = block.position;
  const abort = abortedCheck(ctx);
  if (abort) {
    return { blockBroken: false, tool, aborted: true, error: `Aborted before dig (${abort.type || 'abort'})` };
  }
  const beforeIds = snapshotEntityIds(bot);
  const watch = watchDrops(bot, pos, 5);
  const startDrop = expectedDrop ? countItem(bot, expectedDrop) : null;
  const totalBefore = countTotalInventory(bot);
  try {
    if (typeof bot.dig === 'function') {
      await bot.dig(block);
    } else if (bot.collectBlock && typeof bot.collectBlock.collect === 'function') {
      await bot.collectBlock.collect(block);
    } else {
      watch.stop();
      return { blockBroken: false, tool, error: 'Dig unavailable' };
    }
  } catch (err) {
    watch.stop();
    return { blockBroken: false, tool, error: err?.message || 'Dig failed' };
  }
  // Settle window: drops spawn as entities, auto-pickup grabs nearby ones.
  await sleep(900);
  let drops = collectDrops(bot, watch, beforeIds, pos);
  let endDrop = expectedDrop && startDrop !== null ? countItem(bot, expectedDrop) : null;
  // Deliberate collection: walk to a sitting drop instead of hoping. This
  // applies to mapped expected drops AND plain blocks like logs, which
  // otherwise get broken at reach edge and left on the ground (observed
  // live: 5 oak broken, 0 collected).
  const totalGrew = () => countTotalInventory(bot) > totalBefore;
  if (drops.length > 0 && !abortedCheck(ctx)) {
    const alreadyHaveIt = expectedDrop && endDrop !== null ? endDrop > startDrop : totalGrew();
    if (!alreadyHaveIt) {
      const dp = drops[0] && drops[0].position ? drops[0].position : pos;
      await walkToDrop(bot, dp);
      await sleep(900);
      drops = collectDrops(bot, watch, beforeIds, pos);
      if (expectedDrop && endDrop !== null) endDrop = countItem(bot, expectedDrop);
    }
  }
  watch.stop();
  const dropCollected = expectedDrop && endDrop !== null ? endDrop > startDrop : totalGrew();
  const dropSpawned = drops.length > 0 || !!dropCollected;
  let toolWasSuitable = null;
  if (expectedDrop) {
    if (dropCollected) toolWasSuitable = true;
    else if (!dropSpawned) toolWasSuitable = false;
  }
  return { blockBroken: true, tool, expectedDrop, dropSpawned, dropCollected, toolWasSuitable };
}

async function mineBlock(bot, args, ctx = {}) {
  const timeoutMs = ctx.timeoutMs || 45000;
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
      const out = await breakOne(bot, block, ctx);
      if (!out.blockBroken) {
        return { ok: false, primitive: 'mine_block', block: blockType, tool: out.tool, error: out.error, ...(out.aborted ? { aborted: true } : {}) };
      }
      const ok = !!out.dropCollected;
      const result = {
        ok,
        primitive: 'mine_block',
        block: blockType,
        tool: out.tool,
        blockBroken: true,
        expectedDrop: out.expectedDrop || null,
        dropSpawned: out.dropSpawned,
        dropCollected: out.dropCollected,
        expectedDropObserved: out.dropCollected,
        toolWasSuitable: out.toolWasSuitable,
      };
      if (!ok) {
        result.error = out.dropSpawned
          ? `Broke ${blockType} but collected nothing; drops are on the ground nearby`
          : (out.expectedDrop
            ? `Broke ${blockType} but no ${out.expectedDrop} drop appeared; tool may be unsuitable`
            : `Broke ${blockType} but collected nothing`);
      }
      return result;
    } catch (err) {
      return { ok: false, primitive: 'mine_block', tool, error: err?.message || 'Mine failed' };
    }
  })();
  return raceWithAbort(bot, run, { timeoutMs, primitive: 'mine_block', ctx, extra: { tool } });
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
    let uncollected = 0;
    const blocks = [];
    for (let i = 0; i < count; i++) {
      const abort = abortedCheck(ctx);
      if (abort) {
        return {
          ok: false, primitive: 'mine_block_type', block: blockType, tool,
          broken, uncollected, blocks, aborted: true,
          error: `Aborted (${abort.type || 'abort'}) with ${broken}/${count} broken`,
        };
      }
      let block = null;
      try {
        block = bot.findBlock({ matching: matchBlockName(blockType), maxDistance });
      } catch {
        block = null;
      }
      if (!block) {
        const msg = `No ${blockType} found within ${maxDistance} blocks`;
        return {
          ok: false, primitive: 'mine_block_type', block: blockType, tool,
          broken, uncollected, blocks,
          error: broken > 0 ? `Only broke ${broken} of ${count}; ${msg.charAt(0).toLowerCase()}${msg.slice(1)}` : msg,
        };
      }
      const one = await breakOne(bot, block, ctx);
      blocks.push({
        block: block.name,
        blockBroken: !!one.blockBroken,
        dropSpawned: one.dropSpawned ?? null,
        dropCollected: one.dropCollected ?? null,
        toolWasSuitable: one.toolWasSuitable ?? null,
        error: one.error || null,
      });
      if (!one.blockBroken) {
        return {
          ok: false, primitive: 'mine_block_type', block: blockType, tool,
          broken, uncollected, blocks,
          error: one.error || 'Dig failed',
          ...(one.aborted ? { aborted: true } : {}),
        };
      }
      broken += 1;
      // A broken-but-uncollected block must not abort the run: the drop may
      // still be picked up later, and the per-block detail above says why.
      if (expectedDrop && !one.dropCollected) uncollected += 1;
    }
    const endCount = expectedDrop ? countItem(bot, expectedDrop) : countItem(bot, blockType);
    const dropObtained = endCount > startCount;
    if (!dropObtained) {
      return {
        ok: false, primitive: 'mine_block_type', block: blockType, tool,
        broken, uncollected, blocks, dropObtained, expectedDropObserved: expectedDrop ? false : null,
        error: `Broke ${broken} ${blockType} but collected nothing; drops are on the ground nearby`,
      };
    }
    return {
      ok: true, primitive: 'mine_block_type', block: blockType, tool,
      broken, uncollected, blocks, dropObtained, expectedDropObserved: expectedDrop ? dropObtained : null,
    };
  })();
  return raceWithAbort(bot, run, { timeoutMs, primitive: 'mine_block_type', ctx, extra: { block: blockType, tool } });
}

module.exports = { mineBlock, mineBlockType, expectedDropFor };
