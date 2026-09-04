'use strict';

// Movement primitives. All bounded, all return structured results, never throw
// for ordinary Minecraft failures (no path, no target).

function stopBotMotion(bot) {
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
  // Consume pathfinder's internal stop flag immediately. bot.pathfinder.stop()
  // only raises the flag; it is cleared on the NEXT setGoal — which would
  // otherwise abort that fresh goto instantly with PathStopped (observed
  // live: every goto following a timeout failed at once). A null goal clears
  // the flag with no listeners attached, so nothing else can misfire.
  try {
    if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null);
  } catch {
    // ignore
  }
}

function abortInfo(ctx) {
  try {
    const i = ctx && typeof ctx.shouldAbort === 'function' ? ctx.shouldAbort() : null;
    if (i) return `${i.type || 'abort'}${i.reason ? `: ${i.reason}` : ''}`;
  } catch {
    // a broken hook must never break the primitive
  }
  return null;
}

// Race work against a timeout AND cooperative abort. Whoever wins the race
// stops the bot first, so a timed-out or aborted goto can never keep
// dueling later steps over pathfinder goals (the zombie-goto class).
function raceWithAbort(bot, promise, { timeoutMs, primitive, ctx = {}, extra = {} }) {
  if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  let timer = null;
  let poller = null;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (poller) clearInterval(poller);
  };
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      stopBotMotion(bot);
      resolve({ ok: false, primitive, timedOut: true, error: `Timed out after ${timeoutMs}ms`, ...extra });
    }, timeoutMs);
  });
  const abort = new Promise((resolve) => {
    if (!ctx || typeof ctx.shouldAbort !== 'function') return; // pends forever, GC-able, race ignores it
    poller = setInterval(() => {
      const detail = abortInfo(ctx);
      if (detail !== null) {
        stopBotMotion(bot);
        resolve({ ok: false, primitive, aborted: true, error: `Aborted (${detail})`, ...extra });
      }
    }, 200);
  });
  return Promise.race([promise, timeout, abort]).finally(cleanup);
}

function currentPos(bot) {
  const p = bot.entity?.position;
  if (!p) return null;
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 };
}

function getGoals() {
  try {
    return require('mineflayer-pathfinder').goals;
  } catch {
    return null;
  }
}

async function moveNear(bot, args, ctx = {}) {
  const timeoutMs = ctx.timeoutMs || 30000;
  const range = Math.max(1, Math.min(8, Number(args.range ?? 2) || 2));
  const run = (async () => {
    try {
      if (!bot.pathfinder || typeof bot.pathfinder.goto !== 'function') {
        return { ok: false, primitive: 'move_near', error: 'Pathfinder unavailable' };
      }
      const goals = getGoals();
      if (!goals) return { ok: false, primitive: 'move_near', error: 'Pathfinder goals unavailable' };
      const goal = new goals.GoalNear(Math.floor(args.x), Math.floor(args.y), Math.floor(args.z), range);
      await bot.pathfinder.goto(goal);
      return { ok: true, primitive: 'move_near', position: currentPos(bot) };
    } catch (err) {
      return { ok: false, primitive: 'move_near', error: err?.message || 'No path found' };
    }
  })();
  return raceWithAbort(bot, run, { timeoutMs, primitive: 'move_near', ctx });
}

function findEntityById(bot, entityId) {
  try {
    const entities = bot.entities || {};
    if (entities[entityId]) return entities[entityId];
    for (const e of Object.values(entities)) {
      if (e && e.id === entityId) return e;
    }
  } catch {
    // ignore
  }
  return null;
}

async function moveNearEntity(bot, args, ctx = {}) {
  const timeoutMs = ctx.timeoutMs || 30000;
  const distance = Math.max(1, Math.min(16, Number(args.distance ?? 3) || 3));
  const run = (async () => {
    try {
      const target = findEntityById(bot, args.entityId);
      if (!target?.position) return { ok: false, primitive: 'move_near_entity', error: `Entity ${args.entityId} not found` };
      if (!bot.pathfinder || typeof bot.pathfinder.goto !== 'function') {
        return { ok: false, primitive: 'move_near_entity', error: 'Pathfinder unavailable' };
      }
      const goals = getGoals();
      if (!goals) return { ok: false, primitive: 'move_near_entity', error: 'Pathfinder goals unavailable' };
      const p = target.position;
      const goal = new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), Math.max(1, Math.min(8, Math.round(distance))));
      await bot.pathfinder.goto(goal);
      return { ok: true, primitive: 'move_near_entity', entityId: args.entityId, position: currentPos(bot) };
    } catch (err) {
      return { ok: false, primitive: 'move_near_entity', error: err?.message || 'No path found' };
    }
  })();
  return raceWithAbort(bot, run, { timeoutMs, primitive: 'move_near_entity', ctx });
}

async function moveAwayFromEntity(bot, args, ctx = {}) {
  const timeoutMs = ctx.timeoutMs || 30000;
  const distance = Math.max(2, Math.min(32, Number(args.distance ?? 7) || 7));
  const run = (async () => {
    try {
      const target = findEntityById(bot, args.entityId);
      if (!target?.position) return { ok: false, primitive: 'move_away_from_entity', error: `Entity ${args.entityId} not found` };
      const me = bot.entity?.position;
      if (!me) return { ok: false, primitive: 'move_away_from_entity', error: 'Own position unknown' };
      if (!bot.pathfinder || typeof bot.pathfinder.goto !== 'function') {
        return { ok: false, primitive: 'move_away_from_entity', error: 'Pathfinder unavailable' };
      }
      const goals = getGoals();
      if (!goals) return { ok: false, primitive: 'move_away_from_entity', error: 'Pathfinder goals unavailable' };
      // Flee: move to mirrored point away from the entity.
      const dx = me.x - target.position.x;
      const dz = me.z - target.position.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const tx = me.x + (dx / len) * distance;
      const tz = me.z + (dz / len) * distance;
      const goal = new goals.GoalNear(Math.floor(tx), Math.floor(me.y), Math.floor(tz), 2);
      await bot.pathfinder.goto(goal);
      return { ok: true, primitive: 'move_away_from_entity', entityId: args.entityId, position: currentPos(bot) };
    } catch (err) {
      return { ok: false, primitive: 'move_away_from_entity', error: err?.message || 'No path found' };
    }
  })();
  return raceWithAbort(bot, run, { timeoutMs, primitive: 'move_away_from_entity', ctx });
}

async function stopMovement(bot) {
  stopBotMotion(bot);
  return { ok: true, primitive: 'stop_movement' };
}

module.exports = { moveNear, moveNearEntity, moveAwayFromEntity, stopMovement, findEntityById, stopBotMotion, raceWithAbort };
