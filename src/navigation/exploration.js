'use strict';

// Session-level exploration state: coarse visited cells so cognition stops
// re-searching the same pocket. Runtime only (never persisted, never dumped
// wholesale to the LLM — the planner gets a compact summary).

const CELL_SIZE = 32;

const cells = new Map(); // "cx,cz" -> { cellX, cellZ, visits, lastVisitedAt, failures }
// Bounded ring of recently visited cells (coarse keys) for oscillation
// detection. One A-B-A return is ordinary backtracking; a repeated return
// pattern is oscillation. Never exact positions, never large.
const recentCells = [];
const MAX_RECENT_CELLS = 12;

function cellKey(x, z, size = CELL_SIZE) {
  return `${Math.floor(Number(x) / size)},${Math.floor(Number(z) / size)}`;
}

function parseCell(key) {
  const [cellX, cellZ] = String(key).split(',').map(Number);
  return { cellX, cellZ };
}

function recordVisit(x, z, info = {}) {
  const key = cellKey(x, z);
  const prev = cells.get(key);
  const [cellX, cellZ] = key.split(',').map(Number);
  cells.set(key, {
    cellX,
    cellZ,
    visits: (prev ? prev.visits : 0) + 1,
    lastVisitedAt: Date.now(),
    failures: (prev ? prev.failures : 0) + (info.failed ? 1 : 0),
  });
  if (cells.size > 2000) {
    const oldest = cells.keys().next().value;
    cells.delete(oldest);
  }
  recentCells.push(key);
  while (recentCells.length > MAX_RECENT_CELLS) recentCells.shift();
  return key;
}

// Conservative oscillation detector over coarse cells: counts A-B-A returns
// (same cell two visits apart with a different cell between) in the recent
// ring. Two or more returns with at most 3 distinct cells means the bot is
// cycling ground instead of progressing. Pure movement pattern — the caller
// combines it with progress signals (withoutProgress) before bothering
// cognition.
function detectOscillation() {
  const seq = recentCells.slice(-8);
  if (seq.length < 5) return { detected: false };
  let returns = 0;
  for (let i = 0; i + 2 < seq.length; i++) {
    if (seq[i] === seq[i + 2] && seq[i] !== seq[i + 1]) returns += 1;
  }
  if (returns < 2) return { detected: false };
  if (new Set(seq).size > 3) return { detected: false };
  return { detected: true, cells: seq.slice(-4), returns };
}

const DIRECTIONS = ['north', 'south', 'east', 'west'];

// Compact cognition summary: where we are, which neighboring sectors are
// least visited (exploration hints), how much ground is mapped nearby.
function summary(x, z) {
  const currentCell = cellKey(x, z);
  const neighbors = [
    { direction: 'north', key: cellKey(x, z - CELL_SIZE) },
    { direction: 'south', key: cellKey(x, z + CELL_SIZE) },
    { direction: 'east', key: cellKey(x + CELL_SIZE, z) },
    { direction: 'west', key: cellKey(x - CELL_SIZE, z) },
  ];
  const ranked = neighbors
    .map((n) => ({ direction: n.direction, visits: cells.get(n.key)?.visits || 0 }))
    .sort((a, b) => a.visits - b.visits);
  // Count visited cells in the 3x3 neighborhood around the current cell.
  const here = parseCell(currentCell);
  let nearbyVisitedSectors = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (cells.has(`${here.cellX + dx},${here.cellZ + dz}`)) nearbyVisitedSectors += 1;
    }
  }
  return {
    currentCell,
    nearbyVisitedSectors,
    leastVisitedDirections: ranked.map((r) => r.direction),
  };
}

function clear() {
  cells.clear();
  recentCells.length = 0;
}

function stats() {
  return { cells: cells.size, cellSize: CELL_SIZE };
}

module.exports = { cellKey, parseCell, recordVisit, summary, clear, stats, detectOscillation, CELL_SIZE, DIRECTIONS };
