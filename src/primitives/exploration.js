'use strict';

// Bounded exploration: pick a waypoint away from the current position and
// travel there with the same stall detection, abort handling and cleanup as
// normal movement. A BODY capability (reliable travel), not a strategy: the
// LLM decides WHEN exploring is useful; this only executes it safely.

const { gotoWithStallWatch, stopBotMotion } = require('./movement');

function numEnv(name, fallback, min, max) {
  const v = parseFloat(process.env[name] || '');
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function exploreMaxDistance() {
  return Math.round(numEnv('EXPLORE_MAX_DISTANCE', 64, 16, 128));
}

const DIRS = {
  north: { dx: 0, dz: -1 },
  south: { dx: 0, dz: 1 },
  east: { dx: 1, dz: 0 },
  west: { dx: -1, dz: 0 },
};

function pickDirection(requested) {
  if (requested && DIRS[requested]) return requested;
  const keys = Object.keys(DIRS);
  return keys[Math.floor(Math.random() * keys.length)];
}

function waypointFor(pos, direction, distance) {
  const d = DIRS[direction] || DIRS.north;
  return {
    x: Math.floor(pos.x + d.dx * distance),
    y: Math.floor(Math.max(-60, Math.min(320, pos.y))),
    z: Math.floor(pos.z + d.dz * distance),
    direction,
  };
}

function currentPos(bot) {
  const p = bot?.entity?.position;
  if (!p) return null;
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 };
}

function distXZ(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.round(Math.sqrt(dx * dx + dz * dz) * 10) / 10;
}

function nearestLogInfo(bot) {
  try {
    if (!bot || typeof bot.findBlock !== 'function') return null;
    const block = bot.findBlock({
      matching: (b) => b && typeof b.name === 'string' && b.name.endsWith('_log'),
      maxDistance: 24,
    });
    if (!block || !block.position || !bot.entity?.position) return null;
    return {
      type: block.name,
      distance: distXZ(bot.entity.position, block.position),
    };
  } catch {
    return null;
  }
}

async function explore(bot, args = {}, ctx = {}) {
  const maxDistance = exploreMaxDistance();
  const raw = parseInt(args.distance ?? 32, 10);
  const distance = Number.isFinite(raw) ? Math.max(8, Math.min(64, raw)) : 32;
  const me = currentPos(bot);
  if (!me) return { ok: false, primitive: 'explore', error: 'Own position unknown' };
  if (!bot.pathfinder || typeof bot.pathfinder.goto !== 'function') {
    return { ok: false, primitive: 'explore', error: 'Pathfinder unavailable' };
  }
  let pfGoals = null;
  try {
    const pf = require('mineflayer-pathfinder');
    pfGoals = pf && pf.goals ? pf.goals : null;
  } catch {
    pfGoals = null;
  }
  if (!pfGoals) return { ok: false, primitive: 'explore', error: 'Pathfinder goals unavailable' };

  // Finite candidates: requested direction first, then two alternates.
  // No recursive retries, no wandering.
  const first = pickDirection(args.direction);
  const order = [first, ...Object.keys(DIRS).filter((d) => d !== first).slice(0, 2)];
  const timeoutMs = ctx.timeoutMs || Math.min(90000, Math.max(30000, distance * 1500));
  let lastError = 'no waypoint attempted';
  for (const direction of order) {
    const wp = waypointFor({ x: me.x, y: me.y, z: me.z }, direction, Math.min(distance, maxDistance));
    const goal = new pfGoals.GoalNear(wp.x, wp.y, wp.z, 4);
    // eslint-disable-next-line no-await-in-loop
    const res = await gotoWithStallWatch(bot, goal, { timeoutMs, primitive: 'explore', ctx });
    const end = currentPos(bot);
    const moved = end ? distXZ(me, end) : 0;
    if (res.outcome === 'reached') {
      return {
        ok: true,
        primitive: 'explore',
        direction,
        requestedDistance: distance,
        distanceMoved: moved,
        startPosition: me,
        endPosition: end,
        nearestLog: nearestLogInfo(bot),
      };
    }
    lastError = res.error || res.outcome || 'explore failed';
    if (res.outcome === 'aborted') {
      return {
        ok: false, primitive: 'explore', aborted: true,
        direction, requestedDistance: distance,
        distanceMoved: moved, startPosition: me, endPosition: end,
        error: `Aborted (${lastError})`,
      };
    }
    // Stalled/timeout/failed waypoints: try the next candidate.
  }
  stopBotMotion(bot);
  const end = currentPos(bot);
  return {
    ok: false,
    primitive: 'explore',
    reason: 'explore_failed',
    requestedDistance: distance,
    distanceMoved: end ? distXZ(me, end) : 0,
    startPosition: me,
    endPosition: end,
    error: `All waypoints failed; last: ${lastError}`,
  };
}

module.exports = { explore, exploreMaxDistance, DIRS };
