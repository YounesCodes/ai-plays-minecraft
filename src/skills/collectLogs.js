'use strict';

// Log collection shared by the benchmark action.
//
// Robustness design (learned the hard way against real terrain): the travel
// phase is the wedging risk. Pathfinder can enter a partial-path livelock
// (replanning forever while the bot stands still, no self-timeout), and
// collectblock's retry loop then duels every later attempt over pathfinder
// goals ("goal was changed" instant-fails plus phantom background mining).
// So each block goes through OUR OWN timeboxed approach first — a
// single-shot goto with no retry loop, always safe to abandon — and only
// adjacent blocks are handed to collect(). Unreachable blocks are skipped
// (tracked, never retried within the same action) so one bad trunk can't
// stall the action. The action-level timebox in src/agent/actions.js
// remains as the final backstop.

const { intEnv } = require('../safety/limits');

// Blocks proven unreachable, remembered ACROSS actions within this process.
// Without this, every step re-attempts the same nearest unreachable trunk
// (greedy nearest-first) and the run stalls in a local minimum instead of
// walking on to farther farmable trees.
//
// A skip is only meaningful relative to where the bot was: teleports,
// respawns and long walks invalidate old skips, otherwise the bot goes blind
// to a tree it has since approached (observed live: tp next to a skipped
// trunk, steps kept failing on distant blocks). So each skip records the bot
// position, and skips farther than SKIP_RADIUS away are ignored. Bounded FIFO.
const globalSkipped = new Map();
const MAX_GLOBAL_SKIPPED = 500;
const SKIP_RADIUS = 12;

function rememberSkipped(key, bot, block) {
  const p = bot && bot.entity && bot.entity.position;
  globalSkipped.set(key, p ? { x: p.x, y: p.y, z: p.z, blockPosition: block ? { x: block.position.x, y: block.position.y, z: block.position.z } : null } : null);
  if (globalSkipped.size > MAX_GLOBAL_SKIPPED) {
    const oldest = globalSkipped.keys().next().value;
    globalSkipped.delete(oldest);
  }
}

function isSkipped(key, bot) {
  if (!globalSkipped.has(key)) return false;
  const rec = globalSkipped.get(key);
  if (!rec) return true; // unknown origin: honor conservatively (mocks/tests)
  const p = bot && bot.entity && bot.entity.position;
  if (!p) return true;
  // A block the bot is already next to is reachable BY DEFINITION — intervals
  // of walking must be able to heal a skip. Without this (observed live), the
  // bot walked to a previously-skipped oak, kept ignoring it, and chased
  // distant canopy instead.
  const bp = rec.blockPosition;
  if (bp) {
    const adx = p.x - bp.x;
    const ady = p.y - bp.y;
    const adz = p.z - bp.z;
    if (adx * adx + ady * ady + adz * adz < 4 * 4) return false; // adjacent: reachable
  }
  const dx = p.x - rec.x;
  const dy = p.y - rec.y;
  const dz = p.z - rec.z;
  return dx * dx + dy * dy + dz * dz < SKIP_RADIUS * SKIP_RADIUS;
}

function getLogLimit() {
  const v = parseInt(process.env.MAX_LOG_COLLECTION_AMOUNT || '8', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 64) : 8;
}

function getSearchDistance() {
  const v = parseInt(process.env.MAX_BLOCK_SEARCH_DISTANCE || '64', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 128) : 64;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blockKey(block) {
  const p = block && block.position;
  return p ? `${p.x},${p.y},${p.z}` : '?';
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
      matching: (block) =>
        block &&
        typeof block.name === 'string' &&
        block.name.endsWith('_log') &&
        !isSkipped(blockKey(block), bot),
      maxDistance,
    });
  } catch {
    return null;
  }
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

// Walk to within dig reach of the block, timeboxed. Single-shot goto with
// no retry loop, so abandoning it on timeout is always safe (unlike
// abandoning collectblock's retrying collect).
async function approachBlock(bot, block, timeoutMs) {
  try {
    if (!bot.pathfinder || typeof bot.pathfinder.goto !== 'function') return true;
    const GoalNear = getGoalNear();
    if (!GoalNear) return true;
    const goal = new GoalNear(block.position.x, block.position.y, block.position.z, 3);
    let timer = null;
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('approach timed out')), timeoutMs);
        }),
      ]);
      return true;
    } finally {
      if (timer) clearTimeout(timer); // never leak a 30-90s keep-alive timer
    }
  } catch {
    stopCollectActivity(bot);
    return false;
  }
}

async function collectWithTimeout(bot, block, timeoutMs) {
  let timer = null;
  try {
    await Promise.race([
      bot.collectBlock.collect(block),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('collect timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stopCollectActivity(bot) {
  try {
    if (bot.collectBlock && typeof bot.collectBlock.cancelTask === 'function') bot.collectBlock.cancelTask(() => {});
  } catch {
    // ignore
  }
  try {
    if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop();
  } catch {
    // ignore
  }
  try {
    if (typeof bot.clearControlStates === 'function') bot.clearControlStates();
  } catch {
    // ignore
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
  const perBlockMs = intEnv('PRIMITIVE_TIMEOUT_MS', 30000, 1000, 120000);
  const startCount = countLogs(bot);
  let lastError = '';
  let attempts = 0;
  const maxAttempts = target + 8; // skips can't spin forever; action timebox backstops anyway

  while (countLogs(bot) - startCount < target && attempts < maxAttempts) {
    attempts += 1;
    const block = findLogBlock(bot, maxDistance);
    if (!block) break;
    const key = blockKey(block);
    if (!(await approachBlock(bot, block, perBlockMs))) {
      rememberSkipped(key, bot, block);
      lastError = `No path to ${block.name} at ${block.position}`;
      continue;
    }
    try {
      await collectWithTimeout(bot, block, perBlockMs);
    } catch (err) {
      rememberSkipped(key, bot, block);
      lastError = err && err.message ? err.message : 'Block collection failed';
      stopCollectActivity(bot);
      continue;
    }
  }

  const collected = countLogs(bot) - startCount;
  if (collected >= target) return { ok: true, collected };
  if (collected > 0) {
    return { ok: true, collected, error: `Only ${collected} of ${target} logs collected; ${lastError || 'no more logs nearby'}` };
  }
  return {
    ok: false,
    collected: 0,
    error:
      lastError ||
      (globalSkipped.size > 0
        ? `No reachable log within ${maxDistance} blocks (${globalSkipped.size} skipped as unreachable)`
        : `No log found within ${maxDistance} blocks`),
  };
}

module.exports = { collectLogs, countLogs, _clearSkipped: () => { globalSkipped.clear(); } };
