/**
 * 写库自检：真的往 Zotero 里存一条**带明确测试标记**的条目 + 一个 PDF。
 *
 * 会写入用户库：
 *   标题  【插件自检请删除】dsh-zotero-flow verify
 *   标签  dsh-zotero-flow-selftest
 *   分类  参数指定（默认 L1 我的文库）
 *
 *   node scripts/test-zotero-write.mjs [target]
 * 完成后请在 Zotero 里搜 “插件自检” 删掉它。
 */

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { buildTools, createRuntime } from '../lib/tools.js';

/** 内容里带 DOI 的最小 PDF，用来同时验证「PDF 里的 DOI 抽取」链路。 */
function testPdf(doi, title) {
  const text = `dsh-zotero-flow selftest DOI:${doi} title:${title}`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 140] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${text.length + 40} >>\nstream\nBT /F1 11 Tf 20 70 Td (${text}) Tj ET\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const target = process.argv[2] ?? 'L1';
const DOI = '10.1038/nature12373';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

const runtime = createRuntime({});
const tools = new Map(buildTools(runtime).map((tool) => [tool.name, tool]));

async function run(name, args) {
  const tool = tools.get(name);
  const value = await tool.execute(args, {});
  // 顺带验证 output.schema：返回的字段必须都在 schema 里，且必填字段都在
  const schema = tool.output.schema;
  const allowed = new Set(Object.keys(schema.properties ?? {}));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = (schema.required ?? []).filter((key) => value[key] === undefined);
  check(`${name} 输出符合 schema`, extra.length === 0 && missing.length === 0,
    [extra.length ? `多余字段 ${extra.join(',')}` : '', missing.length ? `缺必填 ${missing.join(',')}` : ''].filter(Boolean).join('；'));
  console.log(tool.output.render(args, value)[0].text);
  return value;
}

// 准备一个带 DOI 的测试 PDF
const pdfDir = path.join(homedir(), '.dsh-zotero-flow', 'downloads');
await mkdir(pdfDir, { recursive: true });
const pdfPath = path.join(pdfDir, 'dsh-zotero-flow-selftest.pdf');
await writeFile(pdfPath, testPdf(DOI, 'selftest'));

console.log(`\n=== 1) zotero_save：DOI + 本地 PDF → ${target} ===\n`);
const saved = await run('zotero_save', {
  doi: DOI,
  pdfPath,
  collection: target,
  tags: ['dsh-zotero-flow-selftest'],
  note: '这条由 dsh-zotero-flow 插件自检写入，可以直接删除。',
  fetchOpenAccess: false,
});
check('条目已保存', saved.saved === true, JSON.stringify(saved.target));
check('元数据命中 DOI', saved.item?.doi === DOI, String(saved.item?.doi));
check('PDF 已挂载', saved.pdf?.saved === true, `${saved.pdf?.filename ?? ''} ${saved.pdf?.size ?? 0} 字节`);

console.log('\n=== 2) zotero_import_pdf：从 PDF 里抠 DOI 再归档 ===\n');
const imported = await run('zotero_import_pdf', {
  pdfPath,
  collection: target,
  tags: ['dsh-zotero-flow-selftest'],
});
check('导入模式为 doi', imported.mode === 'doi', imported.mode);
check('导入条目带 DOI', imported.item?.doi === DOI, String(imported.item?.doi));

console.log(`\n[test-zotero-write] ${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
console.log('已在 Zotero 里写入测试条目，请搜索 “插件自检” 或标签 dsh-zotero-flow-selftest 删除。');
process.exit(failed === 0 ? 0 : 1);
