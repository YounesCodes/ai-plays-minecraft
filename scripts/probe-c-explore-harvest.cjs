#!/usr/bin/env node
'use strict';

// Acceptance C (body-only, no LLM): local harvest -> generic explore ->
// harvest again. Proves depleted-pocket -> relocate -> fresh harvest.

const mineflayer = require('mineflayer');
const { mineBlockType } = require('../src/primitives/mining');
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
const DIRECTION = arg('--dir', 'south');

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

    const fmtP = (p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 });
    const summarize = (r) => ({
      ok: r.ok, reason: r.reason || null, broken: r.broken,
      seen: r.candidatesSeen, failed: r.candidatesFailed,
      deferred: r.candidatesDeferred ?? null, nearestDeferred: r.nearestDeferredDistance ?? null,
      relocation: r.requiresRelocation ?? null,
    });
    // Phase 1: harvest local pocket (expect partial + honest no_reachable_target).
    const r1 = await mineBlockType(bot, { blockType: 'oak_log', count: 8 }, { timeoutMs: 240000 });
    let lastPos = bot.entity.position.clone();
    console.log(JSON.stringify({
      phase1: { ...summarize(r1), gained: countLogs(bot) - start },
      pos1: fmtP(lastPos),
    }));

    // Phases 2+: generic explore (no coordinates, no forest hints) then
    // harvest — mirrors the autonomous loop. Up to 3 relocation cycles.
    // South bearing is test-harness setup, not a production planner hint.
    let cycles = 0;
    while (countLogs(bot) - start < 8 && cycles < 3) {
      cycles += 1;
      const ex = await executePrimitive(bot, { primitive: 'explore', args: { distance: 40, direction: DIRECTION } }, { timeoutMs: 120000 });
      const p2 = bot.entity.position.clone();
      console.log(JSON.stringify({
        [`explore${cycles}`]: { ok: ex.ok, reason: ex.reason || ex.error || null, moved: ex.distanceMoved ?? null },
        pos: fmtP(p2),
        displaced: Math.round(p2.distanceTo(lastPos) * 10) / 10,
      }));
      lastPos = p2;
      const r = await mineBlockType(bot, { blockType: 'oak_log', count: 8 }, { timeoutMs: 240000 });
      console.log(JSON.stringify({
        [`harvest${cycles}`]: { ...summarize(r), totalGained: countLogs(bot) - start },
        pos: fmtP(bot.entity.position.clone()),
      }));
      if (r.ok) break;
    }
    const end = countLogs(bot);
    console.log(JSON.stringify({
      totalGained: end - start, cycles, elapsedMs: Date.now() - t0,
      verdict: end - start >= 8 ? 'PASS-8-gained' : 'PARTIAL',
    }));
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
