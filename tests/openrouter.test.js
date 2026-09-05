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
    await assert.rejects(
      () => complete([{ role: 'user', content: 'hi' }]),
      (err) => {
        assert.match(err.message, /timed out/);
        assert.strictEqual(err.code, 'transport_timeout');
        return true;
      }
    );
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

function okFetch(capture) {
  return async (url, init) => {
    if (capture) capture.body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }], model: 'm', usage: { total_tokens: 5 } }),
    };
  };
}

test('max_tokens option reaches the OpenRouter request body', async () => {
  const realFetch = globalThis.fetch;
  const capture = {};
  globalThis.fetch = okFetch(capture);
  process.env.OPENROUTER_API_KEY = 'test-key';
  try {
    await complete([{ role: 'user', content: 'hi' }], { maxTokens: 512 });
    assert.strictEqual(capture.body.max_tokens, 512);
    // No budget supplied -> no max_tokens field at all (provider default
    // must never be relied on implicitly).
    capture.body = null;
    await complete([{ role: 'user', content: 'hi' }], {});
    assert.strictEqual(capture.body.max_tokens, undefined);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = realFetch;
  }
});

test('response_format and provider hints reach the request body', async () => {
  const realFetch = globalThis.fetch;
  const capture = {};
  globalThis.fetch = okFetch(capture);
  process.env.OPENROUTER_API_KEY = 'test-key';
  try {
    const rf = { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: { type: 'object' } } };
    await complete([{ role: 'user', content: 'hi' }], { responseFormat: rf, provider: { require_parameters: true } });
    assert.deepStrictEqual(capture.body.response_format, rf);
    assert.deepStrictEqual(capture.body.provider, { require_parameters: true });
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = realFetch;
  }
});

test('HTTP failure is classified transport_http, not parse failure', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => 'bad gateway' });
  process.env.OPENROUTER_API_KEY = 'test-key';
  try {
    await assert.rejects(
      () => complete([{ role: 'user', content: 'hi' }]),
      (err) => {
        assert.strictEqual(err.code, 'transport_http');
        assert.strictEqual(err.status, 502);
        assert.match(err.message, /OpenRouter HTTP 502/);
        return true;
      }
    );
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = realFetch;
  }
});

test('200 with a non-JSON envelope is provider_response_invalid', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>gateway junk</html>' });
  process.env.OPENROUTER_API_KEY = 'test-key';
  try {
    await assert.rejects(
      () => complete([{ role: 'user', content: 'hi' }]),
      (err) => {
        assert.strictEqual(err.code, 'provider_response_invalid');
        return true;
      }
    );
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = realFetch;
  }
});

test('200 with an empty envelope is provider_response_invalid', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [] }) });
  process.env.OPENROUTER_API_KEY = 'test-key';
  try {
    await assert.rejects(
      () => complete([{ role: 'user', content: 'hi' }]),
      (err) => err.code === 'provider_response_invalid'
    );
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = realFetch;
  }
});
