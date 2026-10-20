import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createZoteroClient, ZoteroError } from '../lib/zotero.js';

const parentKey = 'ABCD2345';
const childKey = 'EFGH6789';
const bytes = Buffer.from('%PDF-1.7\nmock PDF\n%%EOF');
const md5 = createHash('md5').update(bytes).digest('hex');
const parent = { key: parentKey, data: { itemType: 'journalArticle', title: 'Existing' } };
const child = { key: childKey, data: { itemType: 'attachment', parentItem: parentKey, filename: 'paper.pdf', md5 } };
const args = { parentItemKey: parentKey, bytes, filename: 'paper.pdf', title: 'Paper', sourceUrl: 'https://example.org/paper.pdf' };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });

// Every test owns a fresh client and mock. Unexpected requests fail (never reach a real library).
async function mockRun(overrides, run) {
  const original = globalThis.fetch;
  const calls = [];
  let filePosts = 0;
  let auths = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const path = u.pathname + u.search;
    const call = { url: u, path, method, ...init };
    calls.push(call);
    if (overrides) {
      const response = await overrides(call, { calls });
      if (response !== undefined) return response;
    }
    if (path === '/api/users/0/items?limit=1') return json([]);
    if (path === `/api/users/0/items/${parentKey}`) return json(parent);
    if (path === `/api/users/0/items/${parentKey}/children?format=json`) return json([]);
    if (path === '/api/') return json({}, 200, { 'Zotero-Server-ID': 'server-test' });
    if (path === '/api/local/authorize') {
      assert.equal(init.headers['Zotero-Server-ID'], 'server-test');
      assert.deepEqual(JSON.parse(init.body), { appName: 'DSH Zotero Flow' });
      return json({ key: `key-${++auths}`, remember: false });
    }
    if (method === 'POST' && path.startsWith('/api/users/0/')) {
      assert.ok(init.headers['Zotero-API-Key']);
      assert.equal(init.headers['Zotero-Server-ID'], 'server-test');
      assert.equal(init.redirect, 'error');
    }
    if (path === '/api/users/0/items' && method === 'POST') {
      const [data] = JSON.parse(init.body);
      assert.deepEqual(data, { itemType: 'attachment', parentItem: parentKey, linkMode: 'imported_file', contentType: 'application/pdf', filename: 'paper.pdf', title: 'Paper', url: args.sourceUrl });
      return json({ successful: { 0: { key: childKey } }, failed: {} });
    }
    if (path === `/api/users/0/items/${childKey}/file` && method === 'POST') {
      assert.equal(init.headers['If-None-Match'], '*');
      assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(init.body);
      if (++filePosts === 1) {
        assert.equal(form.get('md5'), md5);
        assert.equal(form.get('filesize'), String(bytes.length));
        assert.equal(form.get('contentType'), 'application/pdf');
        assert.ok(Number(form.get('mtime')) > 0);
        return json({ url: '/api/local/uploads/upload-test', contentType: 'multipart/form-data; boundary=test', prefix: 'prefix', suffix: 'suffix', uploadKey: 'upload-test' });
      }
      assert.equal(form.get('upload'), 'upload-test');
      return new Response(null, { status: 204 });
    }
    if (path === '/api/local/uploads/upload-test') {
      assert.equal(init.headers['Content-Type'], 'multipart/form-data; boundary=test');
      assert.equal(init.headers['Zotero-API-Key'], undefined);
      assert.equal(init.redirect, 'error');
      assert.deepEqual(init.body, Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')]));
      return new Response(null, { status: 201 });
    }
    if (path === `/api/users/0/items/${childKey}`) return json(child);
    if (path === `/api/users/0/items/${childKey}/file/view/url`) return new Response('file:///mock/paper.pdf');
    throw new Error(`Unexpected mock request: ${method} ${path}`);
  };
  try { await run(createZoteroClient(), calls); } finally { globalThis.fetch = original; }
}

const incomplete = (error) => error instanceof ZoteroError && error.detail?.attachmentKey === childKey && error.detail.incomplete === true && /incomplete/i.test(error.message);

test('success: existing parent, native single-use authorization, byte upload and verification', async () => {
  await mockRun(null, async (client, calls) => {
    const result = await client.attachExistingPdf(args);
    assert.deepEqual(result, { attached: true, duplicate: false, parentItemKey: parentKey, attachmentKey: childKey, md5, fileUrl: 'file:///mock/paper.pdf' });
    assert.equal(calls.filter(c => c.path === '/api/local/authorize').length, 3);
    assert.equal(calls.filter(c => c.method === 'POST' && c.path === '/api/users/0/items').length, 1);
  });
});

test('duplicate MD5 returns existing child without any write or authorization', async () => {
  await mockRun(c => c.path.endsWith('/children?format=json') ? json([child]) : undefined, async (client, calls) => {
    assert.equal((await client.attachExistingPdf(args)).duplicate, true);
    assert.equal(calls.some(c => c.method === 'POST'), false);
  });
});

test('invalid keys, PDF data and filename fail before any request', async () => {
  await mockRun(null, async (client, calls) => {
    for (const change of [{ parentItemKey: '../bad' }, { bytes: Buffer.from('<html>') }, { bytes: 'pdf' }, { filename: '../paper.pdf' }]) {
      await assert.rejects(client.attachExistingPdf({ ...args, ...change }), ZoteroError);
    }
    assert.equal(calls.length, 0);
  });
});

for (const data of [{ itemType: 'journalArticle', deleted: 1 }, { itemType: 'attachment' }, { itemType: 'note' }, { itemType: 'annotation' }]) {
  test(`reject nonregular/deleted parent ${JSON.stringify(data)} without writes`, async () => {
    await mockRun(c => c.path === `/api/users/0/items/${parentKey}` ? json({ key: parentKey, data }) : undefined, async (client, calls) => {
      await assert.rejects(client.attachExistingPdf(args), { code: 'INVALID_PARENT' });
      assert.equal(calls.some(c => c.method === 'POST'), false);
    });
  });
}

test('HTTP 200 batch failure is an error, not success', async () => {
  await mockRun(c => c.path === '/api/users/0/items' && c.method === 'POST' ? json({ successful: {}, failed: { 0: { code: 400, message: 'bad attachment' } } }) : undefined, async client => {
    await assert.rejects(client.attachExistingPdf(args), { code: 'CREATE_ATTACHMENT_FAILED' });
  });
});

test('batch partial result preserves created child key', async () => {
  await mockRun(c => c.path === '/api/users/0/items' && c.method === 'POST' ? json({ successful: { 0: { key: childKey } }, failed: { 1: { code: 400 } } }) : undefined, async client => {
    await assert.rejects(client.attachExistingPdf(args), incomplete);
  });
});

for (const url of ['https://evil.invalid/api/local/uploads/x', 'http://127.0.0.1:23119/elsewhere', '//evil.invalid/api/local/uploads/x', '/api/local/uploads/x?redirect=evil']) {
  test(`reject upload URL ${url} and retain partial child`, async () => {
    await mockRun(c => c.path === `/api/users/0/items/${childKey}/file` ? json({ url, contentType: 'application/pdf', prefix: '', suffix: '', uploadKey: 'x' }) : undefined, async (client, calls) => {
      await assert.rejects(client.attachExistingPdf(args), e => incomplete(e) && e.code === 'UNSAFE_UPLOAD_URL');
      assert.equal(calls.some(c => c.url.hostname === 'evil.invalid'), false);
    });
  });
}

test('unfinished filename blocks retry rather than creating duplicate', async () => {
  await mockRun(c => c.path.endsWith('/children?format=json') ? json([{ ...child, data: { ...child.data, md5: null } }]) : undefined, async (client, calls) => {
    await assert.rejects(client.attachExistingPdf(args), incomplete);
    assert.equal(calls.some(c => c.method === 'POST'), false);
  });
});

test('upload/registration/verification failures include actionable child key', async () => {
  for (const failPath of ['/api/local/uploads/upload-test', `/api/users/0/items/${childKey}/file/view/url`, `/api/users/0/items/${childKey}`]) {
    await mockRun(c => c.path === failPath ? new Response('failure', { status: 500 }) : undefined, async client => {
      await assert.rejects(client.attachExistingPdf(args), incomplete);
    });
  }
  let fileCalls = 0;
  await mockRun(c => c.path === `/api/users/0/items/${childKey}/file` && ++fileCalls === 2 ? new Response('failure', { status: 500 }) : undefined, async client => {
    await assert.rejects(client.attachExistingPdf(args), incomplete);
  });
});

test('authorization denial stops without creating child', async () => {
  await mockRun(c => c.path === '/api/local/authorize' ? json({ denied: true }, 403) : undefined, async (client, calls) => {
    await assert.rejects(client.attachExistingPdf(args), { code: 'LOCAL_API_AUTH_FAILED' });
    assert.equal(calls.some(c => c.path === '/api/users/0/items' && c.method === 'POST'), false);
  });
});

test('remembered key reused; revoked key 401 reauthorizes once', async () => {
  let authorization = 0;
  let creates = 0;
  await mockRun(c => {
    if (c.path === '/api/local/authorize') return json({ key: `remembered-${++authorization}`, remember: true });
    if (c.path === '/api/users/0/items' && c.method === 'POST' && ++creates === 1) return new Response(null, { status: 401 });
  }, async (client, calls) => {
    await client.attachExistingPdf(args);
    assert.equal(authorization, 2);
    assert.equal(calls.filter(c => c.path === '/api/users/0/items' && c.method === 'POST').length, 2);
  });
});

test('local API disabled can be enabled live with same client', async () => {
  let enabled = false;
  await mockRun(c => c.path === '/api/users/0/items?limit=1' ? json([], enabled ? 200 : 403) : undefined, async (client, calls) => {
    await assert.rejects(client.attachExistingPdf(args), { code: 'LOCAL_API_DISABLED' });
    assert.equal(calls.some(c => c.method === 'POST'), false);
    enabled = true;
    assert.equal((await client.attachExistingPdf(args)).attached, true);
  });
});

test('search DOI uses everything and public read methods retain envelopes', async () => {
  await mockRun(c => {
    if (c.url.pathname.endsWith('/items/top')) {
      assert.equal(c.url.searchParams.get('qmode'), 'everything');
      assert.equal(c.url.searchParams.get('q'), '10.1234/example');
      return json([{ ...parent, data: { ...parent.data, DOI: '10.1234/example' } }]);
    }
    if (c.path.endsWith('/children?format=json')) return json([child, { data: { itemType: 'note' } }]);
  }, async client => {
    assert.deepEqual(await client.getItem(parentKey), parent);
    assert.deepEqual(await client.listItemAttachments(parentKey), [child]);
    assert.equal((await client.searchItems('10.1234/example')).items[0].DOI, '10.1234/example');
  });
});
