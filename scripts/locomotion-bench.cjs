#!/usr/bin/env node
'use strict';

// LLM-free locomotion microbenchmark: TEST A (flat) through TEST F (ditch).
// Exercises the trusted movement layer directly (executePrimitive move_near),
// so locomotion correctness is isolated from cognition and the LLM.
//
// Usage (from the repository root):
//   node scripts/locomotion-bench.mjs --origin "X,Y,Z" [--host 127.0.0.1] [--port 25565]
//                                       [--user LocoBench] [--timeout 45000]
//
// Workflow:
//   1. Run this script. It prints Paper console commands that build a
//      deterministic arena (flat pad, step, staircase, pillar, wall, ditch).
//   2. Paste them into the Paper console (whitelist the bot first), then
//      press ENTER here. Before each test the script prints a `tp` command;
//      paste it, press ENTER, and the bot attempts the leg.
//   3. Results print as JSONL and append to logs/locomotion-<timestamp>.jsonl.
//      Exit code is 0 only if every test passes.
//
// A bot pressed motionless against a block is a FAILED locomotion test,
// regardless of whether the target was reachable.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mineflayer = require('mineflayer');
const pathfinderPlugin = require('mineflayer-pathfinder');
const { executePrimitive } = require('../src/primitives');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOST = process.env.MC_HOST || arg('--host', '127.0.0.1');
const PORT = parseInt(process.env.MC_PORT || arg('--port', '25565'), 10);
const USER = arg('--user', 'LocoBench');
const VERSION = process.env.MC_VERSION || '1.21.11';
const TIMEOUT_MS = parseInt(arg('--timeout', '45000'), 10);
const ORIGIN_RAW = arg('--origin', '');

if (!ORIGIN_RAW) {
  console.error('Missing required --origin "X,Y,Z" (integer block coords for the arena start).');
  process.exit(2);
}
const ORIGIN = ORIGIN_RAW.split(',').map((n) => parseInt(n.trim(), 10));
if (ORIGIN.length !== 3 || ORIGIN.some((n) => !Number.isFinite(n))) {
  console.error('Bad --origin. Expected integers like "100,64,200".');
  process.exit(2);
}
const [OX, OY, OZ] = ORIGIN;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function waitEnter(prompt) {
  return new Promise((resolve) => rl.question(`${prompt}\n[press ENTER to continue] `, () => resolve()));
}

// Arena layout, all coordinates derived from the origin. Pad floor top = OY.
const FILL = [
  `fill ${OX - 2} ${OY} ${OZ - 3} ${OX + 36} ${OY + 6} ${OZ + 3} air`,
  `fill ${OX - 2} ${OY - 1} ${OZ - 3} ${OX + 36} ${OY - 1} ${OZ + 3} stone`,
  `setblock ${OX + 8} ${OY} ${OZ} stone`,
  `setblock ${OX + 14} ${OY} ${OZ} stone`,
  `setblock ${OX + 15} ${OY} ${OZ} stone`,
  `setblock ${OX + 15} ${OY + 1} ${OZ} stone`,
  `setblock ${OX + 16} ${OY} ${OZ} stone`,
  `setblock ${OX + 16} ${OY + 1} ${OZ} stone`,
  `setblock ${OX + 16} ${OY + 2} ${OZ} stone`,
  `setblock ${OX + 22} ${OY} ${OZ} stone`,
  `fill ${OX + 26} ${OY} ${OZ - 1} ${OX + 26} ${OY + 1} ${OZ + 1} stone`,
  `fill ${OX + 31} ${OY - 2} ${OZ} ${OX + 33} ${OY - 1} ${OZ} air`,
  `fill ${OX + 31} ${OY - 2} ${OZ} ${OX + 33} ${OY - 2} ${OZ} stone`,
];

const TESTS = [
  { name: 'A-flat', start: [OX, OY, OZ], goal: [OX + 5, OY, OZ], note: 'flat sprint, must arrive quickly' },
  { name: 'B-rise', start: [OX + 6, OY, OZ], goal: [OX + 10, OY, OZ], note: 'one-block step at mid, must step up' },
  { name: 'C-stairs', start: [OX + 12, OY, OZ], goal: [OX + 16, OY + 3, OZ], note: '1-2-3 staircase, must climb' },
  { name: 'D-pillar', start: [OX + 20, OY, OZ], goal: [OX + 24, OY, OZ], note: 'one-block pillar with headroom' },
  { name: 'E-wall', start: [OX + 23, OY, OZ], goal: [OX + 29, OY, OZ], note: 'two-block wall, must route around' },
  { name: 'F-ditch', start: [OX + 32, OY - 1, OZ], goal: [OX + 35, OY, OZ], note: 'start one lower, must climb out' },
];

function posOf(bot) {
  const p = bot.entity?.position;
  if (!p) return null;
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 };
}

function horiz(a, b) {
  if (!a || !b) return null;
  return Math.round(Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2) * 10) / 10;
}

async function main() {
  console.log(`Locomotion microbenchmark: ${USER}@${HOST}:${PORT} MC ${VERSION}, origin ${ORIGIN.join(',')}`);
  console.log(`\n1) In the Paper console, whitelist + prep the bot:\n  whitelist add ${USER}\n  gamemode survival ${USER}\n  time set day\n  (optional, cleaner runs: difficulty peaceful)\n`);
  console.log('2) Paste these arena commands into the Paper console IN ORDER:');
  for (const cmd of FILL) console.log(`  ${cmd}`);
  await waitEnter('\nArena built? The bot connects next.');

  const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USER, version: VERSION, auth: 'offline' });
  bot.loadPlugin(pathfinderPlugin.pathfinder);
  await new Promise((resolve, reject) => {
    bot.once('spawn', resolve);
    bot.once('kicked', (r) => reject(new Error(`kicked: ${r}`)));
    bot.once('error', (e) => reject(e));
    setTimeout(() => reject(new Error('spawn timeout (is Paper up? is the bot whitelisted?)')), 30000);
  });
  bot.on('spawn', () => {
    const { Movements } = pathfinderPlugin;
    const movements = new Movements(bot);
    movements.allow1by1towers = false;
    movements.canDig = true;
    movements.allowSprinting = true;
    movements.allowParkour = false;
    bot.pathfinder.setMovements(movements);
  });
  // Movements for the first spawn (spawn event may have fired before handler).
  try {
    const { Movements } = pathfinderPlugin;
    const movements = new Movements(bot);
    movements.allow1by1towers = false;
    movements.canDig = true;
    movements.allowSprinting = true;
    movements.allowParkour = false;
    bot.pathfinder.setMovements(movements);
  } catch {
    // ignore; spawn handler covers it
  }
  console.log('Bot online.');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = path.join(__dirname, '..', 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // ignore
  }
  const logFile = path.join(logDir, `locomotion-${stamp}.jsonl`);

  const results = [];
  for (const t of TESTS) {
    const [sx, sy, sz] = t.start;
    const [gx, gy, gz] = t.goal;
    await waitEnter(`\nTEST ${t.name} (${t.note}): paste  tp ${USER} ${sx} ${sy} ${sz}`);
    const start = posOf(bot);
    const t0 = Date.now();
    let res;
    try {
      res = await Promise.race([
        executePrimitive(bot, { primitive: 'move_near', args: { x: gx, y: gy, z: gz } }, { timeoutMs: TIMEOUT_MS }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('runner timeout')), TIMEOUT_MS + 15000)),
      ]);
    } catch (err) {
      res = { ok: false, primitive: 'move_near', error: err?.message || 'runner failed' };
    }
    const elapsedMs = Date.now() - t0;
    const end = posOf(bot);
    const record = {
      test: t.name,
      startPosition: start,
      goalPosition: { x: gx, y: gy, z: gz },
      endPosition: end,
      elapsedMs,
      horizontalDistanceMoved: start && end ? horiz(start, end) : null,
      verticalDistanceMoved: start && end ? Math.round((end.y - start.y) * 10) / 10 : null,
      horizontalDistanceToGoal: end ? horiz(end, { x: gx, z: gz }) : null,
      success: !!res.ok,
      timeout: !!res.timedOut,
      error: res.error || null,
      reason: res.reason || null,
      recoveryAttempted: res.recoveryAttempted || false,
      result: res,
    };
    record.pass = !!res.ok && (record.horizontalDistanceToGoal ?? 99) <= 3.5;
    results.push(record);
    console.log(JSON.stringify(record));
    try {
      fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // ignore
    }
  }

  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.test}: ${r.elapsedMs}ms moved=${r.horizontalDistanceMoved} up=${r.verticalDistanceMoved} ${r.error || ''}`);
  }
  console.log(`Log: ${logFile}`);
  rl.close();
  try {
    bot.quit('benchmark done');
  } catch {
    // ignore
  }
  setTimeout(() => process.exit(results.every((r) => r.pass) ? 0 : 1), 800);
}

main().catch((err) => {
  console.error(`Locomotion benchmark failed: ${err && err.message ? err.message : err}`);
  try {
    rl.close();
  } catch {
    // ignore
  }
  process.exit(2);
});
