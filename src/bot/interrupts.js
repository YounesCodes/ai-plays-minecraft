'use strict';

// Deterministic interrupt detection. No LLM calls here — pure thresholds over
// bounded perception so the cognition loop can preempt long-running skills.

function intEnv(name, fallback) {
  const v = parseFloat(process.env[name] || '');
  if (!Number.isFinite(v)) return fallback;
  return v;
}

function getInterruptThresholds() {
  return {
    criticalHealth: intEnv('INTERRUPT_CRITICAL_HEALTH', 8),
    lowHealth: intEnv('INTERRUPT_LOW_HEALTH', 12),
    criticalFood: intEnv('INTERRUPT_CRITICAL_FOOD', 6),
    hostileVeryClose: intEnv('INTERRUPT_HOSTILE_VERY_CLOSE', 5),
    hostileClose: intEnv('INTERRUPT_HOSTILE_CLOSE', 10),
  };
}

function selfOf(perception) {
  return perception?.self || {
    health: perception?.health ?? 20,
    food: perception?.food ?? 20,
    onFire: false,
    underwater: false,
  };
}

function entitiesOf(perception) {
  return perception?.nearbyEntitiesDetailed || perception?.nearbyEntities || [];
}

function entityType(e) {
  return String(e?.type || e?.name || 'unknown');
}

function entityDistance(e) {
  return Number(e?.distance ?? Infinity);
}

// Returns interrupts sorted by descending priority. Empty = nothing urgent.
function detectInterrupts(perception, event = {}, thresholds = getInterruptThresholds()) {
  const interrupts = [];
  if (!perception) return interrupts;

  const self = selfOf(perception);
  const entities = entitiesOf(perception);

  if (event.death || self.health <= 0) {
    interrupts.push({ type: 'death', priority: 100, reason: 'Bot is dead; awaiting respawn' });
    return interrupts.sort((a, b) => b.priority - a.priority);
  }

  if (self.onFire) {
    interrupts.push({ type: 'on_fire', priority: 96, reason: 'Bot is on fire' });
  }

  if (Number.isFinite(self.health) && self.health <= thresholds.criticalHealth) {
    interrupts.push({ type: 'critical_health', priority: 95, health: self.health, reason: `Health critical (${self.health})` });
  }

  if (Number.isFinite(self.food) && self.food <= thresholds.criticalFood) {
    interrupts.push({ type: 'critical_hunger', priority: 88, food: self.food, reason: `Food critical (${self.food})` });
  }

  if (event.damageTaken && event.damageTaken >= 6) {
    interrupts.push({ type: 'unexpected_damage', priority: 90, damage: event.damageTaken, reason: `Took ${event.damageTaken} damage` });
  }

  // Hostile proximity.
  let nearestHostile = null;
  for (const e of entities) {
    const hostile = e?.hostile === true || isHostileName(entityType(e));
    if (!hostile) continue;
    const d = entityDistance(e);
    if (!nearestHostile || d < entityDistance(nearestHostile)) nearestHostile = e;
  }
  if (nearestHostile) {
    const d = entityDistance(nearestHostile);
    const source = entityType(nearestHostile);
    if (d <= thresholds.hostileVeryClose) {
      interrupts.push({
        type: 'immediate_threat', priority: 94, source,
        entityId: nearestHostile.id ?? null, distance: d,
        reason: `${source} extremely close (${d})`,
      });
    } else if (d <= thresholds.hostileClose) {
      interrupts.push({
        type: 'hostile_nearby', priority: 70, source,
        entityId: nearestHostile.id ?? null, distance: d,
        reason: `${source} nearby (${d})`,
      });
    }
  }

  if (event.toolBroke) {
    interrupts.push({ type: 'tool_broke', priority: 60, reason: 'Tool broke' });
  }
  if (event.pathfindingFailedRepeatedly) {
    interrupts.push({ type: 'pathfinding_failed', priority: 55, reason: 'Repeated pathfinding failure' });
  }
  if (event.inventoryFull) {
    interrupts.push({ type: 'inventory_full', priority: 40, reason: 'Inventory full' });
  }
  if (event.targetDisappeared) {
    interrupts.push({ type: 'target_disappeared', priority: 45, reason: 'Target disappeared' });
  }

  if (Number.isFinite(self.health) && self.health <= thresholds.lowHealth && !interrupts.some((i) => i.type === 'critical_health')) {
    interrupts.push({ type: 'low_health', priority: 65, health: self.health, reason: `Health low (${self.health})` });
  }

  return interrupts.sort((a, b) => b.priority - a.priority);
}

const HOSTILE_FALLBACK = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'slime', 'husk', 'drowned', 'pillager', 'phantom', 'blaze',
]);

function isHostileName(name) {
  return HOSTILE_FALLBACK.has(String(name || '').toLowerCase());
}

function isUrgent(interrupt) {
  return !!interrupt && Number(interrupt.priority) >= 85;
}

module.exports = { detectInterrupts, getInterruptThresholds, isUrgent };
