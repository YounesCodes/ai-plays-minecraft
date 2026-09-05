#!/usr/bin/env node
'use strict';

// Workstation loop microbenchmark (Phase 13): establish -> leave 40m ->
// return via move_to_known_location -> verify table observed -> craft with
// table -> mine the table away -> return again -> stale healed. LLM-free,
// self-sufficient (only needs table/planks/sticks staged in inventory).
// The bot breaks its OWN table for the stale phase — legitimate.

const mineflayer = require('mineflayer');
const { executePrimitive } = require('../src/primitives');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const HOST = process.env.MC_HOST || arg('--host', '127.0.0.1');
const PORT = parseInt(process.env.MC_PORT || arg('--port', '25565'), 10);
const USER = arg('--user', 'StationBench01');
const VERSION = process.env.MC_VERSION || '1.21.11';

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USER, version: VERSION });
try { bot.loadPlugin(require('mineflayer-pathfinder').pathfinder); } catch {}

function countItem(name) {
  try {
    return (bot.inventory.items() || []).filter((i) => i && i.name === name).reduce((a, i) => a + i.count, 0);
  } catch { return 0; }
}
function hasAll(list) {
  return list.every(([n, c]) => countItem(n) >= c);
}
async function waitFor(items, timeoutMs, label) {
  const t0 = Date.now();
  while (!hasAll(items) && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
  }
  const ok = hasAll(items);
  console.log(JSON.stringify({ staged: label, ok }));
  return ok;
}

bot.once('spawn', async () => {
  const out = {};
  try {
    await new Promise((r) => setTimeout(r, 2500));
    const p0 = bot.entity.position.clone();
    console.log(JSON.stringify({ start: { x: p0.x, y: p0.y, z: p0.z } }));
    if (!(await waitFor([['crafting_table', 1], ['oak_planks', 4], ['stick', 4]], 90000, 'materials'))) {
      console.log(JSON.stringify({ verdict: 'NO-MATERIALS-STAGED' }));
      bot.quit(); process.exit(0); return;
    }
    // 1. Establish.
    const place = await executePrimitive(bot, { primitive: 'place_block_nearby', args: { item: 'crafting_table' } }, { timeoutMs: 60000 });
    console.log(JSON.stringify({ establish: place }));
    out.established = !!(place && place.ok);
    if (!place || !place.ok) {
      console.log(JSON.stringify({ verdict: 'ESTABLISH-FAILED' }));
      bot.quit(); process.exit(1); return;
    }
    // Anchor like the autonomous loop does (trusted outcome -> memory).
    try {
      const world = require('../src/memory/world');
      world.remember('crafting_station', place.position, { kind: 'workstation', block: 'crafting_table', source: 'trusted_placement' }, 'overworld');
    } catch {}
    console.log(JSON.stringify({ anchored: true }));
    // 2. Leave ~40m via generic explore (east).
    const away = await executePrimitive(bot, { primitive: 'explore', args: { distance: 40, direction: 'east' } }, { timeoutMs: 120000 });
    console.log(JSON.stringify({ left: { ok: away.ok, moved: away.distanceMoved } }));
    // 3. Return via remembered name (no coordinates from us).
    const back = await executePrimitive(bot, { primitive: 'move_to_known_location', args: { name: 'crafting_station', range: 4 } }, { timeoutMs: 120000 });
    console.log(JSON.stringify({ return: back }));
    out.returned = !!(back && back.ok);
    // 4. Verify table locally observed + craft with it.
    const found = await executePrimitive(bot, { primitive: 'find_block', args: { blockType: 'crafting_table', radius: 10 } }, {});
    console.log(JSON.stringify({ tableSeen: found }));
    out.tableSeen = !!(found && found.ok);
    const before = countItem('wooden_pickaxe');
    const craft = await executePrimitive(bot, { primitive: 'craft_item', args: { item: 'wooden_pickaxe', count: 1 } }, { timeoutMs: 60000 });
    console.log(JSON.stringify({ craftPick: craft }));
    out.crafted = !!(craft && craft.ok && countItem('wooden_pickaxe') > before);
    // 5. Stale: break our own table, walk off, return, expect healing.
    const mine = await executePrimitive(bot, { primitive: 'mine_block', args: { x: place.position.x, y: place.position.y, z: place.position.z } }, { timeoutMs: 60000 });
    console.log(JSON.stringify({ removedTable: !!mine }));
    await executePrimitive(bot, { primitive: 'explore', args: { distance: 24, direction: 'west' } }, { timeoutMs: 120000 });
    const back2 = await executePrimitive(bot, { primitive: 'move_to_known_location', args: { name: 'crafting_station', range: 4 } }, { timeoutMs: 120000 });
    console.log(JSON.stringify({ returnStale: back2 }));
    out.staleHealed = !!(back2 && back2.ok && back2.stationStale === true);
    const pass = out.established && out.returned && out.tableSeen && out.crafted && out.staleHealed;
    console.log(JSON.stringify({ ...out, verdict: pass ? 'PASS' : 'PARTIAL' }));
    bot.quit(); process.exit(pass ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ error: String((err && err.message) || err).slice(0, 200) }));
    try { bot.quit(); } catch {}
    process.exit(1);
  }
});
bot.on('error', (e) => console.error(JSON.stringify({ botError: String((e && e.message) || e).slice(0, 120) })));
setTimeout(() => { console.error('timeout'); process.exit(2); }, 600000);
