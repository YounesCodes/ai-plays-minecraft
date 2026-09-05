#!/usr/bin/env node
'use strict';

// Microbenchmark: place_block_nearby reliability matrix (no LLM).
// Diagnostic for live failures of the form
//   "Placement failed (x,y,z:verify-failed; ...)".
//
// Staging: tries /give ONLY after empirically confirming the bot has op
// (inventory delta after one bounded attempt). If that fails, falls back to
// the self-sufficient route already used by bench-drop-pickup.cjs: gather
// oak logs via the trusted mine_block_type primitive, then craft oak_planks
// and crafting_table via the trusted craft_item primitive. Placed blocks are
// broken again between attempts so inventory recycles and attempts stay
// independent. Placement itself uses ONLY the trusted primitive:
//   executePrimitive(bot, { primitive: 'place_block_nearby', args: { item } },
//                    { timeoutMs: 15000, shouldAbort }).
//
// Output: one JSON line per attempt {n, item, botPosition, yawDeg, ok, reason,
// error(<=120), placedPosition, attemptsTried, durationMs, diag} plus a final
// {summary:{total, ok, fail, byReason, ...}}. Read-only wrt the repo; never
// logs secrets.

const { createBot } = require('../src/bot/createBot');
const { executePrimitive } = require('../src/primitives');
const { blockAtPos } = require('../src/blocks');
const { stopBotMotion } = require('../src/primitives/movement');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const USER = process.env.MC_USERNAME || 'Agent01';
const ITEMS = ['crafting_table', 'oak_planks'];
const ATTEMPTS = Math.max(20, parseInt(arg('--attempts', '20'), 10) || 20);
const START = Date.now();
const DEADLINE = START + 255000; // finish well before the 300s shell timeout
let finished = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function roundPos(p) {
  if (!p) return null;
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 };
}
function countItem(name) {
  try {
    return (bot.inventory.items() || []).filter((i) => i && i.name === name).reduce((a, i) => a + i.count, 0);
  } catch {
    return 0;
  }
}
function isDryGround(b) {
  return !!b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava' && b.boundingBox !== 'empty';
}
function isAirCell(b) {
  return !b || b.name === 'air'; // null only tolerated for the cell above ground
}
function withTimeout(promise, ms, tag) {
  return Promise.race([
    promise,
    sleep(ms).then(() => ({ ok: false, reason: 'bench_timeout', error: `${tag} exceeded ${ms}ms` })),
  ]);
}
// Pull candidate cells back out of the primitive's bounded error string so we
// can independently re-read what is ACTUALLY in those cells now.
function parseCandidates(errText) {
  const out = [];
  const re = /(-?\d+),(-?\d+),(-?\d+):([a-zA-Z-]+)/g;
  let m;
  while ((m = re.exec(String(errText || ''))) !== null && out.length < 4) {
    out.push({ x: Number(m[1]), y: Number(m[2]), z: Number(m[3]), tag: m[4] });
  }
  return out;
}

const bot = createBot();

// --- staging ---------------------------------------------------------------

let logTrips = 0;
async function mineLogs(count) {
  if (logTrips >= 3 || Date.now() > DEADLINE) return false;
  logTrips += 1;
  const res = await withTimeout(
    executePrimitive(bot, { primitive: 'mine_block_type', args: { blockType: 'oak_log', count } }, { timeoutMs: 70000 }),
    80000,
    'mine_logs'
  );
  console.log(JSON.stringify({ stagingStep: 'mine_logs', ok: !!(res && res.ok), trips: logTrips }));
  return !!(res && res.ok);
}
async function craftItem(name, count) {
  const res = await withTimeout(
    executePrimitive(bot, { primitive: 'craft_item', args: { item: name, count } }, { timeoutMs: 20000 }),
    25000,
    `craft_${name}`
  );
  if (!res || !res.ok) {
    console.log(JSON.stringify({ stagingStep: 'craft', item: name, ok: false, error: String((res && res.error) || '').slice(0, 100) }));
  }
  return !!(res && res.ok);
}
async function tryOpGive() {
  // Empirical op check: exactly one bounded /give per item, confirmed by an
  // inventory delta. Never assumes; harmless when not op (server just
  // rejects the command).
  const out = {};
  for (const item of ITEMS) {
    const before = countItem(item);
    try {
      bot.chat(`/give ${USER} ${item} 32`);
    } catch {}
    await sleep(2500);
    out[item] = countItem(item) > before;
  }
  return out;
}
// NOTE: mineflayer's bot.craft(recipe, count) treats count as desired OUTPUT
// items (ceil(count / recipe.result.count) plans), not craft iterations.
async function ensureStock(item) {
  if (countItem(item) >= 2) return true;
  if (item === 'crafting_table' && countItem('oak_planks') >= 4) await craftItem('crafting_table', 1);
  if (countItem(item) >= 1) return true;
  if (countItem('oak_log') >= 1) await craftItem('oak_planks', 4);
  if (item === 'crafting_table' && countItem('oak_planks') >= 4) await craftItem('crafting_table', 1);
  if (countItem(item) >= 1) return true;
  if (await mineLogs(2)) {
    await craftItem('oak_planks', 4);
    if (item === 'crafting_table') await craftItem('crafting_table', 1);
  }
  return countItem(item) >= 1;
}

// --- terrain ---------------------------------------------------------------

function columnOk(bx, by, bz) {
  if (!isDryGround(blockAtPos(bot, bx, by, bz))) return false;
  if (!isDryGround(blockAtPos(bot, bx, by - 1, bz))) return false;
  return isAirCell(blockAtPos(bot, bx, by + 1, bz)) && isAirCell(blockAtPos(bot, bx, by + 2, bz));
}
function flatScore(bx, by, bz) {
  let ok = 0;
  for (let ix = -2; ix <= 2; ix++) {
    for (let iz = -2; iz <= 2; iz++) {
      if (columnOk(bx + ix, by, bz + iz)) ok += 1;
    }
  }
  return ok;
}
function findFlatPatch(radius) {
  const me = bot.entity.position;
  const bx = Math.floor(me.x);
  const by = Math.floor(me.y);
  const bz = Math.floor(me.z);
  let best = null;
  let bestScore = 0;
  for (let r = 0; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const score = flatScore(bx + dx, by, bz + dz);
        if (score > bestScore) {
          bestScore = score;
          best = { x: bx + dx, y: by, z: bz + dz };
        }
      }
    }
    if (bestScore >= 20) break; // comfortable 5x5 dry/level patch found
  }
  return best ? { ...best, score: bestScore } : null;
}

// --- per-attempt helpers ---------------------------------------------------

async function breakPlacedBlock(x, y, z, itemName) {
  try {
    const b = blockAtPos(bot, x, y, z);
    if (!b || b.name !== itemName) return false;
    await withTimeout(bot.dig(b), 9000, 'cleanup-dig');
    await sleep(900); // item-entity pickup settle
    return true;
  } catch {
    return false;
  }
}
async function relocateOneColumn() {
  // Move to the best nearby flat column (rings 2..6) so attempts do not all
  // share one ground cell. Accepts the best patch found, whatever its score.
  const me = bot.entity.position;
  const bx = Math.floor(me.x);
  const by = Math.floor(me.y);
  const bz = Math.floor(me.z);
  let best = null;
  let bestScore = 9; // must beat the average-ish column to be worth a walk
  for (let r = 2; r <= 6; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const s = flatScore(bx + dx, by, bz + dz);
        if (s > bestScore) {
          bestScore = s;
          best = { x: bx + dx, y: by, z: bz + dz };
        }
      }
    }
  }
  if (!best) return { moved: false };
  const res = await withTimeout(
    executePrimitive(bot, { primitive: 'move_near', args: { x: best.x, y: best.y, z: best.z, range: 1 } }, { timeoutMs: 15000 }),
    17000,
    'relocate'
  );
  return { moved: !!(res && res.ok), to: best, score: bestScore };
}

// --- main ------------------------------------------------------------------

bot.once('spawn', async () => {
  const rows = [];
  const byReason = {};
  const byItem = {};
  for (const it of ITEMS) byItem[it] = { ok: 0, fail: 0 };
  const staging = { opGive: null, selfGathered: false, available: [] };

  function summarize() {
    let ok = 0;
    for (const r of rows) {
      if (r.ok) ok += 1;
      const k = r.reason || (r.ok ? 'ok' : 'unknown');
      byReason[k] = (byReason[k] || 0) + 1;
      if (byItem[r.item]) byItem[r.item][r.ok ? 'ok' : 'fail'] += 1;
    }
    return {
      total: rows.length,
      ok,
      fail: rows.length - ok,
      byReason,
      byItem,
      okPct: rows.length ? Math.round((ok / rows.length) * 1000) / 10 : 0,
      attemptsRequested: ATTEMPTS,
      staging,
      user: USER,
      elapsedMs: Date.now() - START,
    };
  }

  try {
    await sleep(8000); // spawn + chunk settle
    const spawnPos = roundPos(bot.entity.position);
    console.log(JSON.stringify({ bench: 'place-matrix', spawn: spawnPos }));

    // Flat dry terrain: relocate once if spawn column is not workable.
    let patch = findFlatPatch(8);
    let movedTo = null;
    if (patch) {
      const me = bot.entity.position;
      const d = Math.hypot(patch.x + 0.5 - me.x, patch.z + 0.5 - me.z);
      if (d > 2) {
        const res = await withTimeout(
          executePrimitive(bot, { primitive: 'move_near', args: { x: patch.x, y: patch.y, z: patch.z, range: 1 } }, { timeoutMs: 25000 }),
          27000,
          'goto-patch'
        );
        if (res && res.ok) movedTo = roundPos(bot.entity.position);
        patch = findFlatPatch(8) || patch;
      }
    }
    console.log(JSON.stringify({ terrain: { patch, movedTo } }));

    // Stage items: /give only if op, else self-gather via trusted primitives.
    staging.opGive = await tryOpGive();
    const opStaged = ITEMS.every((it) => staging.opGive[it]);
    if (!opStaged) {
      if (countItem('oak_planks') < 12) {
        if (countItem('oak_log') < 1) await mineLogs(3);
        if (countItem('oak_log') >= 1) await craftItem('oak_planks', 16);
      }
      if (countItem('crafting_table') < 2 && countItem('oak_planks') >= 4) await craftItem('crafting_table', 2);
      staging.selfGathered = countItem('oak_planks') >= 4 || countItem('crafting_table') >= 1;
    }
    // ensureStock() can top either item up from logs, so both stay
    // exercisable whenever raw logs are obtainable.
    staging.available = ITEMS.filter((it) => countItem(it) >= 1 || countItem('oak_log') >= 1);
    if (staging.available.length === 0) {
      console.log(JSON.stringify({
        verdict: 'STAGING-IMPOSSIBLE',
        note: 'No op (no /give), no creative injection (not used by existing benches), and self-gathering produced no placeable items. Stopping honestly.',
        inventory: ITEMS.map((it) => ({ item: it, count: countItem(it) })).concat([{ item: 'oak_log', count: countItem('oak_log') }]),
        summary: summarize(),
      }));
      bot.quit();
      process.exit(0);
      return;
    }
    console.log(JSON.stringify({ staged: { available: staging.available, planks: countItem('oak_planks'), tables: countItem('crafting_table'), logs: countItem('oak_log') } }));

    // Attempt loop: strict item alternation across what is available.
    for (let n = 1; n <= ATTEMPTS; n++) {
      if (Date.now() > DEADLINE) {
        console.log(JSON.stringify({ note: 'deadline-reached', skippedFrom: n }));
        break;
      }
      const wantTable = n % 2 === 1;
      const item = wantTable ? 'crafting_table' : 'oak_planks';

      const yaw = (((n - 1) % 8) * Math.PI) / 4; // vary facing across 8 directions
      try { await bot.look(yaw, 0, true); } catch { /* best effort */ }
      await sleep(150);

      const stocked = await ensureStock(item);
      const botPos = roundPos(bot.entity.position);
      const yawDeg = Math.round((((yaw * 180) / Math.PI) % 360 + 360) % 360);
      if (!stocked) {
        rows.push({ n, item, botPosition: botPos, yawDeg, ok: false, reason: 'missing_item', error: 'bench could not stage item (no op, self-gather exhausted)', placedPosition: null, attemptsTried: 0, durationMs: 0, diag: {} });
        continue;
      }

      const before = countItem(item);
      const t0 = Date.now();
      const res = await withTimeout(
        executePrimitive(bot, { primitive: 'place_block_nearby', args: { item } }, { timeoutMs: 15000, shouldAbort: () => Date.now() > DEADLINE }),
        25000,
        'place_attempt'
      );
      const durationMs = Date.now() - t0;
      if (res && res.reason === 'bench_timeout') {
        try { stopBotMotion(bot); } catch {}
        await sleep(1500);
      }

      const row = {
        n,
        item,
        botPosition: botPos,
        yawDeg,
        ok: !!(res && res.ok),
        reason: res && res.ok ? null : String((res && (res.reason || 'placement_failed')) || 'placement_failed'),
        error: String((res && res.error) || '').slice(0, 120),
        placedPosition: res && res.ok && res.position ? res.position : null,
        attemptsTried: res && res.ok ? 1 : Math.max(1, parseCandidates(res && res.error).length),
        durationMs,
        diag: {},
      };

      if (row.ok) {
        // Independent re-read of the claimed placed cell, then recycle it.
        const p = row.placedPosition;
        await sleep(350);
        const b = blockAtPos(bot, p.x, p.y, p.z);
        row.diag.postName = b ? b.name : null;
        row.diag.retrieved = await breakPlacedBlock(p.x, p.y, p.z, item);
        row.diag.invDelta = before - countItem(item);
      } else {
        // What is ACTUALLY in the candidate target cells now? Distinguishes
        // "placed but verification read disagreed" from "never placed".
        await sleep(400);
        const cands = parseCandidates(res && res.error);
        const postState = [];
        for (const c of cands.slice(0, 3)) {
          const b = blockAtPos(bot, c.x, c.y + 1, c.z);
          postState.push(`${c.x},${c.y + 1},${c.z}=${b ? b.name : 'null'}`);
          if (b && b.name === item) await breakPlacedBlock(c.x, c.y + 1, c.z, item);
        }
        row.diag.postState = postState;
        row.diag.invDelta = before - countItem(item);
      }
      rows.push(row);
      console.log(JSON.stringify(row));

      // Fresh column every 2nd attempt (independence across positions).
      if (n % 2 === 0 && n < ATTEMPTS && Date.now() < DEADLINE) {
        const rel = await relocateOneColumn();
        if (rel.moved) console.log(JSON.stringify({ relocated: rel.to }));
      }
    }

    console.log(JSON.stringify({ summary: summarize() }));
    finished = true;
    bot.quit();
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ error: String((err && err.message) || err).slice(0, 200) }));
    console.log(JSON.stringify({ summary: summarize() }));
    finished = true;
    try { bot.quit(); } catch {}
    process.exit(1);
  }
});

bot.on('error', (e) => console.error(JSON.stringify({ botError: String((e && e.message) || e).slice(0, 120) })));

// Hard safety net: always emit a summary before the 300s shell timeout.
setTimeout(() => {
  if (!finished) {
    console.error(JSON.stringify({ error: 'bench-hard-timeout' }));
    try { bot.quit(); } catch {}
    process.exit(3);
  }
}, 288000).unref();
