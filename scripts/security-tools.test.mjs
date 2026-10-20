import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTools } from '../lib/tools.js';

// Use public defineTool.execute wrappers, never createRuntime. Browser, Zotero
// and metadata HTTP are offline fakes; only the temp PDF fixture touches disk.
function fakeRuntime() {
  const calls = [];
  const unexpected = (component) => new Proxy({}, {
    get(_target, method) {
      return async (...args) => {
        calls.push({ component, method, args });
        throw new Error(`Unexpected ${component}.${String(method)} call`);
      };
    },
  });
  const rt = {
    config: {},
    browser: unexpected('browser'),
    zotero: unexpected('zotero'),
    http: unexpected('http'),
  };
  const tool = (name) => {
    const found = buildTools(rt).find((entry) => entry.name === name);
    assert.ok(found, `Missing public tool ${name}`);
    return found;
  };
  return { rt, calls, tool };
}

function challenge() {
  return {
    error: 'Cloudflare verification required',
    requiresUserAction: true,
    page: { loginHints: ['人机校验'] },
  };
}

test('scholar_download preserves requiresUserAction and stops after one capture', async () => {
  const { rt, calls, tool } = fakeRuntime();
  rt.browser = {
    async ensure() { calls.push('ensure'); },
    async capturePdf(url, options) {
      calls.push({ url, options });
      return challenge();
    },
  };
  const download = tool('scholar_download');
  const result = await download.execute({ url: 'https://publisher.example/paper.pdf' });
  assert.equal(result.ok, false);
  assert.equal(result.requiresUserAction, true);
  assert.equal(result.sourceUrl, 'https://publisher.example/paper.pdf');
  assert.match(result.text, /请用户手工处理后确认继续/);
  assert.match(result.text, /不要重试或换入口/);
  assert.match(result.text, /人机校验/);
  assert.equal(Object.hasOwn(result, 'path'), false);
  assert.deepEqual(calls, [
    'ensure',
    { url: 'https://publisher.example/paper.pdf', options: { timeoutMs: 90000 } },
  ]);
  assert.equal(download.output.schema.properties.requiresUserAction.type, 'boolean');
});

test('zotero_save challenge aborts before any Zotero create, target lookup or resolver', async () => {
  const { rt, calls, tool } = fakeRuntime();
  const metadataUrls = [];
  rt.http = {
    async json(url) {
      metadataUrls.push(url);
      if (url.startsWith('https://api.crossref.org/works/')) {
        return { ok: true, json: { message: {
          DOI: '10.1234/offline', title: ['Offline security fixture'],
          type: 'journal-article', author: [],
        } } };
      }
      assert.ok(url.startsWith('https://api.openalex.org/works/doi:'), url);
      return { ok: false };
    },
  };
  rt.browser = {
    async capturePdf(url, options) {
      calls.push({ url, options });
      return challenge();
    },
  };
  await assert.rejects(
    tool('zotero_save').execute({
      doi: '10.1234/offline', pdfUrl: 'https://publisher.example/paper.pdf',
      fetchOpenAccess: true,
    }),
    /站点要求人工处理.*已停止归档和自动取全文/,
  );
  assert.equal(metadataUrls.length, 2, 'Only stubbed DOI metadata lookups are allowed');
  // The Zotero fake logs before throwing: swallowed resolver exceptions would
  // still be visible, not mistaken for a successful safety assertion.
  assert.deepEqual(calls, [
    { url: 'https://publisher.example/paper.pdf', options: { timeoutMs: 120000 } },
  ]);
});

test('scholar_session goto rejects file URLs before browser activity', async () => {
  const { calls, tool } = fakeRuntime();
  await assert.rejects(
    tool('scholar_session').execute({ action: 'goto', url: 'file:///C:/private/document.pdf' }),
    /Only HTTP\(S\) URLs/,
  );
  assert.deepEqual(calls, []);
});

test('scholar_session goto rejects huge wait before browser activity', async () => {
  const { calls, tool } = fakeRuntime();
  await assert.rejects(
    tool('scholar_session').execute({
      action: 'goto', url: 'https://publisher.example/article', waitMs: Number.MAX_SAFE_INTEGER,
    }),
    /Timeout must be a finite number between 0 and 30000 ms/,
  );
  assert.deepEqual(calls, []);
});

test('scholar_download reuses captured.path without copying or honoring saveAs', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'security-tools-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pdfPath = path.join(directory, 'already-downloaded.pdf');
  const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  await writeFile(pdfPath, bytes, { flag: 'wx' });
  const { rt, calls, tool } = fakeRuntime();
  // Falling back to writePdf would create this directory and a duplicate;
  // the exact directory listing below detects that regression.
  rt.downloadDir = path.join(directory, 'must-not-be-created');
  rt.browser = {
    async ensure() { calls.push('ensure'); },
    async capturePdf(url, options) {
      calls.push({ url, options });
      return {
        path: pdfPath, bytes, via: 'download',
        finalUrl: 'https://publisher.example/final.pdf',
      };
    },
  };
  const result = await tool('scholar_download').execute({
    url: 'https://publisher.example/paper.pdf', saveAs: 'must-not-be-copied.pdf',
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, pdfPath);
  assert.equal(result.filename, 'already-downloaded.pdf');
  assert.equal(result.size, bytes.length);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.via, 'download');
  assert.equal(result.sourceUrl, 'https://publisher.example/final.pdf');
  assert.deepEqual(await readFile(pdfPath), bytes);
  assert.deepEqual(await readdir(directory), ['already-downloaded.pdf']);
  assert.deepEqual(calls, [
    'ensure',
    { url: 'https://publisher.example/paper.pdf', options: { timeoutMs: 90000 } },
  ]);
});

// Run: node --test scripts/security-tools.test.mjs
