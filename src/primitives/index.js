'use strict';

// Central trusted-primitive registry: validation + bounded dispatch. The LLM
// never touches Mineflayer directly — every model-controlled invocation goes
// through executePrimitive(), which validates first.

const { validatePrimitiveCall, PRIMITIVE_NAMES, PRIMITIVE_SCHEMAS } = require('../safety/primitiveValidator');
const movement = require('./movement');
const exploration = require('./exploration');
const perception = require('./perception');
const combat = require('./combat');
const mining = require('./mining');
const crafting = require('./crafting');
const inventory = require('./inventory');
const interaction = require('./interaction');
const survival = require('./survival');

const EXECUTORS = {
  move_near: (bot, args, ctx) => movement.moveNear(bot, args, ctx),
  move_near_entity: (bot, args, ctx) => movement.moveNearEntity(bot, args, ctx),
  move_away_from_entity: (bot, args, ctx) => movement.moveAwayFromEntity(bot, args, ctx),
  stop_movement: (bot) => movement.stopMovement(bot),
  explore: (bot, args, ctx) => exploration.explore(bot, args, ctx),
  jump_forward: (bot, args, ctx) => movement.jumpForward(bot, args, ctx),
  find_block: (bot, args) => perception.findBlock(bot, args),
  find_entity: (bot, args) => perception.findEntity(bot, args),
  equip_best_melee_weapon: (bot) => combat.equipBestMeleeWeapon(bot),
  attack_entity: (bot, args, ctx) => combat.attackEntity(bot, args, ctx),
  stop_attacking: (bot) => combat.stopAttacking(bot),
  equip_item: (bot, args) => inventory.equipItem(bot, args),
  inspect_inventory: (bot) => inventory.inspectInventory(bot),
  eat_best_food: (bot) => survival.eatBestFood(bot),
  sleep: (bot) => survival.sleepBot(bot),
  wait: (bot, args) => survival.waitPrimitive(bot, args),
  mine_block: (bot, args, ctx) => mining.mineBlock(bot, args, ctx),
  mine_block_type: (bot, args, ctx) => mining.mineBlockType(bot, args, ctx),
  craft_item: (bot, args) => crafting.craftItem(bot, args),
  place_block: (bot, args) => interaction.placeBlock(bot, args),
  use_item: (bot, args) => interaction.useItem(bot, args),
  chat: (bot, args) => interaction.chat(bot, args),
};

const DESCRIPTIONS = {
  move_near: 'Move to coordinates within range blocks.',
  move_near_entity: 'Approach an entity to within distance blocks.',
  move_away_from_entity: 'Flee away from an entity by distance blocks.',
  stop_movement: 'Cancel current pathfinding movement.',
  explore: 'Relocate to new ground. Use when local resources are absent/exhausted or requiresRelocation=true.',
  jump_forward: 'Briefly jump forward to recover from simple stalls. No pathfinding; bounded and self-releasing.',
  find_block: 'Locate nearest block of a type within radius.',
  find_entity: 'List nearby entities, optionally filtered.',
  equip_best_melee_weapon: 'Equip the strongest available melee weapon.',
  attack_entity: 'Attack an entity with bounded duration. entityId MUST be copied from a currently observed entity.',
  stop_attacking: 'Stop combat.',
  equip_item: 'Equip a named inventory item to the destination slot.',
  inspect_inventory: 'Return bounded inventory summary.',
  eat_best_food: 'Eat the best available food.',
  sleep: 'Sleep in a nearby bed.',
  wait: 'Wait 1-10 seconds.',
  mine_block: 'Dig the block at exact coordinates from the CURRENT observation, never from stale memory.',
  mine_block_type: 'Acquire matching blocks LOCALLY. Beyond-range candidates are deferred; if requiresRelocation=true, explore instead of retrying.',
  craft_item: 'Craft count of an item using nearby table if needed.',
  place_block: 'Place an inventory block against a reference block.',
  use_item: 'Activate (right-click) the held or named item.',
  chat: 'Send a short chat message.',
};

function getTimeoutMs(ctx, fallback) {
  const v = Number(ctx?.timeoutMs ?? process.env.PRIMITIVE_TIMEOUT_MS ?? fallback);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(1000, Math.min(120000, v));
}

function listPrimitives() {
  return PRIMITIVE_NAMES.map((name) => ({
    name,
    description: DESCRIPTIONS[name] || '',
    args: Object.keys(PRIMITIVE_SCHEMAS[name] || {}),
  }));
}

async function executePrimitive(bot, call, ctx = {}) {
  const check = validatePrimitiveCall(call);
  if (!check.ok) {
    return { ok: false, error: check.error };
  }
  const { primitive, args } = check.value;
  const executor = EXECUTORS[primitive];
  if (!executor) {
    return { ok: false, primitive, error: `No executor for primitive: ${primitive}` };
  }
  const timeoutMs = getTimeoutMs(ctx, 30000);
  const execCtx = { ...ctx, timeoutMs };
  // Optional interrupt hook: ctx.shouldAbort() consulted by long executors.
  try {
    const result = await executor(bot, args, execCtx);
    if (!result || typeof result !== 'object') {
      return { ok: false, primitive, error: 'Primitive returned no result' };
    }
    if (!result.primitive) result.primitive = primitive;
    return result;
  } catch (err) {
    return { ok: false, primitive, error: err?.message || 'Primitive crashed' };
  }
}

module.exports = { listPrimitives, executePrimitive, EXECUTORS, PRIMITIVE_NAMES };
