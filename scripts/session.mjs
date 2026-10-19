/**
 * 手动驱动机构登录会话的小命令行，用来在真实环境里逐段验证链路。
 * 它和插件工具走的是同一份 lib/browser.js。
 *
 *   node scripts/session.mjs start
 *   node scripts/session.mjs goto <url> [--wait 5000]
 *   node scripts/session.mjs download <url> [--timeout 90000]
 *   node scripts/session.mjs watch [--timeout 180000]
 *   node scripts/session.mjs status
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createBrowserSession } from '../lib/browser.js';

const [, , command, ...rest] = process.argv;
const flags = new Map();
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, 'true');
    }
  } else {
    positional.push(rest[i]);
  }
}

const session = createBrowserSession({});
const info = session.paths;

function describePage(page) {
  const lines = [];
  lines.push(`标题：${page.title || '(无标题)'}`);
  lines.push(`地址：${page.url}`);
  lines.push(`内容类型：${page.contentType || '(未知)'}`);
  if (page.doi) lines.push(`引文 DOI：${page.doi}`);
  if (page.journal) lines.push(`期刊：${page.journal}`);
  if (page.date) lines.push(`日期：${page.date}`);
  if (page.citationPdfUrl) lines.push(`★ citation_pdf_url：${page.citationPdfUrl}`);
  if (page.loginHints.length > 0) lines.push(`页面迹象：${page.loginHints.join('、')}`);
  if (page.pdfLinks.length > 0) {
    lines.push(`PDF 相关链接（${page.pdfLinks.length}）：`);
    for (const link of page.pdfLinks.slice(0, 10)) {
      lines.push(`  - ${link.url}${link.text ? `  「${link.text}」` : ''}`);
    }
  }
  if (page.bodyPreview) lines.push(`正文预览：${page.bodyPreview.replace(/\s+/g, ' ').slice(0, 220)}`);
  return lines.join('\n');
}

try {
  if (command === 'start') {
    const started = await session.ensure();
    console.log(`浏览器：${started.browser}`);
    console.log(`CDP 端口：${started.cdpPort}`);
    console.log(`资料目录：${started.profileDir}`);
    console.log(`下载目录：${started.downloadDir}`);
  } else if (command === 'status') {
    const status = await session.status();
    console.log(JSON.stringify(status, null, 1));
  } else if (command === 'goto') {
    const url = positional[0];
    if (!url) throw new Error('goto 需要 url');
    const page = await session.open(url, { waitMs: Number(flags.get('wait') ?? 5000) });
    console.log(describePage(page));
  } else if (command === 'download') {
    const url = positional[0];
    if (!url) throw new Error('download 需要 url');
    const timeout = Number(flags.get('timeout') ?? 90000);
    console.log(`开始抓取：${url}（最多 ${timeout / 1000} 秒）`);
    const result = await session.capturePdf(url, { timeoutMs: timeout });
    if (result.error !== undefined && result.bytes === undefined) {
      console.log(`失败：${result.error}`);
      if (result.page) console.log(describePage({ loginHints: [], pdfLinks: [], ...result.page }));
      process.exitCode = 2;
    } else {
      await mkdir(info.downloadDir, { recursive: true });
      const name = flags.get('name') ?? `download-${Date.now()}.pdf`;
      const target = path.join(info.downloadDir, name);
      await writeFile(target, result.bytes);
      console.log(`成功：通道 ${result.via}，${result.bytes.length} 字节`);
      console.log(`落盘：${target}`);
      console.log(`文件头：${result.bytes.subarray(0, 8).toString('latin1')}`);
    }
  } else if (command === 'watch') {
    const timeout = Number(flags.get('timeout') ?? 180000);
    console.log(`监视下载目录 ${info.downloadDir} 与系统下载目录，最多 ${timeout / 1000} 秒…`);
    const found = await session.waitForDownload({ since: Date.now() - 1500, timeoutMs: timeout });
    if (found === undefined) {
      console.log('没有发现新的 PDF');
      process.exitCode = 2;
    } else {
      const bytes = await readFile(found.path);
      console.log(`接管成功：${found.path}（${found.size} 字节）`);
      console.log(`文件头：${bytes.subarray(0, 8).toString('latin1')}`);
    }
  } else {
    console.log('用法：node scripts/session.mjs <start|status|goto|download|watch> [args]');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
} finally {
  await session.close();
}
