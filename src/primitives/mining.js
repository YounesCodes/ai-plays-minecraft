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

const { raceWithAbort, stopBotMotion, gotoWithStallWatch, goalNear } = require('./movement');
const { matchBlockName, blockAtPos } = require('../blocks');
const targetFailures = require('../navigation/targetFailures');
const { getSelectableBlocks } = require('../navigation/blockCandidates');

function botPos(bot) {
  const p = bot?.entity?.position;
  return p ? { x: p.x, y: p.y, z: p.z } : null;
}

// Bounded candidate search via the shared Vec3->Block normalization layer
// (src/navigation/blockCandidates.js). Real Mineflayer findBlocks() returns
// Vec3 positions, not Blocks; the helper materializes, revalidates, dedupes,
// excludes stale failures and ranks by generic actionability. Singular
// findBlock() (returns Block|null) remains as a fallback when plural search
// is unavailable or yields nothing (e.g. minimal mocks).

function withinReach(me, pos, reach = 5) {
  // Unknown position (mocks): assume adjacent, preserving legacy behavior.
  if (!me || !pos) return true;
  const dx = me.x - pos.x;
  const dy = me.y - pos.y;
  const dz = me.z - pos.z;
  return dx * dx + dy * dy + dz * dz <= reach * reach;
}

// Walk adjacent to a candidate with stall/timeout/abort handling.
async function approachCandidate(bot, block, ctx, timeoutMs = 12000) {
  const goal = goalNear(
    Math.floor(block.position.x), Math.floor(block.position.y), Math.floor(block.position.z), 2
  );
  if (!goal) return { ok: true }; // no pathfinder lib: assume reachable (mocks)
  const res = await gotoWithStallWatch(bot, goal, { timeoutMs, primitive: 'mine_block_type', ctx });
  if (res.outcome === 'reached') return { ok: true };
  if (res.outcome === 'stalled') return { ok: false, reason: 'movement_stalled' };
  if (res.outcome === 'aborted') return { ok: false, reason: 'aborted' };
  if (res.outcome === 'timeout') return { ok: false, reason: 'timeout' };
  return { ok: false, reason: res.error || 'no-path' };
}

function failPartial({ blockType, tool, broken, uncollected, blocks, reason, candidatesSeen, candidatesSkipped, candidatesFailed, searchRadius, error, aborted }) {
  const out = {
    ok: false, primitive: 'mine_block_type', block: blockType, tool,
    broken, uncollected, blocks, reason,
    candidatesSeen, candidatesSkipped, candidatesFailed, searchRadius, error,
  };
  if (aborted) out.aborted = true;
  return out;
}

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
    try {
      const arrived = await Promise.race([
        bot.pathfinder.goto(goal).then(() => true),
        sleep(6000).then(() => false),
      ]);
      return arrived;
    } catch {
      return false;
    } finally {
      stopBotMotion(bot);
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
      const pos = { x: Math.floor(args.x), y: Math.floor(args.y), z: Math.floor(args.z) };
      let block = blockAtPos(bot, pos.x, pos.y, pos.z);
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
    const dimension = targetFailures.botDimension(bot);
    let broken = 0;
    let uncollected = 0;
    const blocks = [];
    let candidatesSeen = 0;
    let candidatesSkipped = 0;
    let candidatesFailed = 0;
    const failures = [];
    const seenKeys = new Set();
    const partial = (reason, error) => ({
      ...failPartial({
        blockType, tool, broken, uncollected, blocks, reason,
        candidatesSeen, candidatesSkipped, candidatesFailed,
        searchRadius: maxDistance, error,
      }),
      failures: failures.slice(-12),
    });
    for (let i = 0; i < count; i++) {
      const abort = abortedCheck(ctx);
      if (abort) {
        return {
          ...partial('aborted', `Aborted (${abort.type || 'abort'}) with ${broken}/${count} broken`),
          aborted: true,
        };
      }
      const match = matchBlockName(blockType);
      const noteSeen = (pos) => {
        if (!pos) return;
        const k = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
        if (!seenKeys.has(k)) {
          seenKeys.add(k);
          candidatesSeen += 1;
        }
      };
      // Per-log retry rounds: each round re-queries (failures from prior
      // rounds are now excluded), so a slot works through the ranked list
      // instead of aborting the whole run when the first top-4 are bad.
      // Bounded: 3 rounds x 4 attempts. getSelectableBlocks already
      // normalized Vec3->Block, deduped, excluded and ranked.
      let slotFilled = false;
      let slotHadCandidates = false;
      for (let round = 0; round < 3 && !slotFilled; round++) {
        if (abortedCheck(ctx)) {
          return {
            ...partial('aborted', `Aborted with ${broken}/${count} broken`),
            aborted: true,
          };
        }
        const me = botPos(bot);
        const sel = getSelectableBlocks(bot, {
          matching: match, blockType, maxDistance, count: 12, kind: 'block', target: blockType,
        });
        const eligible = [];
        for (const c of sel.candidates) {
          if (!c || !c.position) continue;
          noteSeen(c.position);
          eligible.push(c);
        }
        for (const c of sel.excluded || []) {
          if (!c || !c.position) continue;
          noteSeen(c.position);
        }
        candidatesSkipped += sel.candidatesSkipped;
        // Fallback for minimal mocks without plural search: singular
        // findBlock() returns Block|null directly. Per-round gate.
        if (eligible.length === 0 && sel.candidatesSeen === 0) {
          try {
            if (bot && typeof bot.findBlock === 'function') {
              const one = bot.findBlock({ matching: match, maxDistance });
              if (one && one.position) {
                const excluded = targetFailures.isExcluded({
                  dimension, kind: 'block', target: blockType,
                  position: one.position, fromPosition: me,
                });
                noteSeen(one.position);
                if (!excluded) eligible.push(one);
                else candidatesSkipped += 1;
              }
            }
          } catch {
            // ignore; honest empty below
          }
        }
        if (eligible.length === 0) break; // nothing new this round
        slotHadCandidates = true;
        for (const cand of eligible.slice(0, 4)) {
        if (abortedCheck(ctx)) {
          return {
            ...partial('aborted', `Aborted with ${broken}/${count} broken`),
            aborted: true,
          };
        }
        if (!withinReach(me, cand.position)) {
          const ap = await approachCandidate(bot, cand, ctx);
          if (!ap.ok) {
            targetFailures.recordFailure({
              dimension, kind: 'block', target: blockType,
              position: cand.position, reason: ap.reason, attemptedFrom: me,
            });
            candidatesFailed += 1;
            try {
              failures.push({
                position: { x: cand.position.x, y: cand.position.y, z: cand.position.z },
                reason: ap.reason || 'approach-failed',
              });
            } catch {}
            continue;
          }
        }
        const one = await breakOne(bot, cand, ctx);
        blocks.push({
          block: cand.name,
          blockBroken: !!one.blockBroken,
          dropSpawned: one.dropSpawned ?? null,
          dropCollected: one.dropCollected ?? null,
          toolWasSuitable: one.toolWasSuitable ?? null,
          error: one.error || null,
        });
        if (!one.blockBroken) {
          targetFailures.recordFailure({
            dimension, kind: 'block', target: blockType,
            position: cand.position, reason: 'dig-failed', attemptedFrom: me,
          });
          candidatesFailed += 1;
          try {
            failures.push({
              position: { x: cand.position.x, y: cand.position.y, z: cand.position.z },
              reason: `dig-failed:${one.error || 'dig'}`.slice(0, 120),
            });
          } catch {}
          if (one.aborted) {
            return {
              ...partial('aborted', one.error || 'Dig failed'),
              aborted: true,
            };
          }
          continue;
        }
        broken += 1;
        // A broken-but-uncollected block must not abort the run: the drop may
        // still be picked up later, and the per-block detail above says why.
        if (expectedDrop && !one.dropCollected) uncollected += 1;
        slotFilled = true;
        break;
        } // end candidate attempts this round
      } // end retry rounds for this log
      if (!slotFilled) {
        if (!slotHadCandidates && candidatesSeen === 0) {
          return partial('resource_not_seen',
            broken > 0
              ? `Only broke ${broken} of ${count}; no ${blockType} found within ${maxDistance} blocks`
              : `No ${blockType} found within ${maxDistance} blocks`);
        }
        return partial('no_reachable_target',
          `Could not reach any ${blockType} nearby (seen ${candidatesSeen}, skipped ${candidatesSkipped}, failed ${candidatesFailed})`);
      }
    }
    const endCount = expectedDrop ? countItem(bot, expectedDrop) : countItem(bot, blockType);
    const dropObtained = endCount > startCount;
    if (!dropObtained) {
      return {
        ok: false, primitive: 'mine_block_type', block: blockType, tool,
        broken, uncollected, blocks, dropObtained, expectedDropObserved: expectedDrop ? false : null,
        reason: candidatesSeen > 0 ? 'no_reachable_target' : 'resource_not_seen',
        candidatesSeen, candidatesSkipped, candidatesFailed, searchRadius: maxDistance,
        error: `Broke ${broken} ${blockType} but collected nothing; drops are on the ground nearby`,
      };
    }
    return {
      ok: true, primitive: 'mine_block_type', block: blockType, tool,
      broken, uncollected, blocks, dropObtained, expectedDropObserved: expectedDrop ? dropObtained : null,
      candidatesSeen, candidatesSkipped, candidatesFailed, searchRadius: maxDistance,
      failures: failures.slice(-12),
    };
  })();
  return raceWithAbort(bot, run, { timeoutMs, primitive: 'mine_block_type', ctx, extra: { block: blockType, tool } });
}

module.exports = { mineBlock, mineBlockType, expectedDropFor };
