#!/usr/bin/env node
'use strict';

// Body-only spawn probe (no LLM, no staging): connects to the configured
// Paper server, observes the spawn area through the real perception
// pipeline plus a bounded log/water scan, prints a compact terrain verdict,
// and disconnects. Used to select a naturally dry, forested spawn region
// for live model-comparison runs.

const { createBot } = require('../src/bot/createBot');
const { observe } = require('../src/bot/observations');
const { createPerceptionCache } = require('../src/bot/perception');

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const WAIT_MS = parseInt(argOf('--wait', '12000'), 10);

const bot = createBot();
const cache = createPerceptionCache();
let finished = false;

function finish(payload) {
  if (finished) return;
  finished = true;
  console.log(JSON.stringify(payload));
  try {
    bot.quit();
  } catch {
    // ignore
  }
  setTimeout(() => process.exit(0), 800);
}

setTimeout(() => {
  try {
    const p = observe(bot, { cache });
    const blocks = p.interestingBlocks || [];
    const categories = {};
    for (const b of blocks) categories[b.category || 'other'] = (categories[b.category || 'other'] || 0) + 1;
    let logsNearby = 0;
    let waterNearby = 0;
    try {
      const found = bot.findBlocks({ matching: (b) => b && b.name, maxDistance: 48, count: 200 }) || [];
      for (const pos of found) {
        const blk = bot.blockAt(pos);
        if (!blk || !blk.name) continue;
        if (/_log$/.test(blk.name)) logsNearby += 1;
        if (blk.name === 'water') waterNearby += 1;
      }
    } catch {
      // scan optional
    }
    finish({
      probe: 'spawn',
      position: p.position || null,
      categories,
      waterBlocksInPerception: categories.water || 0,
      logsNearby48: logsNearby,
      waterNearby48: waterNearby,
      logBlocks: logsNearby > 0,
      drySpawn: (categories.water || 0) <= 2 && waterNearby48 < 40,
    });
  } catch (err) {
    finish({ probe: 'spawn', error: String((err && err.message) || err).slice(0, 200) });
  }
}, WAIT_MS);

bot.on('end', () => finish({ probe: 'spawn', error: 'connection ended before probe completed' }));
