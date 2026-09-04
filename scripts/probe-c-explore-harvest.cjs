#!/usr/bin/env node
'use strict';

// Acceptance C (body-only, no LLM): local harvest -> generic explore ->
// harvest again. Proves depleted-pocket -> relocate -> fresh harvest.

const mineflayer = require('mineflayer');
const { mineBlockType } = require('../src/agent/../primitives/mining');
const { executePrimitive } = require('../src/primitives');
const { applyPathfinderCompat } = require('../src/bot/pathfinderCompat');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const HOST = process.env.MC_HOST || arg('--host', '127.0.0.1');
const PORT = parseInt(process.env.MC_PORT || arg('--port', '25565'), 10);
const USER = arg('--user', 'Probe07');
const VERSION = process.env.MC_VERSION || '1.21.11';

function countLogs(bot) {
  let n = 0;
  try {
    for (const it of bot.inventory.items()) {
      if (it && typeof it.name === 'string' && it.name.endsWith('_log')) n += it.count;
    }
  } catch {}
  return n;
}

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USER, version: VERSION });
try { bot.loadPlugin(require('mineflayer-pathfinder').pathfinder); } catch {}

bot.once('spawn', async () => {
  const t0 = Date.now();
  try {
    try { applyPathfinderCompat(bot); } catch {}
    await new Promise((r) => setTimeout(r, 2500));
    const start = countLogs(bot);
    const p0 = bot.entity.position.clone();
    console.log(JSON.stringify({ start, pos0: { x: p0.x, y: p0.y, z: p0.z } }));

    // Phase 1: harvest local pocket (expect partial + honest no_reachable_target).
    const r1 = await mineBlockType(bot, { blockType: 'oak_log', count: 8 }, { timeoutMs: 240000 });
    const after1 = countLogs(bot);
    const p1 = bot.entity.position.clone();
    console.log(JSON.stringify({
      phase1: { ok: r1.ok, reason: r1.reason || null, broken: r1.broken, gained: after1 - start, seen: r1.candidatesSeen, failed: r1.candidatesFailed },
      pos1: { x: Math.round(p1.x * 10) / 10, y: Math.round(p1.y * 10) / 10, z: Math.round(p1.z * 10) / 10 },
    }));

    // Phase 2: generic explore (no coordinates, no forest hints).
    // Head south toward the far tree line (test-harness bearing, not planner hint).
    const ex = await executePrimitive(bot, { primitive: 'explore', args: { distance: 48, direction: 'south' } }, { timeoutMs: 120000 });
    const p2 = bot.entity.position.clone();
    console.log(JSON.stringify({
      phase2explore: ex,
      pos2: { x: Math.round(p2.x * 10) / 10, y: Math.round(p2.y * 10) / 10, z: Math.round(p2.z * 10) / 10 },
      displaced: Math.round(p2.distanceTo(p1) * 10) / 10,
    }));

    // Phase 3: harvest again at new location.
    const r3 = await mineBlockType(bot, { blockType: 'oak_log', count: 8 }, { timeoutMs: 240000 });
    const end = countLogs(bot);
    console.log(JSON.stringify({
      phase3: { ok: r3.ok, reason: r3.reason || null, broken: r3.broken, seen: r3.candidatesSeen, failed: r3.candidatesFailed },
      totalGained: end - start, elapsedMs: Date.now() - t0,
    }));
    console.log(JSON.stringify({ verdict: end - start >= 8 ? 'PASS-8-gained' : 'PARTIAL' }));
    bot.quit();
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ error: err?.message || String(err) }));
    try { bot.quit(); } catch {}
    process.exit(1);
  }
});
bot.on('error', (e) => console.error(JSON.stringify({ botError: e?.message })));
setTimeout(() => { console.error('timeout'); process.exit(2); }, 600000);
