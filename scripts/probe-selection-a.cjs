#!/usr/bin/env node
'use strict';

// Live acceptance A: controlled selection with real blocks.
// 1. Connect, find real oak_log candidates.
// 2. Pick nearest low-dy candidate as "actionable nearby".
// 3. Record a fake far-away failure for it, verify it becomes excluded.
// 4. Spoof bot position adjacent to it, verify adjacency healing + selection.
// No world mutation, no LLM.

const mineflayer = require('mineflayer');
const { matchBlockName } = require('../src/blocks');
const { getSelectableBlocks } = require('../src/navigation/blockCandidates');
const targetFailures = require('../src/navigation/targetFailures');

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

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USER, version: VERSION });

bot.once('spawn', async () => {
  try {
    targetFailures.clear();
    await new Promise((r) => setTimeout(r, 2500));
    const me = bot.entity.position.clone();
    console.log(JSON.stringify({ botPos: { x: me.x, y: me.y, z: me.z } }));
    const matching = matchBlockName(TYPE);
    const sel0 = getSelectableBlocks(bot, { matching, blockType: TYPE, maxDistance: RADIUS, count: 12, kind: 'block', target: TYPE });
    console.log(JSON.stringify({ initial: { seen: sel0.candidatesSeen, skipped: sel0.candidatesSkipped, final: sel0.candidates.length } }));
    if (sel0.candidates.length === 0) {
      console.log(JSON.stringify({ verdict: 'NO_CANDIDATES_IN_RADIUS' }));
      bot.quit(); process.exit(0); return;
    }
    sel0.candidates.slice(0, 3).forEach((b, i) => {
      console.log(JSON.stringify({ top: i, pos: { x: b.position.x, y: b.position.y, z: b.position.z }, name: b.name }));
    });
    // Choose the top-ranked (actionable) candidate for the healing test.
    const target = sel0.candidates[0];
    const tpos = { x: target.position.x, y: target.position.y, z: target.position.z };
    console.log(JSON.stringify({ target: tpos }));
    // Fake a far-away failure: attempted from 20 blocks away.
    const farFrom = { x: tpos.x + 20, y: tpos.y, z: tpos.z + 20 };
    targetFailures.recordFailure({
      dimension: targetFailures.botDimension(bot), kind: 'block', target: TYPE,
      position: tpos, reason: 'timeout', attemptedFrom: farFrom,
    });
    // From current pos (likely still far from farFrom?) check exclusion.
    // Then spoof adjacent: set bot.entity.position next to target.
    const realPos = bot.entity.position.clone();
    const adjPos = { x: tpos.x + 1, y: tpos.y, z: tpos.z + 1 };
    const excludedFar = targetFailures.isExcluded({
      dimension: targetFailures.botDimension(bot), kind: 'block', target: TYPE,
      position: tpos, fromPosition: { x: realPos.x, y: realPos.y, z: realPos.z },
    });
    console.log(JSON.stringify({ excludedFromRealPos: !!excludedFar }));
    const healed = targetFailures.isExcluded({
      dimension: targetFailures.botDimension(bot), kind: 'block', target: TYPE,
      position: tpos, fromPosition: adjPos,
    });
    console.log(JSON.stringify({ healedWhenAdjacent: healed === null }));
    // Spoof entity position adjacent and re-run selection.
    bot.entity.position.set(adjPos.x, adjPos.y + 0.5, adjPos.z);
    const sel1 = getSelectableBlocks(bot, { matching, blockType: TYPE, maxDistance: RADIUS, count: 12, kind: 'block', target: TYPE });
    const found = sel1.candidates.some((b) =>
      b.position.x === tpos.x && b.position.y === tpos.y && b.position.z === tpos.z);
    console.log(JSON.stringify({
      afterMove: { seen: sel1.candidatesSeen, skipped: sel1.candidatesSkipped, final: sel1.candidates.length, targetSelectable: found },
    }));
    console.log(JSON.stringify({
      verdict: healed === null && found ? 'PASS-adjacent-heals-and-selects' : 'FAIL',
    }));
    targetFailures.clear();
    bot.quit(); process.exit(healed === null && found ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ error: err?.message || String(err) }));
    try { bot.quit(); } catch {}
    process.exit(1);
  }
});
bot.on('error', (e) => console.error(JSON.stringify({ botError: e?.message })));
setTimeout(() => { console.error('timeout'); process.exit(2); }, 30000);
