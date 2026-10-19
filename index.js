/**
 * dsh-zotero-flow —— DSH Desktop 插件入口。
 *
 * 给 agent 装上「在机构登录下取文献全文，并归档进 Zotero 分类」这条能力：
 *   · Zotero 通道：走 Zotero 桌面端自带的连接器 HTTP 服务（默认开启），
 *     需要读全部分类树/检索库内条目时再用它的本地 API。
 *   · 全文通道：一个专属资料目录的 Edge/Chrome，用户在里头登录学校
 *     SSO / CARSI / WebVPN，之后的抓取都复用这份登录态。
 *
 * 本文件只做装配：注册工具、注入系统提示、发布技能。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildTools, createRuntime } from './lib/tools.js';

export const name = 'dsh-zotero-flow';

/** 必须拿到工具注册表；其余服务（技能、系统提示）按可用性可选接入。 */
export const inject = ['tools'];

const SKILL_NAME = 'zotero-literature-flow';

const SYSTEM_PROMPT = `## Zotero 文献获取（dsh-zotero-flow）

用户说「下载这篇文献 / 找全文 / 存到 Zotero / 归到某个分类 / 从知网或 IEEE 取 PDF」时，走这条流水线：

1. **zotero_status** —— 先体检。确认 Zotero 在跑、当前归档目标是什么、机构登录浏览器是否已启动。缺哪一步就先补哪一步。
2. **literature_lookup** —— 用 DOI / 标题 / arXiv 号解析规范元数据，并拿开放获取 PDF 直链。有 DOI 就一定先查，别凭记忆写标题和作者。
3. **scholar_session** —— 需要机构订阅时，用 action=start 启动登录窗口，请用户完成学校登录；再用 action=goto 打开 DOI 落地页或目标数据库，读回 citation_pdf_url 与页面上的 PDF 链接。
4. **scholar_download** —— 在同一个已登录会话里把 PDF 抓到本地。拿到 PDF 直链就传 url；只能人工点击的库（知网、万方、ProQuest）让用户点完下载，再不带 url 调用一次接管下载目录。
5. **zotero_save / zotero_import_pdf** —— 元数据 + PDF 一次性归档到指定分类。
   · 手上是 DOI 或在线 PDF → zotero_save
   · 手上是刚下载的本地 PDF → zotero_import_pdf（它会自己从 PDF 里抠 DOI）

必须遵守的几条：

- **全文权限来自用户的机构会话，不来自插件的 HTTP 请求。** 直接从 Node 里 fetch 出版社页面通常只会拿到付费墙或登录页；要取全文就必须走 scholar_session / scholar_download。
- **Zotero 连接器只能把条目归档到「Zotero 当前选中的分类」或「最近使用过的分类」。** zotero_save 的 collection 参数传名字或 L1/C12 这类目标 id；如果目标不在可选范围里，让用户先在 Zotero 左侧点选那个分类，再重试 —— 不要编一个分类 id。
- **中文库（知网、万方、ProQuest 学位论文、科学文库、读秀）基本没有可自动下载的 PDF 直链。** 正确做法是 scholar_session 打开检索页，请用户点「下载全文」，再用 scholar_download 接管下载目录，最后 zotero_import_pdf。
- **不要自己拼检索 URL。** 各站的检索查询串形式不一致，猜出来的链接会 404 或落到空结果。用 library_sites 给出的链接，或直接用 DOI 落地页。
- **不要重复下载。** 先看 scholar_download 返回的本地路径是否已经有这份 PDF（同一个 DOI/file 名），有就直接进 zotero_import_pdf。
- **归档失败要如实说。** 条目建成但 PDF 没挂上时，明确告诉用户「条目已入库、PDF 未附上」以及原因，不要含糊成「已完成」。`;

function readSkillContent() {
  try {
    const skillPath = fileURLToPath(new URL('./skills/literature-flow/SKILL.md', import.meta.url));
    const text = readFileSync(skillPath, 'utf8').trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

const SKILL_FALLBACK = `# Zotero 文献流

检索 → 机构登录会话取全文 → 归档到 Zotero 分类。

- 用 literature_lookup 拿规范元数据，别凭记忆写书目字段。
- 出版社全文必须走 scholar_session / scholar_download（用户的机构登录态在那里）。
- 知网、万方、ProQuest 这类只能人工点击下载，之后用 scholar_download 接管下载目录。
- Zotero 连接器只能归档到「当前选中」或「最近使用」的分类；目标不在其中就先让用户在 Zotero 里点选。
- 条目建好但 PDF 没挂上时，如实说明，不要含糊成「已完成」。`;

function registerTools(ctx, config) {
  const runtime = createRuntime(config);
  const disposers = [];
  for (const definition of buildTools(runtime)) {
    const disposer = ctx.tools.register(definition);
    if (typeof disposer === 'function') disposers.push(disposer);
  }
  return () => {
    for (const disposer of disposers) {
      try {
        disposer();
      } catch { /* 已经被上层 effect 回收 */ }
    }
    // 关掉 CDP WebSocket，别让插件卸载后还留着一个连接。
    // 浏览器窗口本身不关：用户的机构登录态要保留。
    runtime.browser.close();
  };
}

export function apply(ctx, config) {
  const effectiveConfig = config ?? {};

  ctx.effect(() => registerTools(ctx, effectiveConfig));

  // 技能与系统提示都是可选服务：没有它们插件照样能用，只是少一层引导。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillsCtx) => {
      skillsCtx.effect(() => skillsCtx.skills.register({
        name: SKILL_NAME,
        description: '把文献全文下载并按分类归档进 Zotero：元数据解析、机构登录会话取 PDF、分类定位与如实报告失败。用户提到 Zotero、知网/万方/IEEE/ScienceDirect 取全文、文献归档时使用。',
        content: readSkillContent() ?? SKILL_FALLBACK,
        invocation: { modelInvocable: true, userInvocable: true },
      }));
    });

    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.effect(() => promptCtx.systemPrompt.section({
        name: 'plugin:dsh-zotero-flow',
        order: 450,
        text: SYSTEM_PROMPT,
      }));
    });
  } else if (ctx.skills !== undefined) {
    ctx.skills.register({
      name: SKILL_NAME,
      description: '把文献全文下载并按分类归档进 Zotero。',
      content: readSkillContent() ?? SKILL_FALLBACK,
    });
  }
}
