'use strict';

const pathfinder = require('mineflayer-pathfinder');

// Move near (x, y, z) within `range` blocks. Returns a structured result,
// never throws for ordinary pathfinding failures.
async function moveNear(bot, x, y, z, range = 2) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return { ok: false, error: 'Invalid target coordinates' };
  }
  const r = Number.isFinite(range) ? Math.max(1, Math.min(8, range)) : 2;

  try {
    const goal = new pathfinder.goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), r);
    await bot.pathfinder.goto(goal);
    const p = bot.entity.position;
    return {
      ok: true,
      position: {
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        z: Math.round(p.z * 10) / 10,
      },
    };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'No path found' };
  }
}

module.exports = { moveNear };
