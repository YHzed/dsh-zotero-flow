import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { webUrl, readPdfFile, assertPdf, boundedMs, validPort, cdpSocketUrl, MAX_PDF_BYTES } from '../lib/safety.js';

test('URL boundary rejects non-web, credentials, private literals and ambiguous input', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,a',
    'https://a:b@example.org/', 'http://localhost/', 'http://127.1/', 'http://0x7f000001/',
    'http://2130706433/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/', 'https://example.org/\n']) {
    assert.throws(() => webUrl(url), undefined, url);
  }
  assert.equal(webUrl('https://doi.org/10.1/test'), 'https://doi.org/10.1/test');
  assert.equal(webUrl('https://webvpn.example.edu.cn/'), 'https://webvpn.example.edu.cn/');
});

test('timeout/port/CDP validation is finite and local', () => {
  for (const value of [-1, NaN, Infinity, 180001, '100']) assert.throws(() => boundedMs(value, 10));
  assert.equal(boundedMs(undefined, 90000), 90000);
  for (const value of [0, 65536, 2.5, '9333']) assert.throws(() => validPort(value));
  assert.equal(validPort(9333), 9333);
  assert.equal(cdpSocketUrl('ws://127.0.0.1:9333/devtools/browser/a', 9333), 'ws://127.0.0.1:9333/devtools/browser/a');
  for (const value of ['ws://example.org:9333/devtools/browser/a', 'ws://127.0.0.1:9999/devtools/browser/a', 'wss://127.0.0.1:9333/devtools/browser/a']) {
    assert.throws(() => cdpSocketUrl(value, 9333));
  }
});

test('local import validates regular file, signature and pre-read size', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zotero-safety-'));
  try {
    const pdf = path.join(root, 'valid.pdf');
    await writeFile(pdf, '%PDF-1.7\nfixture');
    assert.equal((await readPdfFile(pdf)).subarray(0, 5).toString(), '%PDF-');
    const html = path.join(root, 'invalid.pdf');
    await writeFile(html, '<html>login</html>');
    await assert.rejects(readPdfFile(html));
    await assert.rejects(readPdfFile(root));
    await assert.rejects(readPdfFile('relative.pdf'));
    await truncate(pdf, MAX_PDF_BYTES + 1);
    await assert.rejects(readPdfFile(pdf), /128 MiB/);
    assert.throws(() => assertPdf(Buffer.from('HTML!')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
