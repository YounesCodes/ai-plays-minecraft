#!/usr/bin/env node
'use strict';

// Live body proof: VALID acquisition -> correct target -> movement ->
// mining -> inventory. Calls autonomous mine_block_type directly (no LLM,
// no benchmark loop) to collect 8 oak logs. Reports honest counts.

const mineflayer = require('mineflayer');
const { mineBlockType } = require('../src/agent/../primitives/mining');
const { applyPathfinderCompat } = require('../src/bot/pathfinderCompat');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const HOST = process.env.MC_HOST || arg('--host', '127.0.0.1');
const PORT = parseInt(process.env.MC_PORT || arg('--port', '25565'), 10);
const USER = arg('--user', 'Probe01');
const VERSION = process.env.MC_VERSION || '1.21.11';
const COUNT = parseInt(arg('--count', '8'), 10);

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
    const pos = bot.entity.position;
    console.log(JSON.stringify({ start, botPos: { x: pos.x, y: pos.y, z: pos.z } }));
    const res = await mineBlockType(bot, { blockType: 'oak_log', count: COUNT }, { timeoutMs: 420000 });
    const end = countLogs(bot);
    console.log(JSON.stringify({
      result: res, startCount: start, endCount: end,
      gained: end - start, elapsedMs: Date.now() - t0,
    }));
    bot.quit();
    process.exit(res.ok && end - start >= COUNT ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ error: err?.message || String(err) }));
    try { bot.quit(); } catch {}
    process.exit(1);
  }
});
bot.on('error', (e) => console.error(JSON.stringify({ botError: e?.message })));
setTimeout(() => { console.error('timeout'); process.exit(2); }, 450000);
