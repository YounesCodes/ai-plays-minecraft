'use strict';

// Runtime navigation memory: which targets proved unreachable, and from
// where. Used by autonomous resource search (find_block, mine_block_type)
// so a failed target is skipped in favor of alternates instead of retried
// every turn.
//
// This is deliberately NOT semantic memory: entries are never persisted,
// never sent to the LLM (only counts flow outward via structured results),
// expire by TTL, and heal by distance — a failure observed from one pocket
// must not blacklist a block forever. Respawn clears the cache; a fresh
// body in a fresh place gets fresh eyes.

const MAX_ENTRIES = 500;
const TTL_MS = 15 * 60 * 1000;
const RELEVANCE_RADIUS = 12;
// A stale navigation failure must not exclude a BLOCK the bot can now
// directly reach. Conservative interaction distance, consistent with the
// benchmark skip-healing (<4 blocks) and inside the mining dig reach (5).
// Generic: applies to any block kind/target, not just logs.
const ADJACENCY_HEAL_DISTANCE = 4;

const store = new Map(); // key -> record (insertion-ordered for FIFO prune)

function keyFor({ dimension = 'overworld', kind, target, position }) {
  const p = position || {};
  const x = Math.round(Number(p.x) || 0);
  const y = Math.round(Number(p.y) || 0);
  const z = Math.round(Number(p.z) || 0);
  return `${dimension}|${kind}|${target}|${x},${y},${z}`;
}

function prune(now = Date.now()) {
  for (const [key, rec] of store) {
    if (now - rec.lastFailureAt > TTL_MS) store.delete(key);
  }
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

function recordFailure({ dimension = 'overworld', kind, target, position, reason, attemptedFrom, now = Date.now() }) {
  if (!kind || !target || !position) return null;
  prune(now);
  const key = keyFor({ dimension, kind, target, position });
  const prev = store.get(key);
  const rec = {
    dimension,
    kind,
    target,
    position: { x: position.x, y: position.y, z: position.z },
    reason: reason || 'unreachable',
    failureCount: (prev ? prev.failureCount : 0) + 1,
    attemptedFrom: attemptedFrom ? { x: attemptedFrom.x, y: attemptedFrom.y, z: attemptedFrom.z } : null,
    firstFailureAt: prev ? prev.firstFailureAt : now,
    lastFailureAt: now,
  };
  store.delete(key); // re-insert to refresh FIFO position
  store.set(key, rec);
  prune(now);
  return { ...rec };
}

// True when the target should currently be skipped from `fromPosition`:
// the entry is fresh AND the bot is still near where the failure happened.
// Moving substantially elsewhere (or TTL expiry) makes it eligible again.
function isExcluded({ dimension = 'overworld', kind, target, position, fromPosition, now = Date.now() }) {
  if (!kind || !target || !position) return null;
  const key = keyFor({ dimension, kind, target, position });
  const rec = store.get(key);
  if (!rec) return null;
  if (now - rec.lastFailureAt > TTL_MS) {
    store.delete(key);
    return null;
  }
  // Adjacency healing: standing next to the target heals a stale
  // navigation failure. A block within direct interaction reach is
  // reachable BY DEFINITION — the bot must be allowed to retry it.
  if (kind === 'block' && fromPosition && position) {
    try {
      const fx = Number(fromPosition.x);
      const fy = Number(fromPosition.y);
      const fz = Number(fromPosition.z);
      const px = Number(position.x);
      const py = Number(position.y);
      const pz = Number(position.z);
      if ([fx, fy, fz, px, py, pz].every((n) => Number.isFinite(n))) {
        const dx = fx - px;
        const dy = fy - py;
        const dz = fz - pz;
        if (dx * dx + dy * dy + dz * dz < ADJACENCY_HEAL_DISTANCE * ADJACENCY_HEAL_DISTANCE) {
          return null;
        }
      }
    } catch {
      // ignore healing check; fall through to relevance logic
    }
  }
  if (fromPosition && rec.attemptedFrom) {
    const dx = fromPosition.x - rec.attemptedFrom.x;
    const dy = fromPosition.y - rec.attemptedFrom.y;
    const dz = fromPosition.z - rec.attemptedFrom.z;
    if (dx * dx + dy * dy + dz * dz >= RELEVANCE_RADIUS * RELEVANCE_RADIUS) return null;
  }
  return { ...rec };
}

function clear() {
  store.clear();
}

function stats() {
  return { size: store.size, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS, relevanceRadius: RELEVANCE_RADIUS, adjacencyHealDistance: ADJACENCY_HEAL_DISTANCE };
}

function botDimension(bot) {
  try {
    const d = bot && bot.game && bot.game.dimension;
    if (typeof d === 'string' && d) return d;
  } catch {
    // ignore
  }
  return 'overworld';
}

module.exports = {
  recordFailure,
  isExcluded,
  clear,
  stats,
  botDimension,
  keyFor,
  MAX_ENTRIES,
  TTL_MS,
  RELEVANCE_RADIUS,
  ADJACENCY_HEAL_DISTANCE,
};
