'use strict';

// Richer bounded perception for the autonomous agent.
//
// Everything returned is plain JSON (no Mineflayer objects). Expensive block
// scanning is throttled and cached; callers may pass a `cache` object that
// persists across ticks and a `worldMemory` (with list()) for nearby known
// locations.

const HOSTILE_TYPES = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'slime', 'husk', 'drowned', 'pillager', 'vindicator', 'evoker',
  'phantom', 'blaze', 'ghast', 'magma_cube', 'piglin_brute', 'hoglin',
  'zoglin', 'warden', 'silverfish', 'endermite', 'stray', 'bogged',
]);

const INTERESTING_MATCHERS = [
  { category: 'log', test: (n) => typeof n === 'string' && n.endsWith('_log') },
  { category: 'crafting_table', test: (n) => n === 'crafting_table' },
  { category: 'furnace', test: (n) => n === 'furnace' || n === 'blast_furnace' || n === 'smoker' },
  { category: 'bed', test: (n) => typeof n === 'string' && n.endsWith('_bed') },
  { category: 'chest', test: (n) => n === 'chest' || n === 'trapped_chest' || n === 'barrel' || n === 'ender_chest' },
  { category: 'coal_ore', test: (n) => n === 'coal_ore' || n === 'deepslate_coal_ore' },
  { category: 'iron_ore', test: (n) => n === 'iron_ore' || n === 'deepslate_iron_ore' || n === 'raw_iron_block' },
  { category: 'diamond_ore', test: (n) => n === 'diamond_ore' || n === 'deepslate_diamond_ore' },
  { category: 'gold_ore', test: (n) => typeof n === 'string' && (n === 'gold_ore' || n === 'deepslate_gold_ore' || n === 'nether_gold_ore') },
  { category: 'water', test: (n) => n === 'water' },
  { category: 'lava', test: (n) => n === 'lava' },
];

function round1(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10) / 10;
}

function getEnvInt(name, fallback, min, max) {
  const v = parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function dist3(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function timeCategory(timeOfDay) {
  const t = Number(timeOfDay);
  if (!Number.isFinite(t)) return 'unknown';
  const tt = ((t % 24000) + 24000) % 24000;
  if (tt >= 12500 && tt <= 23500) return 'night';
  if (tt >= 0 && tt < 1000) return 'sunrise';
  if (tt >= 11000 && tt < 12500) return 'sunset';
  return 'day';
}

function safePosition(bot) {
  const pos = bot.entity?.position;
  if (pos && Number.isFinite(pos.x)) {
    return { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z) };
  }
  return { x: 0, y: 0, z: 0 };
}

function summarizeInventory(bot, maxEntries = 40) {
  const inventory = {};
  try {
    for (const item of bot.inventory.items()) {
      if (!item || !item.name) continue;
      inventory[item.name] = (inventory[item.name] || 0) + item.count;
    }
  } catch {
    // Inventory not ready.
  }
  const keys = Object.keys(inventory);
  const bounded = {};
  for (const k of keys.slice(0, maxEntries)) bounded[k] = inventory[k];
  return bounded;
}

function summarizeEquipment(bot) {
  const equipment = { mainHand: null, offHand: null, head: null, chest: null, legs: null, feet: null };
  let mainHandDurability = null;
  try {
    const slots = bot.inventory?.slots;
    // Mineflayer armor slots: 5=helmet 6=chestplate 7=leggings 8=boots (version dependent).
    const armorIdx = { head: 5, chest: 6, legs: 7, feet: 8 };
    if (Array.isArray(slots)) {
      for (const [slot, idx] of Object.entries(armorIdx)) {
        const item = slots[idx];
        if (item && item.name) equipment[slot] = item.name;
      }
    }
    const held = bot.heldItem || (typeof bot.getEquipmentDestSlot === 'function' ? null : null);
    if (bot.heldItem && bot.heldItem.name) {
      equipment.mainHand = bot.heldItem.name;
      if (typeof bot.heldItem.durabilityUsed === 'number' && typeof bot.heldItem.maxDurability === 'number') {
        mainHandDurability = {
          used: bot.heldItem.durabilityUsed,
          max: bot.heldItem.maxDurability,
          remaining: bot.heldItem.maxDurability - bot.heldItem.durabilityUsed,
        };
      } else if (typeof bot.heldItem.durabilityUsed === 'number') {
        mainHandDurability = { used: bot.heldItem.durabilityUsed };
      }
    } else if (bot.inventory?.heldItem && bot.inventory.heldItem.name) {
      equipment.mainHand = bot.inventory.heldItem.name;
    }
    // Off-hand slot 45 on most versions.
    if (Array.isArray(slots) && slots[45] && slots[45].name) {
      equipment.offHand = slots[45].name;
    }
    void held;
  } catch {
    // Equipment not ready.
  }
  return { equipment, mainHandDurability };
}

function summarizeEntities(bot, pos, radius, maxEntities) {
  const nearbyEntities = [];
  try {
    const entities = Object.values(bot.entities || {}).filter((e) => e !== bot.entity && e?.position && pos);
    for (const e of entities) {
      let d;
      if (typeof e.position.distanceTo === 'function' && bot.entity?.position) {
        try {
          d = e.position.distanceTo(bot.entity.position);
        } catch {
          d = dist3(e.position, pos);
        }
      } else {
        d = dist3(e.position, pos);
      }
      if (d <= radius) {
        const type = String(e.name || e.username || e.type || 'unknown');
        nearbyEntities.push({
          id: typeof e.id === 'number' ? e.id : -1,
          type,
          distance: round1(d),
          hostile: HOSTILE_TYPES.has(type.toLowerCase()),
        });
      }
    }
    nearbyEntities.sort((a, b) => a.distance - b.distance);
  } catch {
    // Entities not ready.
  }
  return nearbyEntities.slice(0, maxEntities);
}

function summarizeEnvironment(bot, timeOfDay) {
  let weather = 'clear';
  try {
    if (typeof bot.isRaining === 'boolean' && bot.isRaining) weather = 'rain';
    else if (typeof bot.weather === 'string' && bot.weather) weather = bot.weather;
    else if (bot.world?.weather) weather = String(bot.world.weather);
  } catch {
    weather = 'clear';
  }
  let lightLevel = null;
  try {
    const p = bot.entity?.position;
    if (p && bot.blockAt) {
      const b = bot.blockAt(p);
      if (b && typeof b.light === 'number') lightLevel = b.light;
      else if (b && typeof b.skyLight === 'number') lightLevel = b.skyLight;
    }
  } catch {
    lightLevel = null;
  }
  return {
    timeOfDay,
    timeCategory: timeCategory(timeOfDay),
    weather,
    lightLevel,
  };
}

function summarizeSelf(bot, pos) {
  let dimension = 'overworld';
  try {
    if (typeof bot.game?.dimension === 'string') dimension = bot.game.dimension;
    else if (typeof bot.dimension === 'string') dimension = bot.dimension;
  } catch {
    dimension = 'overworld';
  }
  let onFire = false;
  let underwater = false;
  let armor = 0;
  try {
    if (typeof bot.entity?.isBurning === 'boolean') onFire = bot.entity.isBurning;
    else if (typeof bot.entity?.fire === 'number') onFire = bot.entity.fire > 0;
  } catch {
    onFire = false;
  }
  try {
    if (typeof bot.entity?.isInWater === 'boolean') underwater = bot.entity.isInWater;
  } catch {
    underwater = false;
  }
  try {
    if (typeof bot.inventory?.armorPoints === 'number') armor = bot.inventory.armorPoints;
  } catch {
    armor = 0;
  }
  return {
    health: typeof bot.health === 'number' ? round1(bot.health) : 20,
    food: typeof bot.food === 'number' ? bot.food : 20,
    armor,
    position: pos,
    dimension,
    onFire,
    underwater,
  };
}

function scanInterestingBlocks(bot, pos, options, cache) {
  const maxBlocks = options.maxBlocks ?? getEnvInt('MAX_INTERESTING_BLOCKS', 30, 0, 60);
  if (maxBlocks <= 0) return [];
  const radius = Math.min(
    options.blockRadius ?? getEnvInt('MAX_BLOCK_SEARCH_DISTANCE', 64, 8, 128),
    48 // hard cap per scan for perf; detailed search uses find_block primitive
  );
  const throttleMs = options.throttleMs ?? getEnvInt('BLOCK_SCAN_THROTTLE_MS', 5000, 0, 60000);
  const now = Date.now();

  if (cache) {
    const last = cache.interestingBlocks;
    if (last && last.at && now - last.at < throttleMs && last.pos) {
      if (dist3(last.pos, pos) < 8) return last.blocks;
    }
  }

  const found = [];
  try {
    if (typeof bot.findBlocks !== 'function') return cache?.interestingBlocks?.blocks || [];
    const candidates = bot.findBlocks({
      matching: (block) => {
        if (!block || typeof block.name !== 'string') return false;
        return INTERESTING_MATCHERS.some((m) => m.test(block.name));
      },
      maxDistance: radius,
      count: Math.min(maxBlocks * 3, 120),
    });
    for (const p of candidates || []) {
      let block = null;
      try {
        block = bot.blockAt(p);
      } catch {
        block = null;
      }
      const name = block?.name || 'unknown';
      found.push({
        type: name,
        position: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
        distance: round1(dist3(p, pos)),
      });
      if (found.length >= maxBlocks) break;
    }
    found.sort((a, b) => a.distance - b.distance);
  } catch {
    return (cache && cache.interestingBlocks && cache.interestingBlocks.blocks) || [];
  }

  if (cache) {
    cache.interestingBlocks = { at: now, pos: { ...pos }, blocks: found.slice(0, maxBlocks) };
  }
  return found.slice(0, maxBlocks);
}

function summarizeKnownLocations(pos, worldMemory, maxCount = 8) {
  try {
    if (!worldMemory || typeof worldMemory.list !== 'function') return [];
    const all = worldMemory.list();
    const arr = Array.isArray(all) ? all : Object.entries(all || {}).map(([name, loc]) => ({ name, ...(loc || {}) }));
    const out = [];
    for (const entry of arr) {
      if (!entry || typeof entry.name !== 'string') continue;
      const lp = entry.position || entry;
      if (!Number.isFinite(lp?.x)) continue;
      out.push({ name: entry.name, distance: round1(dist3(lp, pos)) });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out.slice(0, maxCount);
  } catch {
    return [];
  }
}

// Full perception snapshot. Legacy top-level fields (health, food, position,
// timeOfDay, inventory, nearbyEntities) are preserved for benchmark compat.
function observe(bot, options = {}) {
  const radius = options.radius ?? getEnvInt('OBSERVATION_RADIUS', 24, 2, 64);
  const maxEntities = options.maxEntities ?? getEnvInt('MAX_NEARBY_ENTITIES', 20, 1, 50);

  const pos = safePosition(bot);
  const inventory = summarizeInventory(bot);
  const nearbyEntities = summarizeEntities(bot, pos, radius, maxEntities);

  let timeOfDay = 0;
  try {
    timeOfDay = typeof bot.time?.timeOfDay === 'number' ? bot.time.timeOfDay : 0;
  } catch {
    timeOfDay = 0;
  }

  const { equipment, mainHandDurability } = summarizeEquipment(bot);
  const self = summarizeSelf(bot, pos);
  const environment = summarizeEnvironment(bot, timeOfDay);
  const interestingBlocks = scanInterestingBlocks(bot, pos, options, options.cache);
  const knownLocationsNearby = summarizeKnownLocations(pos, options.worldMemory);

  const perception = {
    // Legacy flat fields (benchmark + old tests compat).
    health: self.health,
    food: self.food,
    position: pos,
    timeOfDay,
    inventory,
    nearbyEntities: nearbyEntities.map((e) => ({ name: e.type, distance: e.distance, id: e.id })),
    // Rich autonomous fields.
    self,
    equipment,
    mainHandDurability,
    environment,
    nearbyEntitiesDetailed: nearbyEntities,
    interestingBlocks,
    knownLocationsNearby,
    observedAt: new Date().toISOString(),
  };
  return perception;
}

module.exports = {
  observe,
  observeBot: observe,
  timeCategory,
  HOSTILE_TYPES,
  INTERESTING_MATCHERS,
};
