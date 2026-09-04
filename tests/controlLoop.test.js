'use strict';

// Control-loop quality tests: history, stagnation, oscillation,
// opportunity summary, and the absence of framework replay/activePlan.

const test = require('node:test');
const assert = require('node:assert');
const { createActionHistory, signature } = require('../src/agent/actionHistory');
const explorationState = require('../src/navigation/exploration');
const { summarizeOpportunities, buildContext } = require('../src/agent/context');

function hist() {
  return createActionHistory({ max: 10 });
}
function step(name, args = {}) {
  return { type: 'primitive', name, args };
}
function pos(x, z, y = 64) {
  return { x, y, z };
}

test('signature normalizes arg order deterministically', () => {
  const a = signature({ type: 'primitive', name: 'move_near', args: { x: 1, y: 64, z: 2 } });
  const b = signature({ type: 'primitive', name: 'move_near', args: { z: 2, x: 1, y: 64 } });
  assert.strictEqual(a, b);
  assert.match(a, /^primitive:move_near:/);
});

test('same action with inventory gain is NOT stagnation', () => {
  const h = hist();
  const s = step('mine_block_type', { blockType: 'oak_log', count: 4 });
  for (let i = 0; i < 3; i++) {
    h.record({ step: i + 1, nextStep: s, result: { ok: true, broken: 1 }, posBefore: pos(0, 0), posAfter: pos(0, 0), invBefore: i * 3, invAfter: i * 3 + 3 });
  }
  assert.strictEqual(h.detectStagnation().detected, false);
});

test('same action with displacement is NOT stagnation', () => {
  const h = hist();
  const s = step('explore', { distance: 32, direction: 'west' });
  for (let i = 0; i < 3; i++) {
    h.record({ step: i + 1, nextStep: s, result: { ok: true, distanceMoved: 30 }, posBefore: pos(i * 30, 0), posAfter: pos(i * 30 + 30, 0), invBefore: 5, invAfter: 5 });
  }
  assert.strictEqual(h.detectStagnation().detected, false);
});

test('same action 3x with no progress IS stagnation', () => {
  const h = hist();
  const s = step('move_near', { x: 10, y: 64, z: 5 });
  for (let i = 0; i < 3; i++) {
    h.record({ step: i + 1, nextStep: s, result: { ok: true }, posBefore: pos(0, 0), posAfter: pos(0.1, 0), invBefore: 5, invAfter: 5 });
  }
  const d = h.detectStagnation();
  assert.strictEqual(d.detected, true);
  assert.strictEqual(d.count, 3);
  assert.match(d.repeatedAction, /move_near/);
  assert.match(d.reason, /no meaningful progress/);
});

test('two repeats are not yet stagnation', () => {
  const h = hist();
  const s = step('move_near', { x: 10, y: 64, z: 5 });
  for (let i = 0; i < 2; i++) {
    h.record({ step: i + 1, nextStep: s, result: { ok: true }, posBefore: pos(0, 0), posAfter: pos(0, 0), invBefore: 5, invAfter: 5 });
  }
  assert.strictEqual(h.detectStagnation().detected, false);
});

test('A-B-A cell pattern without progress IS oscillation', () => {
  explorationState.clear();
  // Cells are 32x32: x=0-31 -> cell 0, x=32-63 -> cell 1 (z=128 -> cell 4).
  const A = { x: 10, z: 140 };
  const B = { x: 40, z: 140 };
  for (const p of [A, B, A, B, A]) explorationState.recordVisit(p.x, p.z);
  const d = explorationState.detectOscillation();
  assert.strictEqual(d.detected, true);
  assert.ok(Array.isArray(d.cells));
});

test('single A-B-A backtrack is NOT oscillation', () => {
  explorationState.clear();
  explorationState.recordVisit(10, 140);
  explorationState.recordVisit(40, 140);
  explorationState.recordVisit(10, 140);
  assert.strictEqual(explorationState.detectOscillation().detected, false);
});

test('A-B-A with real progression is not falsely flagged (history side)', () => {
  // Pattern exists at cell level, but the loop only reports oscillation
  // when recent history ALSO shows no progress — simulate a progressing
  // history and assert the combination rule stays quiet.
  explorationState.clear();
  for (const p of [{ x: 10, z: 140 }, { x: 40, z: 140 }, { x: 10, z: 140 }, { x: 40, z: 140 }, { x: 10, z: 140 }]) {
    explorationState.recordVisit(p.x, p.z);
  }
  assert.strictEqual(explorationState.detectOscillation().detected, true);
  const h = hist();
  const s = step('mine_block_type', { blockType: 'oak_log' });
  h.record({ step: 1, nextStep: s, result: { ok: true, broken: 2 }, posBefore: pos(10, 140), posAfter: pos(40, 140), invBefore: 0, invAfter: 2 });
  const recentProgress = h.summary(4).some((e) => e.progress === true);
  assert.strictEqual(recentProgress, true);
  // Loop rule: oscillation reported only when NOT recentProgress.
  const reported = explorationState.detectOscillation().detected && !recentProgress;
  assert.strictEqual(reported, false);
});

test('opportunity summary groups duplicates with shortest distance', () => {
  const perception = {
    interestingBlocks: [
      { type: 'oak_log', category: 'log', position: { x: 1, y: 64, z: 1 }, distance: 5.2 },
      { type: 'oak_log', category: 'log', position: { x: 2, y: 64, z: 1 }, distance: 1.5 },
      { type: 'birch_log', category: 'log', position: { x: 3, y: 64, z: 1 }, distance: 3.0 },
      { type: 'coal_ore', category: 'coal_ore', position: { x: 4, y: 64, z: 1 }, distance: 14.2 },
      { type: 'water', category: 'water', position: { x: 0, y: 64, z: 1 }, distance: 0.5 },
    ],
  };
  const opps = summarizeOpportunities(perception);
  assert.strictEqual(opps.length, 2);
  assert.strictEqual(opps[0].category, 'log');
  assert.strictEqual(opps[0].nearestType, 'oak_log');
  assert.strictEqual(opps[0].distance, 1.5);
  assert.strictEqual(opps[0].countObserved, 3);
  assert.strictEqual(opps[1].category, 'coal_ore');
});

test('autonomous-v2 context carries new signals and no activePlan', () => {
  const ctx = buildContext({
    directive: 'test',
    goalState: { currentGoal: { description: 'g' }, subgoals: [], suspendedGoal: null },
    perception: { self: { health: 20 }, equipment: {}, inventory: {}, environment: {}, nearbyEntitiesDetailed: [], interestingBlocks: [], knownLocationsNearby: [] },
    relevantMemories: { semantic: [], episodic: [], procedural: [], world: [] },
    availableSkills: [],
    actionHistory: [{ step: 1, action: 'primitive:wait:{}', ok: true, progress: false }],
    stagnation: { detected: true, repeatedAction: 'primitive:wait:{}', count: 3, reason: 'x' },
    oscillation: { detected: false },
  });
  assert.ok(!('activePlan' in ctx), 'activePlan must be gone from v2 context');
  assert.ok(Array.isArray(ctx.nearbyOpportunities));
  assert.ok(Array.isArray(ctx.actionHistory));
  assert.strictEqual(ctx.stagnation.detected, true);
  assert.strictEqual(ctx.oscillation.detected, false);
});
