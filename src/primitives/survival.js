'use strict';

// Survival primitives: eat, sleep, wait. Bounded and honest about failures.

const FOOD_PRIORITY = [
  'golden_apple', 'enchanted_golden_apple', 'cooked_porkchop', 'steak',
  'cooked_beef', 'cooked_chicken', 'cooked_mutton', 'cooked_salmon',
  'baked_potato', 'bread', 'carrot', 'apple', 'melon_slice', 'cookie',
  'cooked_cod', 'pumpkin_pie', 'mushroom_stew', 'beetroot_soup', 'rabbit_stew',
  'suspicious_stew', 'potato', 'beetroot', 'dried_kelp', 'sweet_berries',
  'glow_berries', 'raw_beef', 'raw_porkchop', 'raw_chicken', 'raw_mutton',
  'raw_salmon', 'raw_cod', 'rotten_flesh', 'spider_eye', 'poisonous_potato',
];

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eatBestFood(bot) {
  const before = typeof bot.food === 'number' ? bot.food : null;
  try {
    let items = [];
    try {
      items = bot.inventory.items() || [];
    } catch {
      items = [];
    }
    let chosen = null;
    for (const name of FOOD_PRIORITY) {
      const found = items.find((i) => i && i.name === name);
      if (found) { chosen = found; break; }
    }
    if (!chosen) {
      // Any edible-looking fallback.
      chosen = items.find((i) => i && typeof i.name === 'string' && (
        i.name.includes('bread') || i.name.includes('apple') || i.name.includes('carrot') ||
        i.name.includes('potato') || i.name.includes('beef') || i.name.includes('pork') ||
        i.name.includes('chicken') || i.name.includes('fish') || i.name.includes('berry') ||
        i.name.includes('melon') || i.name.includes('cookie') || i.name.includes('stew') ||
        i.name.includes('soup') || i.name.includes('pie')
      )) || null;
    }
    if (!chosen) {
      return { ok: false, primitive: 'eat_best_food', error: 'No food in inventory' };
    }
    if (typeof bot.consume !== 'function') {
      return { ok: false, primitive: 'eat_best_food', error: 'Eating unavailable' };
    }
    try {
      if (typeof bot.equip === 'function') {
        try { await bot.equip(chosen, 'hand'); } catch { /* best effort */ }
      }
      await bot.consume();
      const after = typeof bot.food === 'number' ? bot.food : null;
      return {
        ok: true, primitive: 'eat_best_food', food: chosen.name,
        foodBefore: before, foodAfter: after,
      };
    } catch (err) {
      return { ok: false, primitive: 'eat_best_food', food: chosen.name, error: err?.message || 'Eating failed' };
    }
  } catch (err) {
    return { ok: false, primitive: 'eat_best_food', error: err?.message || 'Eating failed' };
  }
}

async function sleepBot(bot) {
  try {
    if (typeof bot.findBlock !== 'function' || typeof bot.sleep !== 'function') {
      return { ok: false, primitive: 'sleep', error: 'Sleep unavailable' };
    }
    const bed = bot.findBlock({ matching: (b) => b && typeof b.name === 'string' && b.name.endsWith('_bed'), maxDistance: 8 });
    if (!bed) {
      return { ok: false, primitive: 'sleep', error: 'No bed within 8 blocks' };
    }
    try {
      await bot.sleep(bed);
      return { ok: true, primitive: 'sleep', slept: true };
    } catch (err) {
      return { ok: false, primitive: 'sleep', error: err?.message || 'Sleep failed' };
    }
  } catch (err) {
    return { ok: false, primitive: 'sleep', error: err?.message || 'Sleep failed' };
  }
}

async function wait(bot, args) {
  const seconds = Math.max(1, Math.min(10, parseInt(args.seconds, 10) || 1));
  await sleepMs(seconds * 1000);
  return { ok: true, primitive: 'wait', waited: seconds };
}

module.exports = { eatBestFood, sleepBot, waitPrimitive: wait, FOOD_PRIORITY };
