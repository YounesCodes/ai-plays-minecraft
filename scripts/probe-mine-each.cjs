#!/usr/bin/env node
'use strict';

// Diagnose per-log mining: attempt oak_log one at a time, print full results
// including failure reasons, positions, distances. No LLM.

const mineflayer = require('mineflayer');
const { mineBlockType } = require('../src/agent/../primitives/mining');
const { applyPathfinderCompat } = require('../src/bot/pathfinderCompat');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const HOST = process.env.MC_HOST || arg('--host', '127.0.0.1');
const PORT = parseInt(process.env.MC_PORT || arg('--port', '25565'), 10);
const USER = arg('--user', 'Probe02');
const VERSION = process.env.MC_VERSION || '1.21.11';
const N = parseInt(arg('--n', '8'), 10);

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
  try {
    try { applyPathfinderCompat(bot); } catch {}
    await new Promise((r) => setTimeout(r, 2500));
    console.log(JSON.stringify({ start: countLogs(bot), pos: bot.entity.position }));
    for (let i = 0; i < N; i++) {
      const before = countLogs(bot);
      const pos = bot.entity.position.clone();
      const res = await mineBlockType(bot, { blockType: 'oak_log', count: 1 }, { timeoutMs: 120000 });
      const after = countLogs(bot);
      const now = bot.entity.position.clone();
      console.log(JSON.stringify({
        iter: i, ok: res.ok, reason: res.reason || null,
        broken: res.broken, candidatesSeen: res.candidatesSeen,
        skipped: res.candidatesSkipped, failed: res.candidatesFailed,
        error: (res.error || '').slice(0, 160),
        blocks: (res.blocks || []).map((b) => ({ b: b.block, br: b.blockBroken, dc: b.dropCollected, e: b.error })),
        invBefore: before, invAfter: after,
        posBefore: { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 },
        posAfter: { x: Math.round(now.x * 10) / 10, y: Math.round(now.y * 10) / 10, z: Math.round(now.z * 10) / 10 },
      }));
      if (!res.ok) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(JSON.stringify({ end: countLogs(bot) }));
    bot.quit(); process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ error: err?.message || String(err) }));
    try { bot.quit(); } catch {}
    process.exit(1);
  }
});
bot.on('error', (e) => console.error(JSON.stringify({ botError: e?.message })));
setTimeout(() => { console.error('timeout'); process.exit(2); }, 500000);
