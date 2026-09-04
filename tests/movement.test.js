'use strict';

// Locomotion correctness: stall detection, bounded jump recovery, and the
// single auto-recovery flow. Uses hanging/progressing goto mocks plus real
// timers so the timeboxes themselves are exercised.

const test = require('node:test');
const assert = require('node:assert');
const { executePrimitive } = require('../src/primitives');
const { validatePrimitiveCall } = require('../src/safety/primitiveValidator');

function mockBot(overrides = {}) {
  return {
    entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0 },
    pathfinder: {
      goto: async () => {},
      stop: () => {},
      setGoal: () => {},
    },
    clearControlStates: () => {},
    setControlState: () => {},
    blockAt: () => ({ boundingBox: 'empty', name: 'air' }),
    ...overrides,
  };
}

function withStallWindow(ms, fn) {
  const prev = process.env.MOVEMENT_STALL_WINDOW_MS;
  process.env.MOVEMENT_STALL_WINDOW_MS = String(ms);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.MOVEMENT_STALL_WINDOW_MS;
      else process.env.MOVEMENT_STALL_WINDOW_MS = prev;
    });
}

test('frozen goto fails fast as movement_stalled, not after the full timeout', async () => {
  const calls = [];
  const bot = mockBot({
    pathfinder: {
      goto: () => new Promise(() => {}), // hangs forever
      stop: () => {
        calls.push('stop');
      },
      setGoal: (goal) => {
        calls.push(['setGoal', goal]);
      },
    },
    clearControlStates: () => {
      calls.push('clear');
    },
  });
  await withStallWindow(1000, async () => {
    const t0 = Date.now();
    const res = await executePrimitive(
      bot,
      { primitive: 'move_near', args: { x: 50, y: 64, z: 50 } },
      { timeoutMs: 30000 }
    );
    const ms = Date.now() - t0;
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'movement_stalled');
    assert.strictEqual(res.recoveryAttempted, false); // air all around: nothing to jump
    assert.ok(res.distanceMoved < 0.3);
    assert.ok(res.stalledForMs >= 900, `stalled ${res.stalledForMs}ms`);
    assert.ok(ms < 10000, `failed fast in ${ms}ms, not after the 30s timeout`);
    assert.ok(calls.includes('stop'), 'bot stopped');
  });
});

test('genuinely progressing goto is not flagged as stalled', async () => {
  const bot = mockBot({
    pathfinder: {
      goto: async () => {
        bot.entity.position.x += 3; // real displacement before resolving
      },
      stop: () => {},
      setGoal: () => {},
    },
  });
  await withStallWindow(1000, async () => {
    const res = await executePrimitive(
      bot,
      { primitive: 'move_near', args: { x: 3, y: 64, z: 0 } },
      { timeoutMs: 10000 }
    );
    assert.strictEqual(res.ok, true);
  });
});

test('jump_forward is bounded and always releases controls', async () => {
  const seq = [];
  const bot = mockBot({
    setControlState: (key, value) => {
      seq.push(`${key}:${value}`);
    },
  });
  const t0 = Date.now();
  const res = await executePrimitive(bot, { primitive: 'jump_forward', args: {} }, {});
  const ms = Date.now() - t0;
  assert.strictEqual(res.ok, true);
  assert.ok(res.durationMs >= 300 && res.durationMs < 2000, `duration ${res.durationMs}ms`);
  assert.strictEqual(res.horizontalMoved, 0);
  assert.strictEqual(res.verticalMoved, 0);
  assert.ok(ms < 3000);
  const trues = seq.filter((s) => s.endsWith(':true'));
  const falses = seq.filter((s) => s.endsWith(':false'));
  assert.deepStrictEqual(trues, ['forward:true', 'jump:true']);
  assert.deepStrictEqual(falses.slice(-2), ['forward:false', 'jump:false']);
});

test('jump_forward aborts on interrupt and still releases controls', async () => {
  const seq = [];
  const bot = mockBot({
    setControlState: (key, value) => {
      seq.push(`${key}:${value}`);
    },
  });
  let polls = 0;
  const res = await executePrimitive(
    bot,
    { primitive: 'jump_forward', args: { durationMs: 2000 } },
    {
      shouldAbort: () => {
        polls += 1;
        return polls >= 2 ? { type: 'immediate_threat', reason: 'creeper' } : null;
      },
    }
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.aborted, true);
  assert.match(res.error, /creeper/);
  assert.ok(seq.includes('forward:false') && seq.includes('jump:false'), 'controls released on abort');
});

test('single recovery: stall at simple step, jump once, retry succeeds', async () => {
  let gotos = 0;
  const bot = mockBot({
    pathfinder: {
      goto: async () => {
        gotos += 1;
        if (gotos === 1) return new Promise(() => {}); // first attempt wedges
      },
      stop: () => {},
      setGoal: () => {},
    },
    // Solid step directly ahead (yaw 0 -> cell (0,64,-1)), clear headroom.
    blockAt: ({ x, y, z }) =>
      y === 64 ? { boundingBox: 'block', name: 'stone' } : { boundingBox: 'empty', name: 'air' },
    setControlState: () => {},
  });
  await withStallWindow(1000, async () => {
    const res = await executePrimitive(
      bot,
      { primitive: 'move_near', args: { x: 0, y: 64, z: -6 } },
      { timeoutMs: 30000 }
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.recovered, true);
    assert.strictEqual(gotos, 2); // exactly one retry, no more
  });
});

test('jump_forward args are validated', () => {
  assert.strictEqual(validatePrimitiveCall({ primitive: 'jump_forward', args: {} }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'jump_forward', args: { durationMs: 400 } }).ok, true);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'jump_forward', args: { durationMs: 5000 } }).ok, false);
  assert.strictEqual(validatePrimitiveCall({ primitive: 'jump_forward', args: { durationMs: 50 } }).ok, false);
});
