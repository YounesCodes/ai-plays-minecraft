'use strict';

// Trusted recipe hints for curriculum context (minecraft-data, not prompts).
// The LLM cannot see the body's private recipe lookup, so craft milestones
// carry their material requirements explicitly — otherwise the model grinds
// base materials forever without knowing the next transformation
// (observed live: 20+ logs held, table never crafted).
// Generic mechanism: any item name, first recipe, no hard-coded chains.
//
// Data facts verified against installed minecraft-data 1.21.11:
// - mcData.recipes is keyed by ITEM id (string); block ids differ
//   (crafting_table item 332 vs block 205), so itemsByName comes first.
// - shaped recipes use inShape (2D item-id grids); shapeless use
//   ingredients (flat id list with nulls).
// - requiresTable follows prismarine-recipe's rule: any inShape dimension
//   > 2 (2x2 inventory grid) needs a table.

function getMinecraftData(version) {
  try {
    return require('minecraft-data')(version || '1.21.11');
  } catch {
    return null;
  }
}

// Plank/log families are interchangeable in recipes: resolve the milestone's
// canonical target to a concrete item the data knows. Prefer a family the
// bot actually holds (planks first, then logs/stems of the same family),
// fall back to oak.
function resolveTarget(target, inventory, mcData) {
  if (target !== 'planks') return target;
  const known = (n) => {
    try {
      return !!((mcData.itemsByName && mcData.itemsByName[n]) || (mcData.blocksByName && mcData.blocksByName[n]));
    } catch {
      return false;
    }
  };
  try {
    const inv = inventory || {};
    for (const name of Object.keys(inv)) {
      if (typeof name === 'string' && name.endsWith('_planks') && Number(inv[name]) > 0 && known(name)) return name;
    }
    for (const name of Object.keys(inv)) {
      if (typeof name !== 'string' || Number(inv[name]) <= 0) continue;
      const base = name.endsWith('_log') ? name.slice(0, -4) : name.endsWith('_stem') ? name.slice(0, -5) : null;
      if (base && known(`${base}_planks`)) return `${base}_planks`;
    }
  } catch {
    // ignore
  }
  return 'oak_planks';
}

function itemNameOf(mcData, id) {
  try {
    if (id === null || id === undefined) return null;
    const entry = (mcData.items && mcData.items[id]) || (mcData.blocks && mcData.blocks[id]);
    return entry && entry.name ? entry.name : null;
  } catch {
    return null;
  }
}

function requiresTableFor(raw) {
  try {
    if (!raw || !Array.isArray(raw.inShape)) return false;
    if (raw.inShape.length > 2) return true;
    return raw.inShape.some((row) => Array.isArray(row) && row.length > 2);
  } catch {
    return false;
  }
}

// Returns { needs: {item: count}, requiresTable: bool } for the first known
// recipe, or null when the data has nothing (model falls back to trying).
function recipeHint(target, inventory, version) {
  try {
    const mcData = getMinecraftData(version);
    if (!mcData || !mcData.recipes) return null;
    const name = resolveTarget(target, inventory, mcData);
    const item = (mcData.itemsByName && mcData.itemsByName[name]) ||
      (mcData.blocksByName && mcData.blocksByName[name]);
    if (!item) return null;
    const recipes = mcData.recipes[String(item.id)];
    if (!Array.isArray(recipes) || recipes.length === 0) return null;
    const parsed = [];
    for (const r of recipes) {
      if (!r) continue;
      const needs = {};
      if (Array.isArray(r.ingredients)) {
        for (const ing of r.ingredients) {
          if (ing === null || ing === undefined) continue;
          const id = typeof ing === 'object' ? (ing.id ?? ing) : ing;
          const iname = itemNameOf(mcData, id);
          if (!iname) continue;
          needs[iname] = (needs[iname] || 0) + 1;
        }
      } else if (Array.isArray(r.inShape)) {
        for (const row of r.inShape) {
          if (!Array.isArray(row)) continue;
          for (const cell of row) {
            if (cell === null || cell === undefined) continue;
            const iname = itemNameOf(mcData, cell);
            if (!iname) continue;
            needs[iname] = (needs[iname] || 0) + 1;
          }
        }
      }
      if (Object.keys(needs).length === 0) continue;
      parsed.push({ needs, requiresTable: requiresTableFor(r) });
    }
    if (parsed.length === 0) return null;
    // Prefer a recipe whose materials are already held (adapts across
    // stone/cobblestone/deepslate variants); else the first known recipe.
    try {
      const inv = inventory || {};
      const covered = parsed.find((p) =>
        Object.entries(p.needs).every(([n, c]) => Number(inv[n] || 0) >= c)
      );
      if (covered) return covered;
    } catch {
      // ignore
    }
    return parsed[0];
  } catch {
    return null;
  }
}

// Milestone id -> craft target item (null when the milestone is not a craft).
function craftTargetFor(milestoneId) {
  switch (milestoneId) {
    case 'make_planks':
      return 'planks';
    case 'craft_crafting_table':
      return 'crafting_table';
    case 'craft_wooden_pickaxe':
      return 'wooden_pickaxe';
    case 'craft_stone_pickaxe':
      return 'stone_pickaxe';
    default:
      return null;
  }
}

module.exports = { recipeHint, craftTargetFor, resolveTarget };
