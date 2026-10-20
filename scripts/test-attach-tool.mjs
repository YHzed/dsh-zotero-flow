import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTools } from '../lib/tools.js';

const tool = rt => buildTools(rt).find(t => t.name === 'zotero_attach_pdf');
test('existing attachment tool reads local PDF, passes correct key and never creates parent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-attach-'));
  try {
    const pdfPath = path.join(dir, '中文.pdf');
    await writeFile(pdfPath, '%PDF-1.7\ntest');
    let calls = 0;
    const rt = { zotero: { async attachExistingPdf(args) {
      calls++; assert.equal(args.parentItemKey, 'ABCD1234');
      assert.equal(args.filename, '中文.pdf');
      return { attached: true, duplicate: false, attachmentKey: 'FILE1234' };
    } } };
    const out = await tool(rt).execute({ itemKey: 'ABCD1234', pdfPath });
    assert.equal(out.attached, true); assert.equal(calls, 1);
    rt.zotero.attachExistingPdf = async () => { const e = new Error('upload failed'); e.detail = { attachmentKey: 'FILE1234' }; throw e; };
    const fail = await tool(rt).execute({ itemKey: 'ABCD1234', pdfPath });
    assert.equal(fail.attached, false); assert.equal(fail.attachmentKey, 'FILE1234');
    await writeFile(pdfPath, '<html>not pdf');
    await assert.rejects(tool(rt).execute({ itemKey: 'ABCD1234', pdfPath }), /%PDF-/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('search exposes actual keys and errors instead of selecting ambiguous candidates', async () => {
  const search = buildTools({ zotero: { searchItems: async () => ({ items: [{ key: 'ABCD1234', title: 'one' }, { key: 'ABCD5678', title: 'two' }] }) } }).find(t => t.name === 'zotero_search');
  const out = await search.execute({ query: 'test' });
  assert.equal(out.items.length, 2); assert.match(out.text, /ABCD1234/); assert.match(out.text, /ABCD5678/);
});
