'use strict';

// Deterministic milestone completion predicates. Trusted code decides
// completion — never the LLM's opinion. Wood families are interchangeable
// (*_log, *_stem, *_planks); no oak-only overfitting.
//
// State shape (built by the loop from bounded perception + outcomes):
// {
//   inventory: { <itemName>: <count> },
//   nearbyBlocks: [{ type, distance }],   // bounded interestingBlocks
//   session: { craftedTable: bool, placedTable: bool }
// }

const { THRESHOLDS } = require('./milestones');

function isLog(name) {
  return typeof name === 'string' && (name.endsWith('_log') || name.endsWith('_stem'));
}

function isPlanks(name) {
  return typeof name === 'string' && name.endsWith('_planks');
}

function countWhere(inventory, test) {
  let total = 0;
  try {
    for (const [name, count] of Object.entries(inventory || {})) {
      if (test(name) && Number.isFinite(Number(count))) total += Number(count);
    }
  } catch {
    // ignore
  }
  return total;
}

function countItem(inventory, name) {
  try {
    const n = Number((inventory || {})[name]);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function nearbyTypeWithin(nearbyBlocks, names, maxDistance) {
  const set = new Set(Array.isArray(names) ? names : [names]);
  try {
    for (const b of nearbyBlocks || []) {
      if (b && set.has(b.type) && typeof b.distance === 'number' && b.distance <= maxDistance) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

const EVALUATORS = {
  obtain_logs: (state) => countWhere(state.inventory, isLog) >= THRESHOLDS.logs,
  make_planks: (state) => countWhere(state.inventory, isPlanks) >= THRESHOLDS.planks,
  // A placed table leaves inventory: session history (trusted craft outcome)
  // keeps this complete after placement consumes the item.
  craft_crafting_table: (state) =>
    countItem(state.inventory, 'crafting_table') >= 1 || !!(state.session && state.session.craftedTable),
  // Satisfied by a nearby placed table (own or found) or a verified
  // placement outcome this session.
  establish_crafting_table: (state) =>
    nearbyTypeWithin(state.nearbyBlocks, ['crafting_table'], 8) ||
    !!(state.session && state.session.placedTable),
  craft_wooden_pickaxe: (state) => countItem(state.inventory, 'wooden_pickaxe') >= 1,
  obtain_cobblestone: (state) => countItem(state.inventory, 'cobblestone') >= THRESHOLDS.cobblestone,
  craft_stone_pickaxe: (state) => countItem(state.inventory, 'stone_pickaxe') >= 1,
};

function isComplete(id, state) {
  const fn = EVALUATORS[id];
  if (typeof fn !== 'function') return false;
  try {
    return fn(state) === true;
  } catch {
    return false;
  }
}

module.exports = { isLog, isPlanks, countWhere, countItem, nearbyTypeWithin, isComplete, EVALUATORS };
