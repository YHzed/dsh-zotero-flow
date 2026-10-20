import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoteroClient } from '../lib/zotero.js';
import { lookupByDoi } from '../lib/metadata.js';

test('Zotero destination accepts literal loopback only and validates ports', () => {
  for (const host of ['example.com', 'localhost', '127.1', '2130706433', '127.0.0.1@evil.test', '127.0.0.1/path', '', null]) {
    assert.throws(() => createZoteroClient({ host }), { code: 'INVALID_ZOTERO_ENDPOINT' });
  }
  for (const port of [0, -1, 65536, 1.5, NaN, Infinity, '23119', null]) {
    assert.throws(() => createZoteroClient({ port }), { code: 'INVALID_ZOTERO_ENDPOINT' });
  }
  assert.equal(createZoteroClient().origin, 'http://127.0.0.1:23119');
  assert.equal(createZoteroClient({ host: '::1', port: 1 }).origin, 'http://[::1]:1');
  assert.equal(createZoteroClient({ host: '[::1]', port: 65535 }).origin, 'http://[::1]:65535');
});

test('Zotero requests reject redirects (offline fetch stub)', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:23119/connector/ping');
    assert.equal(init.redirect, 'error');
    return new Response('ok');
  };
  try {
    assert.equal((await createZoteroClient().ping()).alive, true);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('PDF uploads reject non-PDF, coercible and oversized inputs without fetch', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected fetch'); };
  try {
    const client = createZoteroClient();
    const oversized = new Uint8Array(128 * 1024 * 1024 + 1);
    oversized.set(Buffer.from('%PDF-'));
    for (const bytes of [undefined, 100, '%PDF-test', [37, 80, 68, 70, 45], new Uint8Array(), Buffer.from('<html>login</html>'), oversized]) {
      for (const upload of [client.attachPdf, client.saveStandalonePdf]) {
        await assert.rejects(upload({ bytes, filename: 'test.pdf', sessionId: 'test', parentItemKey: 'test' }), { code: 'INVALID_PDF' });
      }
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('PDF uploads accept valid binary data and respect view offsets', async () => {
  const original = globalThis.fetch;
  const expected = Buffer.from('%PDF-1.7\n%%EOF');
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(init.redirect, 'error');
    assert.deepEqual(Buffer.from(init.body), expected);
    assert.equal(init.headers['Content-Type'], 'application/pdf');
    return new Response('ok');
  };
  try {
    const client = createZoteroClient();
    const padded = Buffer.concat([Buffer.from('prefix'), expected, Buffer.from('suffix')]);
    await client.attachPdf({ bytes: padded.subarray(6, 6 + expected.length), filename: 'test.pdf', sessionId: 'test', parentItemKey: 'test' });
    await client.saveStandalonePdf({ bytes: Uint8Array.from(expected).buffer, filename: 'test.pdf' });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('OpenAlex abstract ignores hostile sparse indices and keeps ordinary order', async () => {
  const abstract = Object.assign(Object.create({ inherited: [2] }), {
    world: [1], Hello: [0], hostile: [4294967294, -1, 1.5, '2', Infinity, NaN],
  });
  const http = { json: async (url) => url.includes('crossref')
    ? { ok: false }
    : { ok: true, json: { id: 'openalex:test', abstract_inverted_index: abstract } } };
  const work = await lookupByDoi('10.1234/test', http);
  assert.equal(work.abstract, 'Hello world');
});

test('OpenAlex abstract limits position inspection and word size', async () => {
  const http = { json: async (url) => url.includes('crossref')
    ? { ok: false }
    : { ok: true, json: { id: 'openalex:test', abstract_inverted_index: {
      ['x'.repeat(1001)]: [0], safe: [9999, 10000], noisy: Array(30000).fill(0), late: [1],
    } } } };
  const work = await lookupByDoi('10.1234/test', http);
  assert.equal(work.abstract, 'noisy safe');
});
