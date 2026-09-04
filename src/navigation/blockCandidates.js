'use strict';

// Shared block-candidate discovery + selection.
//
// Upstream Mineflayer contract (verified against installed mineflayer 4.38.0,
// lib/plugins/blocks.js):
//   bot.findBlocks({ matching, maxDistance, count, point? }) -> Vec3[]
//     entries are POSITIONS (cloned Vec3 cursors), sorted by distance to the
//     search point. They are NOT Block objects and have no `.position`.
//   bot.findBlock(options) -> Block | null
//     takes blocks[0] and resolves it via bot.blockAt().
//
// Two autonomous call sites (mine_block_type, find_block) previously treated
// findBlocks() results as if they were already Blocks (`candidate.position`),
// so every live Vec3 candidate was silently discarded while unit-test mocks
// returned Block objects and kept passing. This module is the single
// Mineflayer-representation -> normalized-Block boundary so no caller has to
// ask "is this a Vec3 or a Block?" again.
//
// Pipeline:
//   discover (findBlocks Vec3[]) -> normalize (blockAt + revalidate +
//   dedupe) -> remove targetFailures exclusions -> generic actionability rank
//   -> select. Both find_block (report best) and mine_block_type (attempt in
//   order) reuse it.

const { blockAtPos } = require('../blocks');
const targetFailures = require('./targetFailures');

// Direct-interaction reach used for ranking tier 1. Consistent with the
// mining primitive's withinReach default (5) and conservative: a block
// inside this radius can usually be dug without further travel.
const INTERACTION_REACH = 5;
// Small vertical offset: blocks within ~2 of eye level are ordinary
// walk-up-and-dig targets; high canopy / deep shafts sort later.
const SMALL_VERTICAL = 2;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function posOfPositionLike(v) {
  if (!v || typeof v !== 'object') return null;
  const x = num(v.x);
  const y = num(v.y);
  const z = num(v.z);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

function isBlockLike(v) {
  return !!(
    v &&
    typeof v === 'object' &&
    typeof v.name === 'string' &&
    v.position &&
    posOfPositionLike(v.position)
  );
}

// Materialize one raw findBlocks entry into a Block object (or null).
// Accepts real Vec3 positions, plain {x,y,z} (tests), and — defensively for
// old mocks — already-materialized Block objects.
function materializeCandidate(bot, entry, matching) {
  try {
    if (!entry || typeof entry !== 'object') return null;
    if (isBlockLike(entry)) {
      try {
        if (typeof matching === 'function' && !matching(entry)) return null;
      } catch {
        return null;
      }
      return entry;
    }
    const pos = posOfPositionLike(entry);
    if (!pos) return null;
    const block = blockAtPos(bot, pos.x, pos.y, pos.z);
    if (!block || typeof block.name !== 'string') return null;
    try {
      if (typeof matching === 'function' && !matching(block)) return null;
    } catch {
      return null;
    }
    return block;
  } catch {
    return null;
  }
}

// Call bot.findBlocks() and normalize to deduplicated, revalidated Blocks.
// Never throws for ordinary failures; returns [] when search is unavailable.
function findBlockCandidates(bot, { matching, maxDistance = 32, count = 12 } = {}) {
  let raw = [];
  try {
    if (bot && typeof bot.findBlocks === 'function') {
      const found = bot.findBlocks({ matching, maxDistance, count });
      if (Array.isArray(found)) raw = found;
    }
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (!entry) continue;
    const block = materializeCandidate(bot, entry, matching);
    if (!block || !block.position) continue;
    let px;
    try {
      px = posOfPositionLike(block.position);
    } catch {
      px = null;
    }
    if (!px) continue;
    const key = `${Math.round(px.x)},${Math.round(px.y)},${Math.round(px.z)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(block);
  }
  return out;
}

function botPosition(bot) {
  try {
    const p = bot && bot.entity && bot.entity.position;
    if (!p) return null;
    const pos = posOfPositionLike(p);
    return pos ? { x: pos.x, y: pos.y, z: pos.z } : null;
  } catch {
    return null;
  }
}

function candidateDistance(me, block) {
  try {
    const bp = block && block.position ? posOfPositionLike(block.position) : null;
    if (!me || !bp) return { dist: Infinity, dy: Infinity };
    const dx = bp.x - me.x;
    const dy = bp.y - me.y;
    const dz = bp.z - me.z;
    return { dist: Math.sqrt(dx * dx + dy * dy + dz * dz), dy };
  } catch {
    return { dist: Infinity, dy: Infinity };
  }
}

// Generic actionability ranking (no tree/canopy semantics):
//   tier 0: already inside direct dig reach
//   tier 1: small vertical offset (ordinary walk-up targets)
//   tier 2: everything else (high canopy, deep shafts)
// Within each tier, shorter Euclidean distance wins. Pathfinder approach
// remains the authoritative reachability test; this only orders attempts.
function rankBlockCandidates(bot, blocks, { reach = INTERACTION_REACH } = {}) {
  const me = botPosition(bot);
  const scored = (Array.isArray(blocks) ? blocks : []).map((block, idx) => {
    const { dist, dy } = candidateDistance(me, block);
    const inReach = Number.isFinite(dist) && dist <= reach ? 0 : 1;
    const smallVert = Number.isFinite(dy) && Math.abs(dy) <= SMALL_VERTICAL ? 0 : 1;
    return { block, idx, inReach, smallVert, dist: Number.isFinite(dist) ? dist : Infinity };
  });
  scored.sort((a, b) => {
    if (a.inReach !== b.inReach) return a.inReach - b.inReach;
    if (a.smallVert !== b.smallVert) return a.smallVert - b.smallVert;
    if (a.dist !== b.dist) return a.dist - b.dist;
    return a.idx - b.idx;
  });
  return scored.map((s) => s.block);
}

// Full shared selection pipeline used by both find_block and
// mine_block_type: discover -> normalize -> exclude stale failures ->
// rank. Returns honest counts for resource_not_seen vs
// no_reachable_target distinction.
function getSelectableBlocks(
  bot,
  { matching, blockType, maxDistance = 32, count = 12, kind = 'block', target = null, reach = INTERACTION_REACH } = {}
) {
  const wanted = target || (typeof blockType === 'string' ? blockType : null);
  const candidates = findBlockCandidates(bot, { matching, maxDistance, count });
  const candidatesSeen = candidates.length;
  if (candidates.length === 0) {
    return { candidatesSeen: 0, candidatesSkipped: 0, candidates: [], excluded: [] };
  }
  let dimension = 'overworld';
  try {
    dimension = targetFailures.botDimension(bot);
  } catch {
    // ignore
  }
  const fromPosition = botPosition(bot);
  const eligible = [];
  const excludedList = [];
  let skipped = 0;
  for (const block of candidates) {
    let excluded = null;
    try {
      if (wanted) {
        excluded = targetFailures.isExcluded({
          dimension,
          kind,
          target: wanted,
          position: block.position,
          fromPosition,
        });
      }
    } catch {
      excluded = null;
    }
    if (excluded) {
      skipped += 1;
      excludedList.push(block);
      continue;
    }
    eligible.push(block);
  }
  const ranked = rankBlockCandidates(bot, eligible, { reach });
  return { candidatesSeen, candidatesSkipped: skipped, candidates: ranked, excluded: excludedList };
}

module.exports = {
  findBlockCandidates,
  rankBlockCandidates,
  getSelectableBlocks,
  materializeCandidate,
  INTERACTION_REACH,
  SMALL_VERTICAL,
};
