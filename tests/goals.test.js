'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createGoalManager } = require('../src/agent/goals');

test('goal creation', () => {
  const g = createGoalManager({ directive: 'Test directive' });
  const res = g.setGoal('Establish shelter before night', { priority: 80, reason: 'Night approaching' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(g.getState().currentGoal.description, 'Establish shelter before night');
  assert.strictEqual(g.getState().currentGoal.priority, 80);
});

test('goal replacement keeps history', () => {
  const g = createGoalManager({});
  g.setGoal('collect wood', { priority: 50 });
  g.setGoal('escape creeper', { priority: 95, reason: 'danger' });
  assert.strictEqual(g.getState().currentGoal.description, 'escape creeper');
  assert.strictEqual(g.getHistory().length, 1);
  assert.strictEqual(g.getHistory()[0].status, 'replaced');
});

test('goal suspension and resume on completion', () => {
  const g = createGoalManager({});
  g.setGoal('mine iron', { priority: 50 });
  g.suspendFor('Escape creeper immediately', { priority: 95 });
  assert.strictEqual(g.getState().currentGoal.description, 'Escape creeper immediately');
  assert.ok(g.getState().suspendedGoal);
  g.completeGoal('escaped');
  assert.strictEqual(g.getState().currentGoal.description, 'mine iron');
});

test('goal completion clears subgoals', () => {
  const g = createGoalManager({});
  g.setGoal('build shelter', { subgoals: ['collect wood', 'find food'] });
  assert.strictEqual(g.getState().subgoals.length, 2);
  g.completeGoal('done');
  assert.strictEqual(g.getState().currentGoal, null);
});
