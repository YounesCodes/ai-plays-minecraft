'use strict';

// Interaction primitives: place blocks, use/activate items, chat.

const FACE_VECTORS = {
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
};

async function placeBlock(bot, args) {
  try {
    let item = null;
    try {
      const items = bot.inventory.items() || [];
      item = items.find((i) => i && i.name === args.item) || null;
    } catch {
      item = null;
    }
    if (!item) {
      return { ok: false, primitive: 'place_block', item: args.item, error: `${args.item} not in inventory` };
    }
    if (typeof bot.blockAt !== 'function' || typeof bot.placeBlock !== 'function') {
      return { ok: false, primitive: 'place_block', item: args.item, error: 'Block placement unavailable' };
    }
    const refPos = { x: Math.floor(args.x), y: Math.floor(args.y), z: Math.floor(args.z) };
    const refBlock = bot.blockAt(refPos);
    if (!refBlock) {
      return { ok: false, primitive: 'place_block', item: args.item, error: `No reference block at ${refPos.x},${refPos.y},${refPos.z}` };
    }
    const face = FACE_VECTORS[args.face || 'top'] || FACE_VECTORS.top;
    try {
      if (typeof bot.equip === 'function') {
        try { await bot.equip(item, 'hand'); } catch { /* best effort */ }
      }
      await bot.placeBlock(refBlock, face);
      return { ok: true, primitive: 'place_block', item: args.item, position: refPos };
    } catch (err) {
      return { ok: false, primitive: 'place_block', item: args.item, error: err?.message || 'Placement failed' };
    }
  } catch (err) {
    return { ok: false, primitive: 'place_block', item: args.item, error: err?.message || 'Placement failed' };
  }
}

async function useItem(bot, args = {}) {
  try {
    if (args.item) {
      try {
        const items = bot.inventory.items() || [];
        const item = items.find((i) => i && i.name === args.item);
        if (!item) {
          return { ok: false, primitive: 'use_item', error: `${args.item} not in inventory` };
        }
        if (typeof bot.equip === 'function') {
          try { await bot.equip(item, 'hand'); } catch { /* best effort */ }
        }
      } catch {
        return { ok: false, primitive: 'use_item', error: `${args.item} not in inventory` };
      }
    }
    if (typeof bot.activateItem !== 'function') {
      return { ok: false, primitive: 'use_item', error: 'Item use unavailable' };
    }
    await bot.activateItem();
    return { ok: true, primitive: 'use_item', item: args.item || null };
  } catch (err) {
    return { ok: false, primitive: 'use_item', error: err?.message || 'Item use failed' };
  }
}

async function chat(bot, args) {
  const message = String(args.message || '').trim().slice(0, 140);
  if (!message) {
    return { ok: false, primitive: 'chat', error: 'message must be non-empty' };
  }
  try {
    if (typeof bot.chat !== 'function') {
      return { ok: false, primitive: 'chat', error: 'Chat unavailable' };
    }
    bot.chat(message);
    return { ok: true, primitive: 'chat', sent: message };
  } catch (err) {
    return { ok: false, primitive: 'chat', error: err?.message || 'Chat failed' };
  }
}

module.exports = { placeBlock, useItem, chat };
