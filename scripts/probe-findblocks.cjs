#!/usr/bin/env node
'use strict';

// LLM-free controlled block-discovery probe (task 5).
// Prints raw findBlocks output vs normalized vs final selection order.
// No LLM, no mining, no world mutation — read-only diagnostic.
//
// Usage (on VM):
//   node scripts/probe-findblocks.cjs [--user Debugger01] [--radius 32] [--type oak_log]

const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { matchBlockName } = require('../src/blocks');
const { findBlockCandidates, getSelectableBlocks } = require('../src/navigation/blockCandidates');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOST = process.env.MC_HOST || arg('--host', '127.0.0.1');
const PORT = parseInt(process.env.MC_PORT || arg('--port', '25565'), 10);
const USER = arg('--user', 'Debugger01');
const VERSION = process.env.MC_VERSION || '1.21.11';
const RADIUS = parseInt(arg('--radius', '32'), 10);
const TYPE = arg('--type', 'oak_log');

console.log(JSON.stringify({
  probe: 'findblocks-contract',
  mineflayerVersion: require('mineflayer/package.json').version,
  host: HOST, port: PORT, user: USER, version: VERSION, radius: RADIUS, type: TYPE,
}));

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USER, version: VERSION });

function entryInfo(e) {
  const isVec3 = e instanceof Vec3;
  const hasPosition = !!(e && e.position);
  let xyz = null;
  try {
    if (isVec3) xyz = { x: e.x, y: e.y, z: e.z };
    else if (e && typeof e.x === 'number') xyz = { x: e.x, y: e.y, z: e.z };
    else if (hasPosition) xyz = { x: e.position.x, y: e.position.y, z: e.position.z };
  } catch { xyz = null; }
  let dist = null;
  try {
    const me = bot.entity.position;
    if (xyz) {
      const dx = xyz.x - me.x, dy = xyz.y - me.y, dz = xyz.z - me.z;
      dist = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100) / 100;
    }
  } catch { dist = null; }
  return {
    ctor: e ? e.constructorName || e.constructor?.name || typeof e : typeof e,
    isVec3,
    hasPositionField: hasPosition,
    hasName: !!(e && typeof e.name === 'string'),
    name: e && typeof e.name === 'string' ? e.name : null,
    xyz,
    dist,
    keys: e && typeof e === 'object' ? Object.keys(e).slice(0, 8) : [],
  };
}

bot.once('spawn', async () => {
  try {
    await new Promise((r) => setTimeout(r, 2500)); // let chunks arrive
    const me = bot.entity.position.clone();
    console.log(JSON.stringify({ botPos: { x: me.x, y: me.y, z: me.z } }));

    const matching = matchBlockName(TYPE);
    let raw = [];
    try {
      raw = bot.findBlocks({ matching, maxDistance: RADIUS, count: 12 }) || [];
    } catch (err) {
      console.log(JSON.stringify({ rawError: err?.message }));
    }
    console.log(JSON.stringify({
      rawContract: 'bot.findBlocks() -> ?',
      rawLength: Array.isArray(raw) ? raw.length : -1,
      rawIsArray: Array.isArray(raw),
    }));
    (raw || []).forEach((e, i) => {
      console.log(JSON.stringify({ rawIndex: i, ...entryInfo(e) }));
    });

    // Normalized via shared helper.
    const norm = findBlockCandidates(bot, { matching, maxDistance: RADIUS, count: 12 });
    console.log(JSON.stringify({ normalizedCount: norm.length }));
    norm.forEach((b, i) => {
      const dx = b.position.x - me.x, dy = b.position.y - me.y, dz = b.position.z - me.z;
      const dist = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100) / 100;
      console.log(JSON.stringify({
        normalizedIndex: i, name: b.name,
        pos: { x: b.position.x, y: b.position.y, z: b.position.z },
        dist, dy: Math.round(dy * 100) / 100,
      }));
    });

    // Final selection (exclusions + generic ranking).
    const sel = getSelectableBlocks(bot, {
      matching, blockType: TYPE, maxDistance: RADIUS, count: 12,
      kind: 'block', target: TYPE,
    });
    console.log(JSON.stringify({
      selection: { seen: sel.candidatesSeen, skipped: sel.candidatesSkipped, final: sel.candidates.length },
    }));
    sel.candidates.forEach((b, i) => {
      const dx = b.position.x - me.x, dy = b.position.y - me.y, dz = b.position.z - me.z;
      const dist = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100) / 100;
      console.log(JSON.stringify({
        finalIndex: i, name: b.name,
        pos: { x: b.position.x, y: b.position.y, z: b.position.z },
        dist, dy: Math.round(dy * 100) / 100,
      }));
    });

    // Verdict helper: did raw entries look like Vec3 (no .position)?
    const vec3Like = (raw || []).filter((e) => e && typeof e.x === 'number' && !e.position).length;
    console.log(JSON.stringify({
      verdict: {
        rawVec3Like: vec3Like,
        rawTotal: (raw || []).length,
        wrapperWasMishandling: vec3Like > 0 ? 'YES-proven (Vec3 has no .position; old code skipped all)' : 'n/a',
        mineflayerOrdersByDistance: 'see raw dist sequence above (should be ascending)',
      },
    }));
    bot.quit();
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ probeError: err?.message || String(err) }));
    try { bot.quit(); } catch {}
    process.exit(1);
  }
});

bot.on('error', (e) => console.error(JSON.stringify({ botError: e?.message })));
bot.on('kicked', (r) => console.error(JSON.stringify({ kicked: String(r).slice(0, 200) })));
setTimeout(() => { console.error(JSON.stringify({ timeout: 'no spawn in 30s' })); process.exit(2); }, 30000);
