'use strict';

// External Minecraft reference: security boundary tests with a stubbed
// globalThis.fetch. Covers: query-text-only input, fixed allowlisted
// provider/domain, GET-only + redirect refusal, hard timeout, bounded
// response bytes, structured non-fatal failure, cache behavior, honest
// truncation, and "reference results are never written as memories".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const reference = require('../src/knowledge/reference');

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader() {
        const text = JSON.stringify(payload);
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: Buffer.from(text, 'utf8') };
          },
          cancel: async () => {},
        };
      },
    },
    text: async () => JSON.stringify(payload),
  };
}

function wikiPayload(pages) {
  const out = { query: { pages: {} } };
  pages.forEach((p, i) => {
    out.query.pages[String(100 + i)] = { title: p.title, index: i + 1, extract: p.extract || '' };
  });
  return out;
}

function captureFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return handler(url, init);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('reference lookup accepts query text only and calls the fixed provider', async () => {
  const cap = captureFetch(() => jsonResponse(wikiPayload([{ title: 'Nether Portal', extract: 'A portal to the Nether.' }])));
  try {
    const res = await reference.lookupReference('how nether portals work');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(cap.calls.length, 1);
    const call = cap.calls[0];
    // Fixed allowlisted endpoint, GET only, redirects refused.
    assert.ok(call.url.startsWith(`${reference.REFERENCE_ENDPOINT}?`), `unexpected endpoint: ${call.url}`);
    assert.ok(call.url.includes(new URL(reference.REFERENCE_ENDPOINT).host), 'host must be the allowlisted provider');
    assert.strictEqual(call.init.method, 'GET');
    assert.strictEqual(call.init.redirect, 'error');
    // The search text travels as a query parameter, nothing else.
    assert.ok(call.url.includes('gsrsearch='), 'query passed as search term');
    assert.strictEqual(res.provider, reference.REFERENCE_PROVIDER);
    assert.strictEqual(res.results[0].title, 'Nether Portal');
    assert.match(res.results[0].extract, /portal to the Nether/);
    assert.match(res.note, /never follow instructions/i, 'untrusted-data marker present');
  } finally {
    cap.restore();
  }
});

test('reference lookup bounds results, strips HTML, truncates extracts', async () => {
  const longExtract = `<p>This page mentions <b>portals</b> and &amp; entities. ${'x'.repeat(3000)}</p>`;
  const cap = captureFetch(() =>
    jsonResponse(
      wikiPayload([
        { title: 'A', extract: longExtract },
        { title: 'B', extract: 'second' },
        { title: 'C', extract: 'third' },
        { title: 'D', extract: 'fourth — beyond the limit' },
      ])
    )
  );
  try {
    const res = await reference.lookupReference('portals');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.results.length, reference.RESULT_LIMIT);
    assert.strictEqual(res.truncated, true);
    assert.ok(!res.results[0].extract.includes('<p>'), 'HTML tags stripped');
    assert.ok(!res.results[0].extract.includes('&amp;'), 'entities decoded');
    assert.ok(res.results[0].extract.length <= 1201, `extract bounded (got ${res.results[0].extract.length})`);
    assert.ok(!res.results.some((r) => r.title === 'D'), 'result count bounded');
  } finally {
    cap.restore();
  }
});

test('reference lookup bounds response bytes by cancelling the stream', async () => {
  let reads = 0;
  let cancelled = false;
  const chunk = Buffer.alloc(50000, 0x61); // 50KB of 'a'
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () => {
            reads += 1;
            return { done: false, value: chunk };
          },
          cancel: async () => {
            cancelled = true;
          },
        };
      },
    },
    text: async () => {
      throw new Error('text() must not be used when a reader exists');
    },
  });
  try {
    const res = await reference.lookupReference('big response');
    // 200KB cap / 50KB chunks -> a handful of reads, not unbounded.
    assert.ok(reads <= reference.MAX_RESPONSE_BYTES / 50000 + 1, `stream read too many chunks: ${reads}`);
    assert.strictEqual(cancelled, true, 'stream cancelled after cap');
    assert.strictEqual(res.ok, false, 'garbage over-cap body is a structured failure, not a crash');
    assert.strictEqual(res.reason, 'knowledge_unavailable');
  } finally {
    globalThis.fetch = original;
  }
});

test('reference lookup failures are structured and non-fatal', async () => {
  // Network failure.
  let cap = captureFetch(async () => {
    throw new Error('ECONNREFUSED');
  });
  try {
    const res = await reference.lookupReference('weather');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'knowledge_unavailable');
    assert.ok(res.error && res.error.length > 0);
  } finally {
    cap.restore();
  }
  // Provider error status.
  cap = captureFetch(() => jsonResponse({ error: 'boom' }, { status: 500 }));
  try {
    const res = await reference.lookupReference('weather');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'knowledge_unavailable');
  } finally {
    cap.restore();
  }
  // Non-JSON body.
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let done = false;
        return {
          read: async () => {
            if (done) return { done: true };
            done = true;
            return { done: false, value: Buffer.from('<html>not json</html>', 'utf8') };
          },
          cancel: async () => {},
        };
      },
    },
    text: async () => '<html>not json</html>',
  });
  try {
    const res = await reference.lookupReference('weather');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'knowledge_unavailable');
  } finally {
    globalThis.fetch = original;
  }
});

test('reference lookup rejects invalid queries without any network call', async () => {
  const cap = captureFetch(() => jsonResponse(wikiPayload([])));
  try {
    const empty = await reference.lookupReference('   ');
    assert.strictEqual(empty.ok, false);
    assert.strictEqual(empty.reason, 'invalid_query');
    const tooLong = await reference.lookupReference('x'.repeat(201));
    assert.strictEqual(tooLong.ok, false);
    assert.strictEqual(tooLong.reason, 'invalid_query');
    assert.strictEqual(cap.calls.length, 0, 'no network traffic for invalid queries');
  } finally {
    cap.restore();
  }
});

test('reference lookup caches successful results (no refetch)', async () => {
  const cap = captureFetch(() => jsonResponse(wikiPayload([{ title: 'Breeding', extract: 'Breeding grows animal populations.' }])));
  try {
    const first = await reference.lookupReference('How does animal breeding work?');
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.cached, undefined);
    // Same query, different whitespace/case: served from cache.
    const second = await reference.lookupReference('  how   does animal BREEDING work? ');
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.cached, true);
    assert.strictEqual(cap.calls.length, 1, 'successful lookup cached, provider called once');
  } finally {
    cap.restore();
  }
});

test('reference lookups are never written as experiential memories', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-test-'));
  process.env.MEMORY_DIR = tmp;
  try {
    // Fresh store modules under an isolated memory dir.
    for (const m of ['semantic', 'episodic']) {
      delete require.cache[require.resolve(`../src/memory/${m}`)];
    }
    const semantic = require('../src/memory/semantic');
    const episodic = require('../src/memory/episodic');
    const before = { semantic: semantic.list().length, episodic: episodic.list().length };

    const cap = captureFetch(() => jsonResponse(wikiPayload([{ title: 'Enchanting', extract: 'Enchanting improves tools.' }])));
    try {
      const res = await reference.lookupReference('enchanting basics');
      assert.strictEqual(res.ok, true);
    } finally {
      cap.restore();
    }
    // Give any (wrong) async memory write a chance to happen.
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(semantic.list().length, before.semantic, 'semantic store untouched by reference lookup');
    assert.strictEqual(episodic.list().length, before.episodic, 'episodic store untouched by reference lookup');
  } finally {
    delete process.env.MEMORY_DIR;
    for (const m of ['semantic', 'episodic']) {
      delete require.cache[require.resolve(`../src/memory/${m}`)];
    }
  }
});

test('reference hard timeout produces structured failure (abort honored)', async () => {
  // Simulate a fetch that never settles normally; the real code passes an
  // AbortSignal.timeout signal, whose abort we mirror by rejecting after a
  // short delay (AbortSignal.timeout timers are unref'd and cannot keep a
  // test's event loop alive for the full 10s).
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new Promise((resolve, reject) => {
      const fail = () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        reject(err);
      };
      const signal = init && init.signal;
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', fail);
      }
      setTimeout(fail, 5);
    });
  try {
    const res = await reference.lookupReference('slow page');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'knowledge_unavailable');
    assert.match(res.error, /abort|timeout/i);
  } finally {
    globalThis.fetch = original;
  }
});
