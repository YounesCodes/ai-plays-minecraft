#!/usr/bin/env node
'use strict';

// Controlled water-edge locomotion benchmark (Phase 6): W1 parallel to
// shoreline, W2 into shallow water, W3 exit water onto bank, W4 cross small
// channel, W5 dry detour around water. Auto-discovers a shoreline within
// 32m; SKIP-all when the site has no water (honest, not failure). Uses
// production movements + compat + hardened goto. Reports per-leg start,
// goal, elapsed, displacement, stall reason, result, pass/fail.
//
// Usage (on VM): node scripts/bench-water.cjs [--user WaterBench01]

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
const USER = arg('--user', 'WaterBench01');
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
function nameAt(bot, x, y, z) {
  try {
    const b = blockAtPos(bot, x, y, z);
    return b ? b.name : null;
  } catch { return null; }
}
function isWater(bot, x, y, z) { return nameAt(bot, x, y, z) === 'water'; }
function standsOn(bot, x, y, z) {
  // solid ground at feet-1, free space at feet and head
  const below = nameAt(bot, x, y - 1, z);
  const feet = nameAt(bot, x, y, z);
  const head = nameAt(bot, x, y + 1, z);
  const solid = (n) => !!n && n !== 'air' && n !== 'water';
  return solid(below) && !solid(feet) && !solid(head);
}

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USER, version: VERSION });
bot.loadPlugin(pathfinderPlugin.pathfinder);

async function leg(label, goal, timeoutMs) {
  const { gotoWithStallWatch } = require('../src/primitives/movement');
  const start = bot.entity.position.clone();
  const t0 = Date.now();
  let res;
  try {
    res = await gotoWithStallWatch(bot, goal, { timeoutMs, primitive: `bench-water:${label}`, ctx: {} });
  } catch (err) {
    res = { outcome: 'error', error: err && err.message };
  }
  const end = bot.entity.position.clone();
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
  const disp = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 10) / 10;
  const pass = res && res.outcome === 'reached';
  return {
    leg: label, status: pass ? 'PASS' : 'FAIL',
    outcome: res ? res.outcome : 'unknown',
    reason: (res && (res.error || res.reason)) || null,
    recoveryAttempted: !!(res && res.recoveryAttempted),
    elapsedMs: Date.now() - t0, displacement: disp,
    start: { x: Math.round(start.x * 10) / 10, y: Math.round(start.y * 10) / 10, z: Math.round(start.z * 10) / 10 },
    end: { x: Math.round(end.x * 10) / 10, y: Math.round(end.y * 10) / 10, z: Math.round(end.z * 10) / 10 },
  };
}

bot.once('spawn', async () => {
  const out = [];
  try {
    try { applyPathfinderCompat(bot); } catch {}
    productionMovements(bot);
    await new Promise((r) => setTimeout(r, 2500));
    const p = bot.entity.position;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    console.log(JSON.stringify({ bench: 'water', user: USER, pos: { x: p.x, y: p.y, z: p.z } }));
    // Discover shoreline: water cell with dry standable neighbor. Wide
    // vertical band (beaches/slopes put water several meters below spawn).
    let shore = null;
    outer: for (let r = 2; r <= 40 && !shore; r++) {
      for (let dx = -r; dx <= r && !shore; dx++) {
        for (let dz = -r; dz <= r && !shore; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (let dy = -10; dy <= 2 && !shore; dy++) {
            const x = bx + dx, y = by + dy, z = bz + dz;
            if (!isWater(bot, x, y, z)) continue;
            // Dry standable neighbor in a 5x5x3 box (slopes, not just same-y).
            let dryNb = null;
            for (let ax = -2; ax <= 2 && !dryNb; ax++) {
              for (let az = -2; az <= 2 && !dryNb; az++) {
                for (let ay = -1; ay <= 1 && !dryNb; ay++) {
                  if (ax === 0 && az === 0 && ay === 0) continue;
                  if (standsOn(bot, x + ax, y + ay, z + az)) dryNb = { x: x + ax, y: y + ay, z: z + az };
                }
              }
            }
            if (dryNb) shore = { water: { x, y, z } };
          }
        }
      }
    }
    if (!shore) {
      console.log(JSON.stringify({ verdict: 'SKIP-all', reason: 'no shoreline within 40m' }));
      bot.quit(); process.exit(0); return;
    }
    const w = shore.water;
    // Dry spots: ring around the water cell across small y band.
    const dry = [];
    for (let dx = -6; dx <= 6; dx++) {
      for (let dz = -6; dz <= 6; dz++) {
        for (let dy = -2; dy <= 2; dy++) {
          const c = { x: w.x + dx, y: w.y + dy, z: w.z + dz };
          if (standsOn(bot, c.x, c.y, c.z)) dry.push(c);
          if (dry.length >= 8) break;
        }
        if (dry.length >= 8) break;
      }
      if (dry.length >= 8) break;
    }
    console.log(JSON.stringify({ shoreline: w, drySpots: dry.length }));
    const { goalNear } = require('../src/primitives/movement');
    if (dry.length < 2) {
      console.log(JSON.stringify({ verdict: 'SKIP-legs', reason: 'shoreline lacks two dry spots' }));
      bot.quit(); process.exit(0); return;
    }
    // W1: dry -> dry parallel to shore.
    out.push(await leg('W1-parallel', goalNear(dry[0].x, dry[0].y, dry[0].z, 2), 25000));
    // W2: dry -> into shallow water edge.
    out.push(await leg('W2-into-water', goalNear(w.x, w.y, w.z, 2), 25000));
    // W3: water -> back onto bank.
    out.push(await leg('W3-exit-water', goalNear(dry[1].x, dry[1].y, dry[1].z, 2), 25000));
    // W4: cross to other dry side (through/around channel).
    out.push(await leg('W4-cross', goalNear(dry[dry.length - 1].x, dry[dry.length - 1].y, dry[dry.length - 1].z, 2), 30000));
    // W5: longer dry detour goal 10m past shore on dry land.
    const past = { x: dry[0].x + (dry[0].x - w.x) * 3, y: dry[0].y, z: dry[0].z + (dry[0].z - w.z) * 3 };
    out.push(await leg('W5-detour', goalNear(past.x, past.y, past.z, 3), 30000));
    for (const r of out) console.log(JSON.stringify(r));
    const pass = out.filter((r) => r.status === 'PASS').length;
    console.log(JSON.stringify({ verdict: `${pass}/${out.length}-pass` }));
    bot.quit(); process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ error: err && err.message ? err.message : String(err) }));
    for (const r of out) console.log(JSON.stringify(r));
    try { bot.quit(); } catch {}
    process.exit(1);
  }
});
bot.on('error', (e) => console.error(JSON.stringify({ botError: e && e.message })));
setTimeout(() => { console.error('timeout'); process.exit(2); }, 420000);
