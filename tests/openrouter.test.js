'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { complete } = require('../src/llm/openrouter');

function abortingFetch() {
  // Mimics real fetch abort semantics: rejects once the signal fires.
  return (url, opts) =>
    new Promise((_, reject) => {
      const sig = opts && opts.signal;
      const onAbort = () =>
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      if (!sig) return; // hangs like a stalled provider
      if (sig.aborted) onAbort();
      else sig.addEventListener('abort', onAbort);
    });
}

test('complete() aborts a hung provider instead of hanging forever', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = abortingFetch();
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_TIMEOUT_MS = '100';
  // Keep the testRunner loop alive: the stub holds no real handles, so
  // without this the loop would drain before the abort timer can fire.
  // (In production the live socket itself keeps the loop alive.)
  const keepAlive = setInterval(() => {}, 25);
  try {
    const t0 = Date.now();
    await assert.rejects(() => complete([{ role: 'user', content: 'hi' }]), /OpenRouter request failed/);
    const ms = Date.now() - t0;
    assert.ok(ms < 10000, `aborted in ${ms}ms`);
  } finally {
    clearInterval(keepAlive);
    delete process.env.OPENROUTER_TIMEOUT_MS;
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = realFetch;
  }
});

test('complete() still returns content on a healthy response', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }], model: 'm', usage: null }),
  });
  process.env.OPENROUTER_API_KEY = 'test-key';
  try {
    const res = await complete([{ role: 'user', content: 'hi' }], { model: 'm' });
    assert.strictEqual(res.content, '{"a":1}');
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = realFetch;
  }
});
