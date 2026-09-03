'use strict';

// Inventory primitives: equip a specific item, or get a bounded summary.

async function equipItem(bot, args) {
  try {
    let item = null;
    try {
      const items = bot.inventory.items() || [];
      item = items.find((i) => i && i.name === args.item) || null;
    } catch {
      item = null;
    }
    if (!item) {
      return { ok: false, primitive: 'equip_item', item: args.item, error: `${args.item} not in inventory` };
    }
    if (typeof bot.equip === 'function') {
      await bot.equip(item, args.destination || 'hand');
    }
    return { ok: true, primitive: 'equip_item', item: args.item, destination: args.destination || 'hand' };
  } catch (err) {
    return { ok: false, primitive: 'equip_item', item: args.item, error: err?.message || 'Equip failed' };
  }
}

async function inspectInventory(bot) {
  try {
    const items = {};
    const tools = [];
    const armor = { head: null, chest: null, legs: null, feet: null };
    try {
      for (const item of bot.inventory.items()) {
        if (!item || !item.name) continue;
        items[item.name] = (items[item.name] || 0) + item.count;
        if (typeof item.name === 'string' && (item.name.endsWith('_sword') || item.name.endsWith('_axe') || item.name.endsWith('_pickaxe') || item.name.endsWith('_shovel'))) {
          tools.push({ name: item.name, count: item.count });
        }
      }
    } catch {
      // inventory not ready
    }
    try {
      const slots = bot.inventory?.slots;
      if (Array.isArray(slots)) {
        const idx = { head: 5, chest: 6, legs: 7, feet: 8 };
        for (const [slot, i] of Object.entries(idx)) {
          if (slots[i]?.name) armor[slot] = slots[i].name;
        }
      }
    } catch {
      // ignore
    }
    let mainHand = null;
    try {
      if (bot.heldItem?.name) mainHand = bot.heldItem.name;
    } catch {
      mainHand = null;
    }
    return { ok: true, primitive: 'inspect_inventory', items, tools: tools.slice(0, 20), armor, mainHand };
  } catch (err) {
    return { ok: false, primitive: 'inspect_inventory', error: err?.message || 'Inspect failed' };
  }
}

module.exports = { equipItem, inspectInventory };
