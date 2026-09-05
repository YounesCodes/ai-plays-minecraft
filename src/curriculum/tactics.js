'use strict';

// Deterministic curriculum tactics: mechanically unambiguous next actions
// derived from trusted curriculum status — no LLM call needed. The LLM owns
// strategy (what to pursue, exploration, recovery); this layer owns trivial
// HOW only when exactly one operation makes sense:
//
// - craft milestone ready, no table needed  -> craft_item(craftAs, 1)
// - craft milestone ready, table nearby     -> craft_item(craftAs, 1)
// - craft milestone ready, table far+known  -> move_to_known_location(station)
// - establish milestone + table held        -> place_block_nearby(table)
// - exactly one craftable missing piece     -> craft the intermediate once
//
// Everything else (acquisition, exploration, recovery, strategy) returns
// null and goes to normal autonomous-v2 cognition. Outputs pass through
// normal primitive validation at execution. One recipe operation per tick;
// fresh perception follows each execution.

const { validatePrimitiveCall } = require('../safety/primitiveValidator');

function numEnvInt(name, fallback, min, max) {
  const v = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function asStep(name, args, reason) {
  const checked = validatePrimitiveCall({ primitive: name, args });
  if (!checked.ok) return null;
  return { step: { type: 'primitive', name: checked.value.primitive, args: checked.value.args }, reason };
}

// status: active milestone recipeStatus (or null); inventory: name->count;
// milestoneId: active milestone id (establish rule needs it).
function getCurriculumTactic({ status, milestoneId, inventory, emergency, tableNearby = null }) {
  if (emergency) return null;
  if (!status || typeof status !== 'object') {
    return establishTactic({ milestoneId, inventory, tableNearby });
  }
  // Craft-milestone rules (need exact status fields).
  if (status.materialsReady === true) {
    if (status.requiresTable === true) {
      if (status.tableNearby === true) {
        if (typeof status.craftAs !== 'string' || !status.craftAs) return null;
        return asStep('craft_item', { item: status.craftAs, count: 1 }, 'craft-at-table');
      }
      if (status.tableNearby === false && status.knownStation && typeof status.knownStation.name === 'string') {
        return asStep('move_to_known_location', { name: status.knownStation.name, range: 4 }, 'return-to-station');
      }
      return null;
    }
    // No table required: craft directly.
    if (status.requiresTable === false) {
      if (typeof status.craftAs !== 'string' || !status.craftAs) return null;
      return asStep('craft_item', { item: status.craftAs, count: 1 }, 'craft-ready');
    }
    return null;
  }
  // Not ready: exactly one safely-craftable missing intermediate.
  try {
    const missing = Array.isArray(status.craftableMissing) ? status.craftableMissing : [];
    const options = missing.filter((c) => c && c.canCraftNow === true && typeof c.item === 'string');
    if (options.length === 1) {
      const want = Number(status.missing ? status.missing[options[0].item] : NaN);
      const count = Number.isFinite(want) && want > 0 ? Math.min(64, Math.ceil(want)) : 1;
      if (status.requiresTable === true && status.tableNearby !== true) return null;
      return asStep('craft_item', { item: options[0].item, count }, 'craft-intermediate');
    }
  } catch {
    // ignore
  }
  return null;
}

// Table establishment: hold a crafting table, none usable nearby.
// tableNearby comes from current perception (loop side); status-based
// milestones use status.tableNearby instead.
function establishTactic({ milestoneId, inventory, tableNearby }) {
  try {
    if (milestoneId !== 'establish_crafting_table') return null;
    if (tableNearby === true) return null; // already usable; nothing to do
    const inv = inventory || {};
    if (Number(inv.crafting_table || 0) >= 1) {
      return asStep('place_block_nearby', { item: 'crafting_table' }, 'place-table');
    }
  } catch {
    // ignore
  }
  return null;
}

module.exports = { getCurriculumTactic };
