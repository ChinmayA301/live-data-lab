import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedFetch } from '../src/worker.ts';

test('transient upstream 522 is retried once, with a bounded per-attempt timeout', async t => {
  let attempts = 0, cancelled = false;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert(options.signal instanceof AbortSignal);
    if (++attempts === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 522 });
    return new Response(new Uint8Array([1, 2, 3]));
  });
  assert.deepEqual(await boundedFetch('https://example.test/feed', 10, true), new Uint8Array([1, 2, 3]));
  assert.equal(attempts, 2); assert.equal(cancelled, true);
});
test('transit retries cannot loop indefinitely or bypass size and permanent-error contracts', async t => {
  for (const [response, expectedAttempts, error] of [
    [() => new Response('unavailable', { status: 522 }), 2, /522/],
    [() => new Response('missing', { status: 404 }), 1, /404/],
    [() => new Response('oversized'), 1, /size contract/]
  ]) {
    let attempts = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => { attempts++; return response(); });
    await assert.rejects(boundedFetch('https://example.test/feed', 2, true), error);
    assert.equal(attempts, expectedAttempts); mock.mock.restore();
  }
});
