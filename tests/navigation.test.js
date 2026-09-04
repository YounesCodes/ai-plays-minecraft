'use strict';

// Shared unreachable-target cache + exploration cells: add/check/expiry,
// distance healing, bounds, exclusion, summaries.

const test = require('node:test');
const assert = require('node:assert');
const targetFailures = require('../src/navigation/targetFailures');
const exploration = require('../src/navigation/exploration');

test('target failures are recorded and excluded nearby', () => {
  targetFailures.clear();
  try {
    const rec = targetFailures.recordFailure({
      dimension: 'overworld',
      kind: 'block',
      target: 'oak_log',
      position: { x: 10, y: 64, z: 10 },
      reason: 'movement_stalled',
      attemptedFrom: { x: 0, y: 64, z: 0 },
      now: 1000000,
    });
    assert.strictEqual(rec.failureCount, 1);
    const hit = targetFailures.isExcluded({
      dimension: 'overworld',
      kind: 'block',
      target: 'oak_log',
      position: { x: 10, y: 64, z: 10 },
      fromPosition: { x: 2, y: 64, z: 2 },
      now: 1000000,
    });
    assert.ok(hit, 'excluded near the attempt position');
    assert.strictEqual(hit.reason, 'movement_stalled');
    // Different block is not excluded.
    assert.strictEqual(
      targetFailures.isExcluded({
        dimension: 'overworld',
        kind: 'block',
        target: 'oak_log',
        position: { x: 50, y: 64, z: 50 },
        fromPosition: { x: 2, y: 64, z: 2 },
        now: 1000000,
      }),
      null
    );
  } finally {
    targetFailures.clear();
  }
});

test('target failures heal by distance and TTL', () => {
  targetFailures.clear();
  try {
    targetFailures.recordFailure({
      kind: 'block',
      target: 'oak_log',
      position: { x: 10, y: 64, z: 10 },
      reason: 'timeout',
      attemptedFrom: { x: 0, y: 64, z: 0 },
      now: 1000000,
    });
    // Far away: eligible again.
    assert.strictEqual(
      targetFailures.isExcluded({
        kind: 'block',
        target: 'oak_log',
        position: { x: 10, y: 64, z: 10 },
        fromPosition: { x: 100, y: 64, z: 100 },
        now: 1000000,
      }),
      null
    );
    // Expired: eligible again even from nearby.
    assert.strictEqual(
      targetFailures.isExcluded({
        kind: 'block',
        target: 'oak_log',
        position: { x: 10, y: 64, z: 10 },
        fromPosition: { x: 0, y: 64, z: 0 },
        now: 1000000 + targetFailures.TTL_MS + 1,
      }),
      null
    );
  } finally {
    targetFailures.clear();
  }
});

test('target failure cache is bounded', () => {
  targetFailures.clear();
  try {
    for (let i = 0; i < targetFailures.MAX_ENTRIES + 50; i++) {
      targetFailures.recordFailure({
        kind: 'block',
        target: 'stone',
        position: { x: i * 10, y: 64, z: 0 },
        reason: 'no-path',
        attemptedFrom: { x: 0, y: 64, z: 0 },
        now: 1000000,
      });
    }
    assert.ok(targetFailures.stats().size <= targetFailures.MAX_ENTRIES);
  } finally {
    targetFailures.clear();
  }
});

test('exploration cells track visits and rank directions', () => {
  exploration.clear();
  try {
    exploration.recordVisit(0, 0);
    exploration.recordVisit(0, 0);
    exploration.recordVisit(0, 0);
    exploration.recordVisit(40, 0); // east neighbor cell (1,0)
    const s = exploration.summary(0, 0);
    assert.strictEqual(s.currentCell, '0,0');
    assert.ok(s.nearbyVisitedSectors >= 2);
    // East has a visit, north/south/west have none: least-visited first.
    assert.strictEqual(s.leastVisitedDirections[s.leastVisitedDirections.length - 1], 'east');
    assert.deepStrictEqual([...s.leastVisitedDirections].sort(), ['east', 'north', 'south', 'west']);
  } finally {
    exploration.clear();
  }
});

test('exploration cellKey is coarse and stable', () => {
  assert.strictEqual(exploration.cellKey(0, 0), '0,0');
  assert.strictEqual(exploration.cellKey(31, 31), '0,0');
  assert.strictEqual(exploration.cellKey(32, 0), '1,0');
  assert.strictEqual(exploration.cellKey(-1, -1), '-1,-1');
});
