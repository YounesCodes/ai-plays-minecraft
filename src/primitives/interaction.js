'use strict';

// Interaction primitives: place blocks, use/activate items, chat.

const { blockAtPos } = require('../blocks');
const { gotoWithStallWatch, goalNear, stopBotMotion } = require('./movement');

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
    const refBlock = blockAtPos(bot, refPos.x, refPos.y, refPos.z);
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

function abortedCheck(ctx) {
  try {
    if (ctx && typeof ctx.shouldAbort === 'function') return ctx.shouldAbort() || null;
  } catch {
    // ignore
  }
  return null;
}

function isReplaceableTarget(name) {
  // Conservative: only plain air counts as a free target cell. No water,
  // lava, grass or snow placement — ordinary stable surfaces only.
  return name === 'air';
}

function isSolidGround(name, block) {
  if (!name || name === 'air' || name === 'water' || name === 'lava') return false;
  try {
    if (block && block.boundingBox === 'empty') return false;
  } catch {
    // ignore; name check already passed
  }
  return true;
}

// Generic nearby placement: the BODY selects a real surface, the LLM never
// invents coordinates. Bounded candidate scan, bounded approaches, bounded
// attempts, post-place verification. Works for any ordinary placeable
// block (crafting tables, furnaces, chests, dirt, planks...).
async function placeBlockNearby(bot, args, ctx = {}) {
  const itemName = args.item;
  const fail = (error, extra = {}) => ({ ok: false, primitive: 'place_block_nearby', item: itemName, ...extra, error });
  let item = null;
  try {
    const items = (bot.inventory && bot.inventory.items && bot.inventory.items()) || [];
    item = items.find((i) => i && i.name === itemName) || null;
  } catch {
    item = null;
  }
  if (!item) return fail(`${itemName} not in inventory`, { reason: 'missing_item' });
  if (typeof bot.blockAt !== 'function' || typeof bot.placeBlock !== 'function') {
    return fail('Block placement unavailable');
  }
  const me = bot?.entity?.position;
  if (!me) return fail('Bot position unknown');
  const bx = Math.floor(me.x);
  const by = Math.floor(me.y);
  const bz = Math.floor(me.z);
  // Candidate reference surfaces in expanding rings (nearest first).
  const cands = [];
  for (let ring = 0; ring <= 3 && cands.length < 24; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        for (const dy of [0, -1, 1, -2]) {
          if (abortedCheck(ctx)) return { ...fail('Aborted before placement', { reason: 'aborted' }), aborted: true };
          const rx = bx + dx;
          const ry = by + dy;
          const rz = bz + dz;
          let ref = null;
          try {
            ref = blockAtPos(bot, rx, ry, rz);
          } catch {
            ref = null;
          }
          if (!ref || !isSolidGround(ref.name, ref)) continue;
          let top = null;
          try {
            top = blockAtPos(bot, rx, ry + 1, rz);
          } catch {
            top = null;
          }
          if (!top || !isReplaceableTarget(top.name)) continue;
          // Never place into the bot's own body column: Paper kicks an
          // "invalid move" when the new solid cell overlaps the player
          // AABB (proven live). Dest must clear a 0.9m footprint and headroom.
          const ccx = rx + 0.5;
          const ccz = rz + 0.5;
          if (Math.abs(ccx - me.x) < 0.9 && Math.abs(ccz - me.z) < 0.9 && ry + 1 < me.y + 2) continue;
          const ddx = rx - me.x;
          const ddy = ry - me.y;
          const ddz = rz - me.z;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
          if (dist > 6) continue; // body reach budget, not exploration
          cands.push({ rx, ry, rz, dist, dy });
        }
      }
    }
  }
  if (cands.length === 0) {
    return fail('No suitable nearby surface for placement', { reason: 'no_surface' });
  }
  cands.sort((a, b) => (a.dist - b.dist) || (Math.abs(a.dy) - Math.abs(b.dy)));
  const errors = [];
  for (const c of cands.slice(0, 4)) {
    if (abortedCheck(ctx)) return { ...fail('Aborted during placement', { reason: 'aborted' }), aborted: true };
    try {
      // Walk adjacent when needed (hardened stall-aware movement).
      const dx = c.rx - me.x;
      const dz = c.rz - me.z;
      if (dx * dx + dz * dz > 3.2 * 3.2) {
        const goal = goalNear(c.rx, c.ry + 1, c.rz, 2);
        if (goal) {
          const res = await gotoWithStallWatch(bot, goal, { timeoutMs: 12000, primitive: 'place_block_nearby', ctx });
          if (res.outcome !== 'reached') {
            errors.push(`${c.rx},${c.ry},${c.rz}:approach-${res.outcome}`);
            continue;
          }
        }
      }
      try {
        if (typeof bot.equip === 'function') await bot.equip(item, 'hand');
      } catch {
        // best effort
      }
      const refBlock = blockAtPos(bot, c.rx, c.ry, c.rz);
      if (!refBlock) {
        errors.push(`${c.rx},${c.ry},${c.rz}:surface-gone`);
        continue;
      }
      const { Vec3 } = require('vec3');
      await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
      // Verify: target cell must now hold a solid block.
      let placed = null;
      try {
        placed = blockAtPos(bot, c.rx, c.ry + 1, c.rz);
      } catch {
        placed = null;
      }
      if (placed && isSolidGround(placed.name, placed)) {
        return {
          ok: true, primitive: 'place_block_nearby', item: itemName,
          position: { x: c.rx, y: c.ry + 1, z: c.rz },
          placedBlock: placed.name,
        };
      }
      errors.push(`${c.rx},${c.ry},${c.rz}:verify-failed`);
    } catch (err) {
      errors.push(`${c.rx},${c.ry},${c.rz}:${(err?.message || 'place-failed').slice(0, 60)}`);
    } finally {
      try { stopBotMotion(bot); } catch { /* ignore */ }
    }
  }
  return fail(`Placement failed (${errors.slice(0, 3).join('; ') || 'no attempt'})`, { reason: 'placement_failed' });
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

module.exports = { placeBlock, placeBlockNearby, useItem, chat };
