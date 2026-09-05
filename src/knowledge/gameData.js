'use strict';

// Read-only Minecraft game-data knowledge layer over the INSTALLED
// minecraft-data package. Answers factual questions (recipes, reverse recipe
// uses, item/block properties, canonical name search). It NEVER chooses
// goals, mutates the world, or touches the bot.
//
// Data honesty rules:
// - Recipe variants are preserved exactly as minecraft-data represents them.
//   Interchangeable materials (plank families etc.) appear as SEPARATE
//   variants, never flattened into one made-up recipe.
// - Results are bounded; truncation is reported explicitly (truncated/total).
// - Fields that the installed data does not provide are reported as null /
//   omitted, never invented.

const minecraftData = require('minecraft-data');

// Per-version cache: raw mcData handle + lazily built derived indexes
// (id->name resolution, reverse recipe-use index, search corpus).
const gameDataCache = new Map();

function defaultVersion() {
  return process.env.MC_VERSION || '1.21.11';
}

function getGameData(version) {
  const key = String(version || defaultVersion());
  let entry = gameDataCache.get(key);
  if (entry) return entry;
  const mcData = minecraftData(key);
  entry = {
    version: key,
    mcData,
    namesById: null, // id -> { name, kind, displayName }
    usesIndex: null, // ingredientId -> [{ outputId, variantCount, shaped, requiresTable, outputCount }]
    searchCorpus: null, // [{ name, kind, displayName, lower, tokens }]
  };
  gameDataCache.set(key, entry);
  return entry;
}

// Bounded output caps.
const RECIPE_VARIANT_CAP = 12;
const USES_OUTPUT_CAP = 20;
const SEARCH_RESULT_CAP = 10;
const DROPS_CAP = 12;
const HARVEST_TOOLS_CAP = 12;

function getNamesById(gd) {
  if (gd.namesById) return gd.namesById;
  const map = new Map();
  try {
    for (const it of gd.mcData.itemsArray || Object.values(gd.mcData.itemsByName)) {
      if (it && Number.isInteger(it.id)) map.set(it.id, { name: it.name, kind: 'item', displayName: it.displayName || null });
    }
    for (const b of gd.mcData.blocksArray || Object.values(gd.mcData.blocksByName)) {
      // Items win on id collisions (matches how recipes reference outputs).
      if (b && Number.isInteger(b.id) && !map.has(b.id)) map.set(b.id, { name: b.name, kind: 'block', displayName: b.displayName || null });
    }
  } catch {
    // index stays partial; lookups degrade to unknown
  }
  gd.namesById = map;
  return map;
}

function nameOfId(gd, id) {
  const e = getNamesById(gd).get(id);
  return e ? e.name : null;
}

// Prefer items over blocks when a name exists in both (e.g. crafting_table):
// recipes consume/produce items.
function findItemOrBlock(gd, name) {
  const it = gd.mcData.itemsByName[name];
  if (it) return { id: it.id, name: it.name, kind: 'item', displayName: it.displayName || null };
  const b = gd.mcData.blocksByName[name];
  if (b) return { id: b.id, name: b.name, kind: 'block', displayName: b.displayName || null };
  return null;
}

function requiresTableFor(shape) {
  // Trusted 2x2 rule: a shaped recipe needing a grid larger than 2x2 in any
  // dimension requires a crafting table (same rule as the crafting body).
  return shape.some((row) => row.length > 2) || shape.length > 2;
}

function describeVariant(gd, recipe, index) {
  const out = { index };
  const flat = [];
  if (Array.isArray(recipe.inShape)) {
    const shape = recipe.inShape.map((row) =>
      row.map((cell) => {
        if (cell === null || cell === undefined) return null;
        flat.push(cell);
        return nameOfId(gd, cell) || `unknown_id_${cell}`;
      })
    );
    out.shaped = true;
    out.shape = shape;
    out.requiresTable = requiresTableFor(shape);
  } else {
    out.shaped = false;
    out.shape = null;
    out.requiresTable = false;
    for (const cell of recipe.ingredients || []) flat.push(cell);
  }
  const needs = {};
  for (const id of flat) {
    const name = nameOfId(gd, id) || `unknown_id_${id}`;
    needs[name] = (needs[name] || 0) + 1;
  }
  out.ingredients = needs;
  const result = recipe.result || {};
  out.output = nameOfId(gd, result.id) || `unknown_id_${result.id}`;
  out.outputCount = Number.isInteger(result.count) ? result.count : 1;
  return out;
}

// All crafting recipe variants for one item, exactly as the installed data
// represents them. Bounded by RECIPE_VARIANT_CAP with honest truncation.
function allRecipesFor(itemName, version, options = {}) {
  const cap = Number.isInteger(options.cap) && options.cap > 0 ? options.cap : RECIPE_VARIANT_CAP;
  const gd = getGameData(version);
  const target = findItemOrBlock(gd, String(itemName || ''));
  if (!target) {
    return { ok: false, reason: 'unknown_item', item: String(itemName || '') };
  }
  const recipes = gd.mcData.recipes[String(target.id)] || [];
  const variants = [];
  for (let i = 0; i < recipes.length && variants.length < cap; i++) {
    try {
      variants.push(describeVariant(gd, recipes[i], i));
    } catch {
      // skip malformed single variant, keep the rest
    }
  }
  const result = {
    ok: true,
    item: target.name,
    source: `minecraft-data ${target.kind} data for ${gd.version}`,
    total: recipes.length,
    truncated: recipes.length > variants.length,
    variants,
  };
  if (recipes.length === 0) {
    // Honest gap: local data has crafting recipes only. Smelting/other
    // mechanics are not represented in the installed minecraft-data.
    result.note = 'No crafting recipes in local game data. Smelting and other non-crafting mechanics are not available locally; use lookup_minecraft_reference for those.';
  }
  return result;
}

function getUsesIndex(gd) {
  if (gd.usesIndex) return gd.usesIndex;
  const index = new Map();
  try {
    for (const [outputIdKey, recipes] of Object.entries(gd.mcData.recipes)) {
      const outputId = Number(outputIdKey);
      if (!Number.isInteger(outputId)) continue;
      for (const recipe of recipes || []) {
        const cells = [];
        if (Array.isArray(recipe.inShape)) {
          for (const row of recipe.inShape) for (const cell of row) if (cell !== null && cell !== undefined) cells.push(cell);
        } else {
          for (const cell of recipe.ingredients || []) cells.push(cell);
        }
        const seen = new Set();
        for (const ingredientId of cells) {
          if (!Number.isInteger(ingredientId) || seen.has(ingredientId)) continue;
          seen.add(ingredientId);
          let list = index.get(ingredientId);
          if (!list) {
            list = [];
            index.set(ingredientId, list);
          }
          let entry = list.find((e) => e.outputId === outputId);
          if (!entry) {
            const shaped = Array.isArray(recipe.inShape);
            entry = {
              outputId,
              variantCount: 0,
              shaped,
              requiresTable: shaped ? requiresTableFor(recipe.inShape) : false,
              outputCount: Number.isInteger(recipe.result?.count) ? recipe.result.count : 1,
            };
            list.push(entry);
          }
          entry.variantCount += 1;
        }
      }
    }
  } catch {
    // index stays partial; uses lookups degrade to empty
  }
  gd.usesIndex = index;
  return index;
}

// Reverse recipe lookup: distinct outputs whose recipes use this item.
// Deterministic data order (no progression ordering). Bounded with honest
// truncation. Variant counts are reported, never flattened away.
function usesOf(itemName, version, options = {}) {
  const cap = Number.isInteger(options.cap) && options.cap > 0 ? options.cap : USES_OUTPUT_CAP;
  const gd = getGameData(version);
  const target = findItemOrBlock(gd, String(itemName || ''));
  if (!target) {
    return { ok: false, reason: 'unknown_item', item: String(itemName || '') };
  }
  const index = getUsesIndex(gd);
  const entries = index.get(target.id) || [];
  const uses = [];
  for (const e of entries) {
    if (uses.length >= cap) break;
    uses.push({
      output: nameOfId(gd, e.outputId) || `unknown_id_${e.outputId}`,
      outputCount: e.outputCount,
      variantCount: e.variantCount,
      shaped: e.shaped,
      requiresTable: e.requiresTable,
    });
  }
  return {
    ok: true,
    item: target.name,
    total: entries.length,
    truncated: entries.length > uses.length,
    uses,
    note: uses.length > 0 ? 'Use lookup_recipe(output) for the full variant list of an output.' : undefined,
  };
}

function getSearchCorpus(gd) {
  if (gd.searchCorpus) return gd.searchCorpus;
  const corpus = [];
  const pushAll = (byName, kind) => {
    try {
      for (const it of Object.values(byName || {})) {
        if (!it || typeof it.name !== 'string') continue;
        const lower = it.name.toLowerCase();
        corpus.push({
          name: it.name,
          kind,
          displayName: it.displayName || null,
          lower,
          tokens: lower.split(/[^a-z0-9]+/).filter(Boolean),
        });
      }
    } catch {
      // partial corpus is acceptable
    }
  };
  pushAll(gd.mcData.itemsByName, 'item');
  pushAll(gd.mcData.blocksByName, 'block');
  gd.searchCorpus = corpus;
  return corpus;
}

function tokenizeQuery(q) {
  return String(q || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Bounded canonical-name search over items + blocks. Simple deterministic
// substring/token ranking — no progression ordering, no external deps.
function searchGameData(query, version, options = {}) {
  const cap = Number.isInteger(options.cap) && options.cap > 0 ? options.cap : SEARCH_RESULT_CAP;
  const gd = getGameData(version);
  const raw = String(query || '').trim();
  if (!raw) return { ok: false, reason: 'empty_query' };
  const lower = raw.toLowerCase();
  const tokens = tokenizeQuery(raw);
  const scored = [];
  for (const entry of getSearchCorpus(gd)) {
    let score = 0;
    if (entry.lower === lower) score = 100;
    else if (entry.lower.startsWith(lower)) score = 80;
    else if (entry.lower.includes(lower)) score = 60;
    else if (tokens.length > 0) {
      let tokenScore = 0;
      let matchedTokens = 0;
      for (const t of tokens) {
        if (entry.tokens.includes(t)) {
          tokenScore += 30;
          matchedTokens += 1;
        } else if (entry.tokens.some((x) => x.startsWith(t))) {
          tokenScore += 15;
          matchedTokens += 1;
        }
      }
      // Bonus when every query token matched somewhere in the name, so
      // "wood pick" outranks a name that only contains "wood".
      if (tokens.length > 1 && matchedTokens === tokens.length) tokenScore += 25;
      score = tokenScore;
    }
    if (score <= 0) continue;
    const dn = (entry.displayName || '').toLowerCase();
    if (dn.includes(lower)) score += 5;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.entry.name.length !== b.entry.name.length) return a.entry.name.length - b.entry.name.length;
    return a.entry.name.localeCompare(b.entry.name);
  });
  const matches = scored.slice(0, cap).map(({ entry }) => ({
    name: entry.name,
    type: entry.kind,
    displayName: entry.displayName,
  }));
  return {
    ok: true,
    query: raw,
    total: scored.length,
    truncated: scored.length > matches.length,
    matches,
  };
}

// Item facts, only fields the installed data actually provides.
function itemInfo(itemName, version) {
  const gd = getGameData(version);
  const it = gd.mcData.itemsByName[String(itemName || '')];
  if (!it) return { ok: false, reason: 'unknown_item', item: String(itemName || '') };
  const food = gd.mcData.foodsByName ? gd.mcData.foodsByName[it.name] : null;
  return {
    ok: true,
    type: 'item',
    name: it.name,
    displayName: it.displayName || null,
    stackSize: Number.isInteger(it.stackSize) ? it.stackSize : null,
    maxDurability: Number.isInteger(it.maxDurability) ? it.maxDurability : null,
    food: food
      ? {
          foodPoints: typeof food.foodPoints === 'number' ? food.foodPoints : null,
          saturation: typeof food.saturation === 'number' ? food.saturation : null,
        }
      : null,
  };
}

// Block facts, only fields the installed data actually provides. Tool
// requirement is expressed as the honest harvestTools list (tool items that
// can harvest this block) when the data provides it.
function blockInfo(blockName, version) {
  const gd = getGameData(version);
  const b = gd.mcData.blocksByName[String(blockName || '')];
  if (!b) return { ok: false, reason: 'unknown_block', block: String(blockName || '') };
  const drops = Array.isArray(b.drops) ? b.drops.slice(0, DROPS_CAP).map((id) => nameOfId(gd, id) || `unknown_id_${id}`) : null;
  const harvestTools = b.harvestTools
    ? Object.keys(b.harvestTools)
        .map((k) => nameOfId(gd, Number(k)) || null)
        .filter(Boolean)
        .slice(0, HARVEST_TOOLS_CAP)
    : null;
  return {
    ok: true,
    type: 'block',
    name: b.name,
    displayName: b.displayName || null,
    hardness: typeof b.hardness === 'number' ? b.hardness : null,
    resistance: typeof b.resistance === 'number' ? b.resistance : null,
    material: b.material || null,
    diggable: typeof b.diggable === 'boolean' ? b.diggable : null,
    transparent: typeof b.transparent === 'boolean' ? b.transparent : null,
    boundingBox: b.boundingBox || null,
    drops,
    harvestTools,
    harvestToolsTruncated: harvestTools ? Object.keys(b.harvestTools).length > HARVEST_TOOLS_CAP : false,
  };
}

module.exports = {
  getGameData,
  allRecipesFor,
  usesOf,
  searchGameData,
  itemInfo,
  blockInfo,
  RECIPE_VARIANT_CAP,
  USES_OUTPUT_CAP,
  SEARCH_RESULT_CAP,
};
