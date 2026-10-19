/**
 * 读**已打开的**资源门户标签页，导出门户里的资源链接与其改写地址。
 * 不新开标签页，避免刚登录的会话被新标签打断。
 *
 *   node scripts/probe-portal.mjs [urlSubstring] [limit]
 */

import { createBrowserSession } from '../lib/browser.js';

const [, , urlSubstring = 'webvpn', limit = '30'] = process.argv;

const session = createBrowserSession({});

try {
  const tabs = await session.listTabs();
  const match = tabs.find((tab) => tab.url.includes(urlSubstring));
  if (match === undefined) {
    console.log('没找到匹配的标签页。当前标签页：');
    for (const tab of tabs) console.log(`- ${tab.title}  ${tab.url.slice(0, 120)}`);
    process.exit(1);
  }
  console.log(`目标标签页：${match.title}\n  ${match.url}`);

  const page = await session.analyzeExisting(match.id);
  console.log(`重读出：${page.title}  ${page.url}`);

  const raw = await session.evaluate(page.sessionId, `JSON.stringify(
    Array.from(document.querySelectorAll('a, [onclick], [data-url], [data-href], [data-href-url]')).map(el => ({
      t: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 28),
      h: (el.getAttribute && (el.getAttribute('href') || '')) || '',
      o: ((el.getAttribute && (el.getAttribute('onclick') || el.getAttribute('data-url') || el.getAttribute('data-href'))) || '').slice(0, 300),
    })).filter(x => /https?:|wrd|\\/https\\//i.test(x.h + x.o))
  )`);

  const items = JSON.parse(raw ?? '[]');
  const seen = new Set();
  let shown = 0;
  for (const item of items) {
    const key = `${item.t}|${item.h}|${item.o}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`- [${item.t}]\n    href=${item.h}\n    onclick=${item.o}`);
    if (++shown >= Number(limit)) break;
  }
  console.log(`（命中 ${items.length} 个节点，显示 ${shown} 个）`);
} catch (error) {
  console.error(`错误：${error.message}`);
} finally {
  await session.close();
}
