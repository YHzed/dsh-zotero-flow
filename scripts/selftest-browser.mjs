/**
 * 自检：浏览器会话 + CDP PDF 抓取。
 * 用一个本地 HTTP 服务提供最小 PDF，完全不依赖外网，先证明链路通。
 *
 *   node scripts/selftest-browser.mjs
 */

import { createServer } from 'node:http';
import { createBrowserSession } from '../lib/browser.js';

/** 一个结构合法的最小 PDF（单页，内容为 "dsh-zotero-flow selftest"）。 */
function minimalPdf(text) {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${text.length + 40} >>\nstream\nBT /F1 14 Tf 20 60 Td (${text}) Tj ET\nendstream\nendobj\n`,
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
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const PORT = 8899;
const pdfBytes = minimalPdf('dsh-zotero-flow selftest');

const server = createServer((request, response) => {
  if (request.url === '/paper.pdf') {
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdfBytes.length });
    response.end(pdfBytes);
    return;
  }
  if (request.url === '/landing') {
    const html = `<!doctype html><html><head><title>Selftest Landing</title>
      <meta name="citation_title" content="A Selftest Paper">
      <meta name="citation_doi" content="10.1234/selftest.2026.001">
      <meta name="citation_journal_title" content="Journal of Selftests">
      <meta name="citation_publication_date" content="2026/01/02">
      <meta name="citation_author" content="Ada Lovelace">
      <meta name="citation_pdf_url" content="http://127.0.0.1:${PORT}/paper.pdf">
      </head><body><h1>A Selftest Paper</h1>
      <a href="/paper.pdf">Download PDF</a>
      <p>Institutional access available.</p></body></html>`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }
  response.writeHead(404, { 'Content-Type': 'text/plain' });
  response.end('not found');
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
console.log(`[selftest] 本地服务已启动 http://127.0.0.1:${PORT}`);

const session = createBrowserSession({});
const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

try {
  const info = await session.ensure();
  check('浏览器启动 + CDP 连接', true, `${info.browser} @ port ${info.cdpPort}`);
  check('独立资料目录', typeof info.profileDir === 'string' && info.profileDir !== '', info.profileDir);

  const page = await session.open(`http://127.0.0.1:${PORT}/landing`, { waitMs: 400 });
  check('打开落地页', page.url.includes('/landing'), page.url);
  check('读到 citation_pdf_url', page.citationPdfUrl === `http://127.0.0.1:${PORT}/paper.pdf`, String(page.citationPdfUrl));
  check('读到 citation_doi', page.doi === '10.1234/selftest.2026.001', String(page.doi));
  check('读到期刊名', page.journal === 'Journal of Selftests', String(page.journal));
  check('识别出 PDF 链接', page.pdfLinks.some((link) => link.url.includes('/paper.pdf')), `共 ${page.pdfLinks.length} 条`);

  const captured = await session.capturePdf(`http://127.0.0.1:${PORT}/paper.pdf`, { timeoutMs: 25000 });
  if (captured.error) {
    check('抓取 PDF 响应体', false, captured.error);
  } else {
    const head = captured.bytes.subarray(0, 5).toString('latin1');
    check('抓取 PDF 响应体', head === '%PDF-', `${captured.bytes.length} 字节, mime=${captured.mimeType}`);
    check('字节与源文件一致', Buffer.compare(captured.bytes, pdfBytes) === 0, '');
  }

  await session.close();
} catch (error) {
  check('未捕获异常', false, error.stack ?? error.message);
} finally {
  server.close();
}

console.log(`\n[selftest] ${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
