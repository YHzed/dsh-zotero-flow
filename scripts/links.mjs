/**
 * 在已登录的机构会话里导出一个页面的链接/handler，用来摸清机构代理的 URL 改写形式。
 *
 *   node scripts/links.mjs <url> [filter] [limit]
 */

import { createBrowserSession } from '../lib/browser.js';

const [, , url, filter = '', limit = '40'] = process.argv;
if (!url) {
  console.error('用法：node scripts/links.mjs <url> [filter] [limit]');
  process.exit(1);
}

const session = createBrowserSession({});
try {
  const page = await session.open(url, { waitMs: 5000 });
  console.log(`页面：${page.title}  ${page.url}`);

  const raw = await session.evaluate(page.sessionId, `JSON.stringify(
    Array.from(document.querySelectorAll('a[href], a[onclick], [onclick]')).map(el => ({
      href: el.getAttribute('href') || '',
      onclick: (el.getAttribute('onclick') || '').slice(0, 220),
      text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
      resolved: el.href || ''
    }))
  )`);

  const items = JSON.parse(raw ?? '[]');
  const needle = filter.toLowerCase();
  let shown = 0;
  const seen = new Set();
  for (const item of items) {
    const blob = `${item.text} ${item.href} ${item.resolved} ${item.onclick}`.toLowerCase();
    if (needle !== '' && !blob.includes(needle)) continue;
    const line = `${item.text || '(无文字)'}\n    href=${item.href}\n    onclick=${item.onclick}`;
    if (seen.has(line)) continue;
    seen.add(line);
    console.log(`- ${line}`);
    if (++shown >= Number(limit)) break;
  }
  console.log(`（共 ${items.length} 个链接节点，显示 ${shown} 个）`);
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
} finally {
  await session.close();
}
