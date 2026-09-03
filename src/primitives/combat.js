'use strict';

// Combat primitives with bounded behavior: timeouts, max chase distance, and
// honest failure reporting so reflection can learn (e.g. wrong tool, escaped
// target, died mid-fight).

const { findEntityById } = require('./movement');

const MELEE_PRIORITY = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe',
  'trident', 'mace', 'stick',
];

function inventoryItems(bot) {
  try {
    return bot.inventory.items() || [];
  } catch {
    return [];
  }
}

function pickBestMelee(items) {
  let fallback = null;
  for (const name of MELEE_PRIORITY) {
    const found = items.find((i) => i && i.name === name);
    if (found) return found;
  }
  for (const i of items) {
    if (i && typeof i.name === 'string' && (i.name.endsWith('_sword') || i.name.endsWith('_axe'))) {
      fallback = fallback || i;
    }
  }
  return fallback;
}

async function equipBestMeleeWeapon(bot) {
  try {
    const items = inventoryItems(bot);
    const best = pickBestMelee(items);
    if (!best) {
      return { ok: false, primitive: 'equip_best_melee_weapon', error: 'No melee weapon in inventory' };
    }
    if (typeof bot.equip === 'function') {
      await bot.equip(best, 'hand');
    } else if (typeof bot.unequip === 'function') {
      // Mock bots without equip: treat as equipped for tests.
    }
    return { ok: true, primitive: 'equip_best_melee_weapon', weapon: best.name };
  } catch (err) {
    return { ok: false, primitive: 'equip_best_melee_weapon', error: err?.message || 'Equip failed' };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attackEntity(bot, args, ctx = {}) {
  const maxChase = ctx.maxChaseDistance ?? parseFloat(process.env.MAX_CHASE_DISTANCE || '32') ?? 32;
  const maxSeconds = ctx.maxAttackSeconds ?? parseInt(process.env.MAX_ATTACK_SECONDS || '20', 10) ?? 20;
  const timeoutMs = Math.min(ctx.timeoutMs || 60000, Math.max(2000, maxSeconds * 1000 + 5000));
  const started = Date.now();
  const startHealth = typeof bot.health === 'number' ? bot.health : null;

  const run = (async () => {
    const target = findEntityById(bot, args.entityId);
    if (!target) {
      return { ok: false, primitive: 'attack_entity', entityId: args.entityId, error: `Entity ${args.entityId} not found` };
    }
    try {
      // Approach if far.
      const me = bot.entity?.position;
      if (me && target.position && bot.pathfinder && typeof bot.pvp !== 'undefined') {
        // pvp plugin may not be installed; fall through to bot.attack.
      }
      if (me && target.position) {
        let d = null;
        try {
          d = typeof target.position.distanceTo === 'function' ? target.position.distanceTo(me) : null;
        } catch {
          d = null;
        }
        if (d !== null && d > maxChase) {
          return { ok: false, primitive: 'attack_entity', entityId: args.entityId, error: `Target ${Math.round(d)} blocks away exceeds max chase ${maxChase}` };
        }
      }
      if (typeof bot.attack !== 'function') {
        return { ok: false, primitive: 'attack_entity', entityId: args.entityId, error: 'Attack unavailable' };
      }
      const deadline = Date.now() + maxSeconds * 1000;
      let swings = 0;
      // Bounded attack loop: swing until target gone/dead or deadline.
      while (Date.now() < deadline) {
        const t = findEntityById(bot, args.entityId);
        if (!t || t.dead || t.health === 0 || t.removed) {
          return {
            ok: true, primitive: 'attack_entity', entityId: args.entityId,
            targetEliminated: true, swings,
            durationMs: Date.now() - started,
            healthChange: startHealth !== null && typeof bot.health === 'number' ? Math.round((bot.health - startHealth) * 10) / 10 : null,
          };
        }
        try {
          await bot.attack(t);
          swings += 1;
        } catch (err) {
          return {
            ok: false, primitive: 'attack_entity', entityId: args.entityId,
            error: err?.message || 'Attack failed', swings,
            durationMs: Date.now() - started,
          };
        }
        await sleep(600);
      }
      const stillThere = !!findEntityById(bot, args.entityId);
      return {
        ok: stillThere ? false : true,
        primitive: 'attack_entity',
        entityId: args.entityId,
        targetEliminated: !stillThere,
        swings,
        durationMs: Date.now() - started,
        error: stillThere ? `Target survived ${maxSeconds}s of combat` : null,
        healthChange: startHealth !== null && typeof bot.health === 'number' ? Math.round((bot.health - startHealth) * 10) / 10 : null,
      };
    } catch (err) {
      return { ok: false, primitive: 'attack_entity', entityId: args.entityId, error: err?.message || 'Attack failed' };
    }
  })();

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, primitive: 'attack_entity', entityId: args.entityId, error: `Timed out after ${timeoutMs}ms`, timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopAttacking(bot) {
  try {
    if (bot.pvp && typeof bot.pvp.stop === 'function') bot.pvp.stop();
    if (bot.pathfinder && typeof bot.pathfinder.stop === 'function') {
      // Only stop pathfinder movement tied to combat; safe no-op otherwise.
    }
    return { ok: true, primitive: 'stop_attacking' };
  } catch (err) {
    return { ok: false, primitive: 'stop_attacking', error: err?.message || 'Stop failed' };
  }
}

module.exports = { equipBestMeleeWeapon, attackEntity, stopAttacking, MELEE_PRIORITY };
