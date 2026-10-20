import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildTools } from '../lib/tools.js';
import { selectImportParent } from '../lib/dedup.js';
import { createZoteroClient } from '../lib/zotero.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-dedup-test-'));
const pdfPath = path.join(dir, 'paper.pdf');
const bytes = Buffer.from('%PDF-1.7\nno metadata\n%%EOF');
await writeFile(pdfPath, bytes);
const title = 'A sufficiently descriptive exact scientific title';
const parent = { key: 'ABCDEFGH', itemType: 'journalArticle', title, DOI: '10.1234/example', collections: ['OLD'] };
let tests = 0;
function runtime({ items = [], attachments = [], incomplete = false, searchError, attachError, attachDuplicate = false } = {}) {
  const calls = [];
  const rt = { config: {}, browser: { capturePdf: async () => ({ bytes, finalUrl: 'https://example.org/paper.pdf' }) },
    http: { json: async () => undefined }, zotero: {
      findImportCandidates: async () => { calls.push('search'); if (searchError) throw searchError; return { complete: !incomplete, items, attachments }; },
      getTargets: async () => { calls.push('targets'); return {}; },
      resolveTarget: () => ({ name: 'New', targetId: 'C1', source: 'current' }), targetsOf: () => [],
      saveItem: async () => { calls.push('saveItem'); return { sessionId: 's', itemKey: 'dsh-item-1' }; },
      updateSession: async () => { calls.push('updateSession'); },
      attachPdf: async () => { calls.push('attachPdf'); if (attachError) throw attachError; },
      attachExistingPdf: async () => { calls.push('attachExisting'); if (attachError) throw attachError; return { attached: true, duplicate: attachDuplicate, attachmentKey: 'BCDEFGHJ' }; },
      saveStandalonePdf: async () => { calls.push('standalone'); return { sessionId: 's' }; },
    } };
  rt.calls = calls;
  return rt;
}
function tool(rt, name) { return buildTools(rt).find(tool => tool.name === name); }
// Avoid network: DOI requests fall back to manual fields through this mock HTTP response.
function prepare(rt) {
  rt.http = { json: async () => undefined, get: async () => ({ ok: false, status: 404, json: async () => ({}) }) };
  return rt;
}
try {
  for (const name of ['zotero_save', 'zotero_import_pdf']) {
    const args = name === 'zotero_save' ? { title, pdfPath, fetchOpenAccess: false } : { pdfPath, title };
    for (const options of [{ items: [parent] }, { items: [parent], attachDuplicate: true }, { incomplete: true }, { searchError: new Error('search failed') }, { items: [parent], attachError: new Error('attach failed') }, { items: [parent, { ...parent, key: 'BCDEFGHJ' }] }]) {
      const rt = prepare(runtime(options));
      try {
        const value = await tool(rt, name).execute(args);
        assert.equal(value.action, options.attachDuplicate ? 'duplicate' : 'reused');
        assert.equal(value.parentItemKey, parent.key);
        assert.equal(value.target.preserved, true);
        assert(!value.text.includes('undefined'));
      } catch (error) {
        if (!options.incomplete && !options.searchError && !options.attachError && options.items?.length !== 2) throw error;
      }
      assert(!rt.calls.includes('saveItem'));
      assert(!rt.calls.includes('updateSession'));
      assert(!rt.calls.includes('standalone'));
      tests++;
    }
  }
  const rt = prepare(runtime({ attachments: [{ key: 'BCDEFGHJ', itemType: 'attachment', md5: createHash('md5').update(bytes).digest('hex') }] }));
  const duplicate = await tool(rt, 'zotero_import_pdf').execute({ pdfPath });
  assert.equal(duplicate.action, 'duplicate'); assert(!rt.calls.includes('standalone')); tests++;
  const empty = prepare(runtime());
  const standalone = await tool(empty, 'zotero_import_pdf').execute({ pdfPath });
  assert.equal(standalone.mode, 'standalone'); assert.deepEqual(empty.calls, ['search', 'targets', 'standalone']); tests++;
  const invalidPath = path.join(dir, 'invalid.pdf'); await writeFile(invalidPath, 'not PDF');
  for (const name of ['zotero_save', 'zotero_import_pdf']) {
    const invalid = prepare(runtime());
    await assert.rejects(tool(invalid, name).execute({ title, pdfPath: invalidPath }), /PDF/);
    assert(!invalid.calls.includes('saveItem')); tests++;
  }
  assert.equal(selectImportParent([parent], { doi: 'https://doi.org/10.1234/EXAMPLE' }).item.key, parent.key);
  assert.throws(() => selectImportParent([parent], { doi: '10.1234/other', title }), /conflicting DOI/);
  for (const name of ['zotero_save', 'zotero_import_pdf']) {
    const conflict = prepare(runtime({ items: [parent], attachments: [{ key: 'BCDEFGHJ', parentItem: 'CDEFGHJK', md5: createHash('md5').update(bytes).digest('hex') }] }));
    await assert.rejects(tool(conflict, name).execute({ title, pdfPath, ...(name === 'zotero_save' ? { fetchOpenAccess: false } : {}) }), /different or standalone/);
    assert.deepEqual(conflict.calls, ['search']); tests++;
  }
  assert.throws(() => selectImportParent([{ ...parent, DOI: '', title: 'Methods' }], { title: 'Methods' }), /too short/); tests++;
  for (const entry of ['pdfPath', 'pdfUrl']) {
    const fresh = prepare(runtime());
    const value = await tool(fresh, 'zotero_save').execute({ title, [entry]: entry === 'pdfPath' ? pdfPath : 'https://example.org/paper.pdf', fetchOpenAccess: false });
    assert.equal(value.action, 'new'); assert.equal(value.parentItemKey, '');
    assert.deepEqual(fresh.calls, ['search', 'targets', 'saveItem', 'updateSession', 'attachPdf']); tests++;
    const failed = prepare(runtime({ attachError: new Error('upload failed') }));
    await assert.rejects(tool(failed, 'zotero_save').execute({ title, [entry]: entry === 'pdfPath' ? pdfPath : 'https://example.org/paper.pdf', fetchOpenAccess: false }), /条目已入库、PDF 未附上/);
    assert.equal(failed.calls.filter(call => call === 'saveItem').length, 1); tests++;
  }
  const concurrent = prepare(runtime());
  let active = 0; let peak = 0;
  concurrent.zotero.findImportCandidates = async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return { complete: true, items: [parent], attachments: [] };
  };
  await Promise.all(['zotero_save', 'zotero_import_pdf'].map(name => tool(concurrent, name).execute({ title, pdfPath, ...(name === 'zotero_save' ? { fetchOpenAccess: false } : {}) })));
  assert.equal(peak, 1); tests++;
  // Full-scan pagination reaches candidates past the first 100, detects changed libraries.
  const originalFetch = globalThis.fetch;
  try {
    for (const changed of [false, true]) {
      const urls = [];
      globalThis.fetch = async url => {
        urls.push(String(url));
        if (!String(url).includes('format=json')) return new Response('[]');
        const start = Number(new URL(url).searchParams.get('start'));
        const rows = start === 0 ? Array.from({ length: 100 }, (_, i) => ({ key: `AAAAAA${'ABCDEFGHJK'[Math.floor(i / 10)]}${'ABCDEFGHJK'[i % 10]}`, data: { itemType: 'journalArticle', title: `row ${i}` } })) : [{ key: parent.key, data: parent }];
        return new Response(JSON.stringify(rows), { headers: { 'Last-Modified-Version': changed && start ? '2' : '1', 'Total-Results': '101' } });
      };
      const client = createZoteroClient();
      if (changed) await assert.rejects(client.findImportCandidates({ title }), /changed/);
      else { const scan = await client.findImportCandidates({ title }); assert.equal(scan.items.length, 101); assert(scan.complete); }
      assert(urls.some(url => url.includes('start=100'))); tests++;
    }
  } finally { globalThis.fetch = originalFetch; }
  console.log(`Import dedup integration checks passed (${tests} cases); no real library writes.`);
} finally { await rm(dir, { recursive: true, force: true }); }
