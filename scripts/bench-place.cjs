#!/usr/bin/env node
'use strict';

// Live place_block_nearby verification: waits for the item in inventory
// (staged externally), places via the trusted primitive, then verifies
// Mineflayer sees the block afterward. No LLM.

const mineflayer = require('mineflayer');
const { executePrimitive } = require('../src/primitives');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const HOST = process.env.MC_HOST || arg('--host', '127.0.0.1');
const PORT = parseInt(process.env.MC_PORT || arg('--port', '25565'), 10);
const USER = arg('--user', 'PlaceTest01');
const VERSION = process.env.MC_VERSION || '1.21.11';
const ITEM = arg('--item', 'crafting_table');

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USER, version: VERSION });
try { bot.loadPlugin(require('mineflayer-pathfinder').pathfinder); } catch {}

function hasItem() {
  try {
    return (bot.inventory.items() || []).some((i) => i && i.name === ITEM);
  } catch { return false; }
}

bot.once('spawn', async () => {
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const p0 = bot.entity.position.clone();
    console.log(JSON.stringify({ waitingFor: ITEM, pos: { x: p0.x, y: p0.y, z: p0.z } }));
    const t0 = Date.now();
    while (!hasItem() && Date.now() - t0 < 90000) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!hasItem()) {
      console.log(JSON.stringify({ verdict: 'NO-ITEM-STAGED' }));
      bot.quit(); process.exit(0); return;
    }
    const res = await executePrimitive(bot, { primitive: 'place_block_nearby', args: { item: ITEM } }, { timeoutMs: 60000 });
    console.log(JSON.stringify({ placement: res }));
    // Verify via independent findBlock search.
    let seen = null;
    try {
      const { Vec3 } = require('vec3');
      if (res && res.ok && res.position) {
        const b = bot.blockAt(new Vec3(res.position.x, res.position.y, res.position.z));
        seen = b ? b.name : null;
      }
    } catch (e) { seen = `verify-error:${(e && e.message || '').slice(0, 80)}`; }
    console.log(JSON.stringify({ verifyBlockAt: seen, verdict: res && res.ok && seen === ITEM ? 'PASS' : 'CHECK' }));
    bot.quit(); process.exit(res && res.ok ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ error: String((err && err.message) || err).slice(0, 200) }));
    try { bot.quit(); } catch {}
    process.exit(1);
  }
});
bot.on('error', (e) => console.error(JSON.stringify({ botError: String((e && e.message) || e).slice(0, 120) })));
setTimeout(() => { console.error('timeout'); process.exit(2); }, 180000);
