'use strict';

// Knowledge-layer tests against the REAL installed minecraft-data.
// Verifies: faithful recipe variants, honest truncation, bounded reverse
// lookups with no progression ordering, canonical search, item/block facts,
// and the security contract of the knowledge primitives (validation, no
// url/path/code fields, information-only results).

const test = require('node:test');
const assert = require('node:assert');

const gameData = require('../src/knowledge/gameData');
const { validatePrimitiveCall, PRIMITIVE_SCHEMAS } = require('../src/safety/primitiveValidator');
const { executePrimitive, listPrimitives } = require('../src/primitives');

const VERSION = '1.21.11';

// --- lookup_recipe -------------------------------------------------------

test('lookup_recipe returns real recipe data for a known item', () => {
  const out = gameData.allRecipesFor('wooden_pickaxe', VERSION);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.item, 'wooden_pickaxe');
  assert.ok(out.total >= 1);
  assert.ok(out.variants.length >= 1);
  // A real pickaxe variant: shaped, 3 planks + 2 sticks, table required.
  const v = out.variants[0];
  assert.strictEqual(v.shaped, true);
  assert.strictEqual(v.requiresTable, true);
  assert.strictEqual(v.output, 'wooden_pickaxe');
  assert.strictEqual(v.outputCount, 1);
  const names = Object.keys(v.ingredients);
  assert.ok(names.includes('stick'), 'variant ingredients include stick');
  assert.ok(names.some((n) => n.endsWith('_planks')), 'variant ingredients include a plank family');
  // Shape preserved as a 2D grid of names/null, 3x3 for a pickaxe: a full
  // plank row, then a stick column in the middle.
  assert.strictEqual(v.shape.length, 3);
  assert.strictEqual(v.shape[0].length, 3);
  assert.strictEqual(v.shape[1][0], null, 'empty cells preserved in shape');
  assert.strictEqual(v.shape[1][1], 'stick', 'handle stick in the middle column');
  assert.strictEqual(v.shape[2][1], 'stick');
});

test('lookup_recipe preserves multiple variants faithfully (no flattening)', () => {
  const out = gameData.allRecipesFor('wooden_pickaxe', VERSION);
  // Interchangeable plank families are SEPARATE variants in the data, and
  // they must stay separate: at least two variants with different plank
  // types, each with its own ingredient list.
  const plankTypes = new Set(out.variants.map((v) => Object.keys(v.ingredients).find((n) => n.endsWith('_planks'))));
  assert.ok(plankTypes.size >= 2, `expected multiple plank-family variants, got ${[...plankTypes].join(',')}`);
  const shapeless = gameData.allRecipesFor('oak_planks', VERSION);
  assert.strictEqual(shapeless.ok, true);
  assert.strictEqual(shapeless.variants[0].shaped, false);
  assert.strictEqual(shapeless.variants[0].requiresTable, false);
  assert.strictEqual(shapeless.variants[0].outputCount, 4);
});

test('lookup_recipe bounds output and reports truncation honestly', () => {
  const out = gameData.allRecipesFor('wooden_pickaxe', VERSION, { cap: 3 });
  assert.strictEqual(out.variants.length, 3);
  assert.strictEqual(out.total, 12);
  assert.strictEqual(out.truncated, true);
  const uncapped = gameData.allRecipesFor('oak_planks', VERSION);
  assert.strictEqual(uncapped.truncated, false);
  assert.strictEqual(uncapped.total, uncapped.variants.length);
});

test('lookup_recipe reports unknown items and empty recipe sets honestly', () => {
  const unknown = gameData.allRecipesFor('definitely_not_a_real_item', VERSION);
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.reason, 'unknown_item');
  // An item with no crafting recipes gets an honest note, not fabricated data.
  const noCraft = gameData.allRecipesFor('water_bucket', VERSION);
  if (noCraft.ok && noCraft.total === 0) {
    assert.match(noCraft.note, /no crafting recipes/i);
  }
});

// --- lookup_uses ---------------------------------------------------------

test('lookup_uses returns bounded reverse recipe information', () => {
  const out = gameData.usesOf('stick', VERSION, { cap: 5 });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.item, 'stick');
  assert.ok(out.total >= 5, 'stick is used by many recipes');
  assert.strictEqual(out.uses.length, 5);
  assert.strictEqual(out.truncated, true);
  for (const u of out.uses) {
    assert.ok(typeof u.output === 'string' && u.output.length > 0);
    assert.ok(u.variantCount >= 1);
    assert.strictEqual(typeof u.requiresTable, 'boolean');
  }
  // Caching + determinism: second call identical (reverse index reuse).
  const again = gameData.usesOf('stick', VERSION, { cap: 5 });
  assert.deepStrictEqual(again.uses, out.uses);
});

test('lookup_uses does not impose progression ordering', () => {
  // Deterministic DATA order: two runs agree, and the result contains no
  // curriculum/milestone/progression fields whatsoever.
  const a = gameData.usesOf('oak_log', VERSION, { cap: 10 });
  const b = gameData.usesOf('oak_log', VERSION, { cap: 10 });
  assert.deepStrictEqual(a.uses.map((u) => u.output), b.uses.map((u) => u.output));
  const serialized = JSON.stringify(a);
  assert.ok(!/milestone|curriculum|progression|nextStep|craftAs/i.test(serialized), 'no progression metadata in uses results');
});

test('lookup_uses reports unknown items', () => {
  const out = gameData.usesOf('not_a_real_item', VERSION);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'unknown_item');
});

// --- search_game_data ----------------------------------------------------

test('search_game_data returns canonical item/block names', () => {
  const out = gameData.searchGameData('wood pick', VERSION);
  assert.strictEqual(out.ok, true);
  assert.ok(out.matches.length >= 1);
  assert.strictEqual(out.matches[0].name, 'wooden_pickaxe');
  assert.strictEqual(out.matches[0].type, 'item');
  for (const m of out.matches) {
    assert.ok(['item', 'block'].includes(m.type));
    assert.match(m.name, /^[a-z0-9_]+$/, 'canonical snake_case names only');
  }
});

test('search_game_data is bounded and finds blocks too', () => {
  const out = gameData.searchGameData('crafting table', VERSION, { cap: 3 });
  assert.strictEqual(out.matches.length <= 3, true);
  assert.ok(out.matches.some((m) => m.name === 'crafting_table'));
  const empty = gameData.searchGameData('   ', VERSION);
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.reason, 'empty_query');
});

// --- lookup_item / lookup_block -------------------------------------------

test('lookup_item handles known and unknown items', () => {
  const bread = gameData.itemInfo('bread', VERSION);
  assert.strictEqual(bread.ok, true);
  assert.strictEqual(bread.stackSize, 64);
  assert.ok(bread.food && bread.food.foodPoints > 0, 'food facts come from data');
  const tool = gameData.itemInfo('wooden_pickaxe', VERSION);
  assert.strictEqual(tool.maxDurability, 59);
  const unknown = gameData.itemInfo('no_such_item', VERSION);
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.reason, 'unknown_item');
});

test('lookup_block handles known and unknown blocks', () => {
  const stone = gameData.blockInfo('stone', VERSION);
  assert.strictEqual(stone.ok, true);
  assert.strictEqual(stone.hardness, 1.5);
  assert.strictEqual(stone.diggable, true);
  assert.ok(Array.isArray(stone.drops) && stone.drops.includes('cobblestone'));
  assert.ok(Array.isArray(stone.harvestTools) && stone.harvestTools.some((t) => t.endsWith('_pickaxe')));
  const unknown = gameData.blockInfo('no_such_block', VERSION);
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.reason, 'unknown_block');
});

// --- knowledge primitive validation + execution --------------------------

const KNOWLEDGE_PRIMITIVES = ['lookup_recipe', 'lookup_uses', 'search_game_data', 'lookup_item', 'lookup_block', 'lookup_minecraft_reference'];

test('all knowledge primitives are registered and schema-backed', () => {
  const names = listPrimitives().map((p) => p.name);
  for (const k of KNOWLEDGE_PRIMITIVES) {
    assert.ok(names.includes(k), `missing knowledge primitive ${k}`);
    assert.ok(PRIMITIVE_SCHEMAS[k], `missing schema for ${k}`);
    // Arg names must all be safe (no url/path/code fields possible).
    for (const arg of Object.keys(PRIMITIVE_SCHEMAS[k])) {
      assert.match(arg, /^[a-z_]+$/);
      assert.ok(!/url|path|file|exec|code|command|shell|http/i.test(arg), `${k} arg ${arg} must not reference URLs/paths/code`);
    }
  }
});

test('knowledge primitive args pass through canonical validation', () => {
  assert.strictEqual(validatePrimitiveCall({ primitive: 'lookup_recipe', args: { item: 'wooden_pickaxe' } }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'lookup_uses', args: { item: 'oak_log' } }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'search_game_data', args: { query: 'wood pick' } }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'lookup_item', args: { item: 'bread' } }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'lookup_block', args: { block: 'stone' } }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'lookup_minecraft_reference', args: { query: 'how nether portals work' } }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'lookup_recipe', args: {} }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'lookup_recipe', args: { item: 'Not Valid!' } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'search_game_data', args: { query: '' } }).ok, false);
});

test('knowledge primitives accept no URL/path/code fields', () => {
  assert.strictEqual(validatePrimitiveCall({ primitive: 'lookup_recipe', args: { item: 'bread', url: 'http://evil.test' } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'lookup_recipe', args: { item: 'bread', path: '/etc/passwd' } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'lookup_recipe', args: { item: 'bread', code: 'process.exit()' } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'lookup_minecraft_reference', args: { query: 'x', url: 'http://evil.test' } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'lookup_minecraft_reference', args: { query: 'x', fetch: 'http://evil.test' } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'search_game_data', args: { query: 'x', file: '/etc/passwd' } }).ok, false);
});

test('knowledge primitive execution returns structured informational results', async () => {
  const recipe = await executePrimitive(null, { primitive: 'lookup_recipe', args: { item: 'crafting_table' } });
  assert.strictEqual(recipe.ok, true);
  assert.strictEqual(recipe.primitive, 'lookup_recipe');
  assert.strictEqual(recipe.item, 'crafting_table');
  assert.ok(recipe.variants.length >= 1);
  assert.strictEqual(recipe.variants[0].output, 'crafting_table');

  const uses = await executePrimitive(null, { primitive: 'lookup_uses', args: { item: 'oak_planks' } });
  assert.strictEqual(uses.ok, true);
  assert.ok(uses.uses.length >= 1);

  const search = await executePrimitive(null, { primitive: 'search_game_data', args: { query: 'furnace' } });
  assert.strictEqual(search.ok, true);
  assert.ok(search.matches.some((m) => m.name === 'furnace'));

  const unknown = await executePrimitive(null, { primitive: 'lookup_item', args: { item: 'not_real' } });
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.reason, 'unknown_item');
  assert.strictEqual(unknown.primitive, 'lookup_item');
});

test('knowledge primitives never need the bot (informational only)', async () => {
  // Passing null bot must not crash: these primitives read static data only.
  const res = await executePrimitive(null, { primitive: 'lookup_block', args: { block: 'stone' } });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.name, 'stone');
});
