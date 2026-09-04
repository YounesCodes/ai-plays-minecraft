'use strict';

// Read-only perception primitives: bounded search, structured results.

const { HOSTILE_TYPES } = require('../bot/observations');
const { matchBlockName } = require('../blocks');
const targetFailures = require('../navigation/targetFailures');

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function distTo(bot, pos) {
  const me = bot.entity?.position;
  if (!me || !pos) return null;
  const dx = pos.x - me.x;
  const dy = pos.y - me.y;
  const dz = pos.z - me.z;
  return round1(Math.sqrt(dx * dx + dy * dy + dz * dz));
}

async function findBlock(bot, args) {
  const radius = Math.max(1, Math.min(128, Number(args.radius ?? 32) || 32));
  const fail = (reason, extra = {}) => ({
    ok: false, primitive: 'find_block', reason,
    blockType: args.blockType, searchRadius: radius,
    error: extra.error || `No ${args.blockType} within ${radius} blocks`,
    ...extra,
  });
  try {
    if (typeof bot.findBlock !== 'function' && typeof bot.findBlocks !== 'function') {
      return { ok: false, primitive: 'find_block', error: 'Block search unavailable' };
    }
    const match = matchBlockName(args.blockType);
    let candidates = [];
    try {
      if (typeof bot.findBlocks === 'function') {
        const found = bot.findBlocks({ matching: match, maxDistance: radius, count: 12 });
        if (Array.isArray(found)) candidates = found.filter(Boolean);
      }
    } catch {
      // fall through to singular search
    }
    if (candidates.length === 0) {
      try {
        const one = bot.findBlock({ matching: match, maxDistance: radius });
        if (one) candidates = [one];
      } catch {
        // ignore
      }
    }
    if (candidates.length === 0) {
      return fail('resource_not_seen', { candidatesSeen: 0, candidatesSkipped: 0 });
    }
    const me = bot?.entity?.position || null;
    const dimension = targetFailures.botDimension(bot);
    let skipped = 0;
    for (const block of candidates) {
      if (!block || !block.position) continue;
      if (targetFailures.isExcluded({
        dimension, kind: 'block', target: args.blockType,
        position: block.position, fromPosition: me,
      })) {
        skipped += 1;
        continue;
      }
      return {
        ok: true,
        primitive: 'find_block',
        blockType: block.name || args.blockType,
        position: { x: block.position.x, y: block.position.y, z: block.position.z },
        distance: distTo(bot, block.position),
      };
    }
    return fail('no_reachable_target', {
      candidatesSeen: candidates.length,
      candidatesSkipped: skipped,
      error: `Found ${candidates.length} ${args.blockType} but all unreachable from here (${skipped} skipped)`,
    });
  } catch (err) {
    return { ok: false, primitive: 'find_block', blockType: args.blockType, error: err?.message || 'Block search failed' };
  }
}

async function findEntity(bot, args = {}) {
  const radius = Math.max(1, Math.min(64, Number(args.radius ?? 24) || 24));
  const wanted = args.entityType ? String(args.entityType).toLowerCase() : null;
  const hostileOnly = args.hostileOnly === true;
  try {
    const me = bot.entity?.position;
    const out = [];
    for (const e of Object.values(bot.entities || {})) {
      if (e === bot.entity || !e?.position) continue;
      const type = String(e.name || e.username || e.type || 'unknown');
      if (wanted && type.toLowerCase() !== wanted) continue;
      const hostile = HOSTILE_TYPES.has(type.toLowerCase());
      if (hostileOnly && !hostile) continue;
      let d;
      try {
        d = (me && typeof e.position.distanceTo === 'function') ? e.position.distanceTo(me) : null;
      } catch {
        d = null;
      }
      if (d === null || d === undefined) {
        if (!me) continue;
        const dx = e.position.x - me.x;
        const dy = e.position.y - me.y;
        const dz = e.position.z - me.z;
        d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      if (d <= radius) {
        out.push({ id: typeof e.id === 'number' ? e.id : -1, type, distance: round1(d), hostile });
      }
    }
    out.sort((a, b) => a.distance - b.distance);
    if (out.length === 0) {
      return { ok: false, primitive: 'find_entity', error: wanted ? `No ${wanted} within ${radius} blocks` : `No entities within ${radius} blocks` };
    }
    return { ok: true, primitive: 'find_entity', entities: out.slice(0, 10), count: out.length };
  } catch (err) {
    return { ok: false, primitive: 'find_entity', error: err?.message || 'Entity search failed' };
  }
}

module.exports = { findBlock, findEntity };
