'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateAction } = require('../src/safety/validator');

test('accepts all allowlisted actions', () => {
  assert.strictEqual(validateAction({ action: 'observe' }).ok, true);
  assert.strictEqual(validateAction({ action: 'collect_logs', amount: 3 }).ok, true);
  assert.strictEqual(validateAction({ action: 'chat', message: 'hello' }).ok, true);
  assert.strictEqual(validateAction({ action: 'wait', seconds: 2 }).ok, true);
  assert.strictEqual(validateAction({ action: 'finish', reason: 'Goal completed' }).ok, true);
});

test('rejects unknown actions and out-of-range params', () => {
  assert.strictEqual(validateAction({ action: 'fly' }).ok, false);
  assert.strictEqual(validateAction({ action: 'collect_logs', amount: 99 }).ok, false);
  assert.strictEqual(validateAction({ action: 'collect_logs', amount: 0 }).ok, false);
  assert.strictEqual(validateAction({ action: 'wait', seconds: 99 }).ok, false);
  assert.strictEqual(validateAction({ action: 'chat', message: '' }).ok, false);
  assert.strictEqual(validateAction({ action: 'finish', reason: '' }).ok, false);
  assert.strictEqual(validateAction(null).ok, false);
  assert.strictEqual(validateAction({ action: 'exec', cmd: 'rm -rf /' }).ok, false);
});

test('trims and bounds chat/finish text', () => {
  const chat = validateAction({ action: 'chat', message: '  hi  ' });
  assert.strictEqual(chat.value.message, 'hi');
  assert.strictEqual(validateAction({ action: 'chat', message: 'x'.repeat(141) }).ok, false);
});
