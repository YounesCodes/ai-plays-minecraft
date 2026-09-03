'use strict';

// Movement primitives. All bounded, all return structured results, never throw
// for ordinary Minecraft failures (no path, no target).

function withTimeout(promise, ms, primitive) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, primitive, error: `Timed out after ${ms}ms`, timedOut: true }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
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
  return withTimeout(run, timeoutMs, 'move_near');
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
  return withTimeout(run, timeoutMs, 'move_near_entity');
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
  return withTimeout(run, timeoutMs, 'move_away_from_entity');
}

async function stopMovement(bot) {
  try {
    if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') bot.pathfinder.stop();
    if (typeof bot.clearControlStates === 'function') bot.clearControlStates();
    return { ok: true, primitive: 'stop_movement' };
  } catch (err) {
    return { ok: false, primitive: 'stop_movement', error: err?.message || 'Stop failed' };
  }
}

module.exports = { moveNear, moveNearEntity, moveAwayFromEntity, stopMovement, findEntityById };
