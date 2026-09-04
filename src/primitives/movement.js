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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dist3(a, b) {
  if (!a || !b) return 0;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function round3(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1000) / 1000;
}

function numEnv(name, fallback, min, max) {
  const v = parseFloat(process.env[name] || '');
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

// Stall detection tuning: a goal counts as stalled when it stays active yet
// physical displacement stays below minProgress for a full windowMs.
function stallConfig() {
  return {
    windowMs: Math.round(numEnv('MOVEMENT_STALL_WINDOW_MS', 4000, 1000, 30000)),
    minProgress: numEnv('MOVEMENT_STALL_MIN_PROGRESS', 0.3, 0.05, 5),
  };
}

// Single goto attempt with timeout, abort AND stall detection. Never retries
// by itself. Resolves exactly one outcome: reached | stalled | timeout |
// aborted | failed. The stall monitor uses a trailing window (any real
// progress resets it), so genuinely slow-but-moving travel is not flagged.
async function attemptGoto(bot, goal, { timeoutMs, primitive, ctx = {} }) {
  const { windowMs, minProgress } = stallConfig();
  const start = currentPos(bot);
  const t0 = Date.now();
  let windowPos = start;
  let windowTime = t0;
  let timer = null;
  let poller = null;
  let monitor = null;
  let settle = null;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (poller) clearInterval(poller);
    if (monitor) clearInterval(monitor);
  };
  const finish = (value) => {
    cleanup();
    try {
      settle(value);
    } catch {
      // Promise resolve never throws; late settlements are ignored.
    }
  };
  timer = setTimeout(() => {
    stopBotMotion(bot);
    finish({ outcome: 'timeout' });
  }, timeoutMs);
  if (ctx && typeof ctx.shouldAbort === 'function') {
    poller = setInterval(() => {
      const detail = abortInfo(ctx);
      if (detail !== null) {
        stopBotMotion(bot);
        finish({ outcome: 'aborted', detail });
      }
    }, 200);
  }
  monitor = setInterval(() => {
    const p = currentPos(bot);
    if (!p) return;
    if (!windowPos) {
      windowPos = p;
      windowTime = Date.now();
      return;
    }
    if (dist3(p, windowPos) >= minProgress) {
      windowPos = p;
      windowTime = Date.now();
      return;
    }
    if (Date.now() - windowTime >= windowMs) {
      stopBotMotion(bot);
      finish({
        outcome: 'stalled',
        startPosition: start,
        endPosition: p,
        distanceMoved: round3(dist3(p, start || p)),
        stalledForMs: Date.now() - windowTime,
      });
    }
  }, 500);
  // NOTE: never `await` the goto here — it may hang forever, which would
  // strand us past the point of returning `done`. Handlers settle instead.
  try {
    bot.pathfinder.goto(goal).then(
      () => finish({ outcome: 'reached' }),
      (err) => finish({ outcome: 'failed', error: err?.message || 'No path found' })
    );
  } catch (err) {
    finish({ outcome: 'failed', error: err?.message || 'No path found' });
  }
  return done;
}

// Map one goto attempt onto the primitive result shape, with at most ONE
// bounded recovery (spec: goto -> stall -> jump once -> retry once).
async function settleMove(bot, first, goal, { timeoutMs, primitive, ctx = {}, extra = {} }) {
  if (first.outcome === 'reached') {
    return { ok: true, primitive, position: currentPos(bot), ...extra };
  }
  if (first.outcome !== 'stalled') {
    if (first.outcome === 'timeout') {
      return { ok: false, primitive, timedOut: true, error: `Timed out after ${timeoutMs}ms`, ...extra };
    }
    if (first.outcome === 'aborted') {
      return { ok: false, primitive, aborted: true, error: `Aborted (${first.detail})`, ...extra };
    }
    return { ok: false, primitive, error: first.error || 'No path found', ...extra };
  }
  const rec = await tryRecoverOnce(bot, goal, { timeoutMs, primitive, ctx });
  if (rec.attempted && rec.ok) {
    return { ok: true, primitive, position: currentPos(bot), recovered: true, ...extra };
  }
  return {
    ok: false,
    primitive,
    reason: 'movement_stalled',
    startPosition: first.startPosition || null,
    endPosition: first.endPosition || null,
    distanceMoved: first.distanceMoved ?? null,
    stalledForMs: first.stalledForMs ?? null,
    recoveryAttempted: rec.attempted,
    ...(rec.attempted && rec.recovery ? { recovery: rec.recovery } : {}),
    ...extra,
  };
}

// Classify the cell ahead: solid 1-block step with clear headroom above it.
// Facing convention: forward = (-sin(yaw), -cos(yaw)) in (x, z). If the
// convention ever proves flipped for a version, the worst case is a wasted
// bounded jump followed by a structured failure — never uncontrolled motion.
function classifyObstacle(bot) {
  try {
    const p = bot.entity?.position;
    const yaw = bot.entity?.yaw;
    if (!p || !Number.isFinite(yaw)) return { simple: false, reason: 'no-pose' };
    if (typeof bot.blockAt !== 'function') return { simple: false, reason: 'no-block-query' };
    const fx = Math.round(p.x - Math.sin(yaw));
    const fz = Math.round(p.z - Math.cos(yaw));
    const fy = Math.floor(p.y);
    const feet = bot.blockAt({ x: fx, y: fy, z: fz });
    const head = bot.blockAt({ x: fx, y: fy + 1, z: fz });
    const above = bot.blockAt({ x: fx, y: fy + 2, z: fz });
    if (!feet) return { simple: false, reason: 'no-data' };
    const solid = (b) => !!b && b.boundingBox === 'block';
    if (solid(feet) && !solid(head) && !solid(above)) {
      return { simple: true, obstacle: feet.name || 'block' };
    }
    return { simple: false, reason: solid(feet) ? 'no-headroom' : 'no-obstacle' };
  } catch {
    return { simple: false, reason: 'error' };
  }
}

// ONE recovery: jump once, retry the goal once with a capped budget and NO
// further recovery (no recursion, no jump spam).
async function tryRecoverOnce(bot, goal, { timeoutMs, primitive, ctx = {} }) {
  const obs = classifyObstacle(bot);
  if (!obs.simple) return { attempted: false, reason: obs.reason || 'not-simple' };
  const jump = await jumpForward(bot, { durationMs: 400 }, ctx);
  if (!jump.ok) return { attempted: true, ok: false, recovery: 'jump_failed', recoveryError: jump.error || null };
  const retry = await attemptGoto(bot, goal, {
    timeoutMs: Math.min(timeoutMs, 15000),
    primitive,
    ctx,
  });
  if (retry.outcome === 'reached') return { attempted: true, ok: true, recovered: true, obstacle: obs.obstacle || null };
  return { attempted: true, ok: false, recovery: 'retry_failed', recoveryError: retry.error || retry.outcome || null };
}

// Trusted emergency movement: hold forward+jump briefly, then always release.
// A recovery primitive, NOT a Pathfinder replacement. Fixed name, bounded
// duration, abort-aware, controls cleared in finally: it cannot jump forever.
async function jumpForward(bot, args = {}, ctx = {}) {
  const raw = parseInt(args.durationMs ?? 400, 10);
  const durationMs = Number.isFinite(raw) ? Math.max(100, Math.min(2000, raw)) : 400;
  const start = currentPos(bot);
  const t0 = Date.now();
  const set = (key, value) => {
    try {
      if (bot && typeof bot.setControlState === 'function') bot.setControlState(key, value);
    } catch {
      // ignore
    }
  };
  const displacement = () => {
    const end = currentPos(bot);
    if (!start || !end) return { startPosition: start, endPosition: end, horizontalMoved: null, verticalMoved: null };
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    return {
      startPosition: start,
      endPosition: end,
      horizontalMoved: round3(Math.sqrt(dx * dx + dz * dz)),
      verticalMoved: round3(end.y - start.y),
    };
  };
  set('forward', true);
  set('jump', true);
  try {
    for (;;) {
      const elapsed = Date.now() - t0;
      if (elapsed >= durationMs) break;
      const detail = abortInfo(ctx);
      if (detail !== null) {
        return {
          ok: false, primitive: 'jump_forward', aborted: true,
          error: `Aborted (${detail})`, durationMs: Date.now() - t0, ...displacement(),
        };
      }
      await sleep(Math.min(100, Math.max(0, durationMs - elapsed)));
    }
  } finally {
    set('forward', false);
    set('jump', false);
    stopBotMotion(bot);
  }
  return { ok: true, primitive: 'jump_forward', durationMs: Date.now() - t0, ...displacement() };
}

function getGoals() {
  try {
    return require('mineflayer-pathfinder').goals;
  } catch {
    return null;
  }
}

// Shared GoalNear factory (single lazy-require site for navigation code).
function goalNear(x, y, z, range) {
  const goals = getGoals();
  if (!goals) return null;
  try {
    return new goals.GoalNear(x, y, z, range);
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
      const first = await attemptGoto(bot, goal, { timeoutMs, primitive: 'move_near', ctx });
      return settleMove(bot, first, goal, { timeoutMs, primitive: 'move_near', ctx });
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
      const first = await attemptGoto(bot, goal, { timeoutMs, primitive: 'move_near_entity', ctx });
      return settleMove(bot, first, goal, { timeoutMs, primitive: 'move_near_entity', ctx, extra: { entityId: args.entityId } });
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
      const first = await attemptGoto(bot, goal, { timeoutMs, primitive: 'move_away_from_entity', ctx });
      return settleMove(bot, first, goal, { timeoutMs, primitive: 'move_away_from_entity', ctx, extra: { entityId: args.entityId } });
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

module.exports = { moveNear, moveNearEntity, moveAwayFromEntity, stopMovement, findEntityById, stopBotMotion, raceWithAbort, jumpForward, gotoWithStallWatch: attemptGoto, goalNear };
