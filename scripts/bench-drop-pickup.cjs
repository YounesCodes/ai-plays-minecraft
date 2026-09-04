#!/usr/bin/env node
'use strict';

// Reusable drop-pickup benchmark (Phase 5 D): A flat, B one-lower, C bank,
// D shallow water. Self-sufficient: digs dirt for test items, tosses one,
// walks away, returns via the hardened movement layer (radius 1), verifies
// inventory + distances. Reports PASS/FAIL/SKIP per case (SKIP when the
// terrain lacks the feature — honest, not a failure).
//
// Usage (on VM): node scripts/bench-drop-pickup.cjs [--user DropBench01]

const mineflayer = require('mineflayer');
const pathfinderPlugin = require('mineflayer-pathfinder');
const { applyPathfinderCompat } = require('../src/bot/pathfinderCompat');
const { blockAtPos } = require('../src/blocks');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const HOST = process.env.MC_HOST || arg('--host', '127.0.0.1');
const PORT = parseInt(process.env.MC_PORT || arg('--port', '25565'), 10);
const USER = arg('--user', 'DropBench01');
const VERSION = process.env.MC_VERSION || '1.21.11';

function productionMovements(bot) {
  const { Movements } = pathfinderPlugin;
  const m = new Movements(bot);
  m.allow1by1towers = false;
  m.canDig = true;
  m.allowSprinting = true;
  m.allowParkour = false;
  bot.pathfinder.setMovements(m);
}

function isWater(bot, x, y, z) {
  try {
    const b = blockAtPos(bot, x, y, z);
    return !!b && b.name === 'water';
  } catch { return false; }
}
function isSolid(bot, x, y, z) {
  try {
    const b = blockAtPos(bot, x, y, z);
    return !!b && b.name !== 'air' && b.name !== 'water' && b.boundingBox !== 'empty';
  } catch { return false; }
}
function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USER, version: VERSION });
bot.loadPlugin(pathfinderPlugin.pathfinder);

async function hardenedGoto(goal, timeoutMs) {
  const { gotoWithStallWatch } = require('../src/primitives/movement');
  return gotoWithStallWatch(bot, goal, { timeoutMs, primitive: 'bench-drop', ctx: {} });
}
function countItem(name) {
  let n = 0;
  try {
    for (const it of bot.inventory.items()) {
      if (it && it.name === name) n += it.count;
    }
  } catch {}
  return n;
}
async function ensureDirt(count = 4) {
  if (countItem('dirt') >= 1) return true;
  // Dig dirt below/around directly (in reach, no movement).
  for (let dx = -2; dx <= 2 && countItem('dirt') < 1; dx++) {
    for (let dz = -2; dz <= 2 && countItem('dirt') < 1; dz++) {
      for (let dy = -2; dy <= 0 && countItem('dirt') < 1; dy++) {
        try {
          const p = bot.entity.position;
          const b = blockAtPos(bot, Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz);
          if (b && (b.name === 'dirt' || b.name === 'grass_block')) {
            await bot.dig(b).catch(() => {});
            await new Promise((r) => setTimeout(r, 700));
          }
        } catch {}
      }
    }
  }
  return countItem('dirt') >= 1;
}
async function tossOne() {
  const items = bot.inventory.items().filter((i) => i && i.name === 'dirt');
  if (!items.length) return null;
  try {
    await bot.toss(items[0].type, null, 1);
    await new Promise((r) => setTimeout(r, 1200));
  } catch { return null; }
  // Locate the fresh dirt entity near us.
  let best = null, bestD = Infinity;
  try {
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position) continue;
      const kind = e.displayName || e.name;
      if (kind !== 'Item' && kind !== 'item') continue;
      const d = dist3(e.position, bot.entity.position);
      if (d < 8 && d < bestD) { best = e; bestD = d; }
    }
  } catch {}
  return best ? { id: best.id, pos: best.position.clone() } : null;
}
async function walkAway(meters = 6) {
  const p = bot.entity.position;
  const yaw = Math.random() * Math.PI * 2;
  const gx = Math.floor(p.x + Math.cos(yaw) * meters);
  const gz = Math.floor(p.z + Math.sin(yaw) * meters);
  const gy = Math.floor(p.y);
  const { goalNear } = require('../src/primitives/movement');
  const goal = goalNear(gx, gy, gz, 2);
  if (!goal) return null;
  await hardenedGoto(goal, 15000).catch(() => {});
  return bot.entity.position.clone();
}

async function runCase(label, setup) {
  const before = countItem('dirt');
  const place = await setup();
  if (!place || place.skip) return { case: label, status: 'SKIP', reason: place ? place.skip : 'setup failed' };
  const itemPos = place.pos.clone();
  const startDist = dist3(bot.entity.position, itemPos);
  const { goalNear } = require('../src/primitives/movement');
  const goal = goalNear(Math.floor(itemPos.x), Math.floor(itemPos.y), Math.floor(itemPos.z), 1);
  const t0 = Date.now();
  const res = goal ? await hardenedGoto(goal, 20000) : { outcome: 'no-goal' };
  await new Promise((r) => setTimeout(r, 1500)); // pickup settle
  const after = countItem('dirt');
  // Re-locate item (may have drifted in water).
  let itemNow = null;
  try {
    const e = bot.entities && place.id !== undefined ? bot.entities[place.id] : null;
    if (e && e.position) itemNow = e.position.clone();
  } catch {}
  const finalDist = itemNow ? dist3(bot.entity.position, itemNow) : dist3(bot.entity.position, itemPos);
  const ok = after > before;
  return {
    case: label, status: ok ? 'PASS' : 'FAIL',
    startDist: Math.round(startDist * 10) / 10,
    finalDist: Math.round(finalDist * 10) / 10,
    invBefore: before, invAfter: after,
    movement: res && res.outcome ? res.outcome : 'unknown',
    elapsedMs: Date.now() - t0,
  };
}

bot.once('spawn', async () => {
  const results = [];
  try {
    try { applyPathfinderCompat(bot); } catch {}
    productionMovements(bot);
    await new Promise((r) => setTimeout(r, 2500));
    console.log(JSON.stringify({ bench: 'drop-pickup', user: USER, pos: bot.entity.position }));
    if (!(await ensureDirt())) {
      console.log(JSON.stringify({ verdict: 'SKIP-all', reason: 'no dirt obtainable here' }));
      bot.quit(); process.exit(0); return;
    }
    const p = bot.entity.position;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);

    // A: flat ground at feet.
    results.push(await runCase('A-flat', async () => {
      const t = await tossOne();
      if (!t) return { skip: 'toss failed' };
      await walkAway(6);
      return t;
    }));

    // B: item one block lower (ledge within 6m or dig-down spot).
    results.push(await runCase('B-one-lower', async () => {
      let spot = null;
      outer: for (let dx = -6; dx <= 6 && !spot; dx++) {
        for (let dz = -6; dz <= 6 && !spot; dz++) {
          if (isSolid(bot, bx + dx, by - 1, bz + dz) && !isSolid(bot, bx + dx, by, bz + dz) && !isWater(bot, bx + dx, by, bz + dz)) {
            spot = { x: bx + dx, y: by, z: bz + dz };
          }
        }
      }
      if (!spot) return { skip: 'no one-lower ledge nearby' };
      const { goalNear } = require('../src/primitives/movement');
      await hardenedGoto(goalNear(spot.x, spot.y, spot.z, 2), 15000).catch(() => {});
      const t = await tossOne();
      if (!t) return { skip: 'toss failed' };
      await walkAway(5);
      return t;
    }));

    // C: beside a bank (water within 12m; toss on land adjacent to water).
    results.push(await runCase('C-bank', async () => {
      let bank = null;
      outer: for (let dx = -12; dx <= 12 && !bank; dx++) {
        for (let dz = -12; dz <= 12 && !bank; dz++) {
          if (isWater(bot, bx + dx, by - 1, bz + dz) && isSolid(bot, bx + dx + 1, by - 1, bz + dz)) {
            bank = { x: bx + dx + 1, y: by, z: bz + dz };
          }
        }
      }
      if (!bank) return { skip: 'no bank within 12m' };
      const { goalNear } = require('../src/primitives/movement');
      await hardenedGoto(goalNear(bank.x, bank.y, bank.z, 2), 20000).catch(() => {});
      const t = await tossOne();
      if (!t) return { skip: 'toss failed' };
      await walkAway(5);
      return t;
    }));

    // D: in shallow water.
    results.push(await runCase('D-shallow-water', async () => {
      let w = null;
      outer: for (let dx = -12; dx <= 12 && !w; dx++) {
        for (let dz = -12; dz <= 12 && !w; dz++) {
          if (isWater(bot, bx + dx, by - 1, bz + dz) && isWater(bot, bx + dx, by, bz + dz)) {
            w = { x: bx + dx, y: by, z: bz + dz };
          }
        }
      }
      if (!w) return { skip: 'no shallow water within 12m' };
      const { goalNear } = require('../src/primitives/movement');
      await hardenedGoto(goalNear(w.x, w.y, w.z, 3), 20000).catch(() => {});
      const t = await tossOne();
      if (!t) return { skip: 'toss failed' };
      await walkAway(4);
      return t;
    }));

    for (const r of results) console.log(JSON.stringify(r));
    const pass = results.filter((r) => r.status === 'PASS').length;
    console.log(JSON.stringify({ verdict: `${pass}/${results.length}-pass` }));
    bot.quit(); process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ error: err && err.message ? err.message : String(err) }));
    for (const r of results) console.log(JSON.stringify(r));
    try { bot.quit(); } catch {}
    process.exit(1);
  }
});
bot.on('error', (e) => console.error(JSON.stringify({ botError: e && e.message })));
setTimeout(() => { console.error('timeout'); process.exit(2); }, 420000);
