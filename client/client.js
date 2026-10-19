/**
 * 浏览器端 Toolview。
 *
 * 只做一件事：把 Node 端写进 tool result 持久化 meta 的结构化数据，渲染成
 * 用户直接能看的卡片。不订阅会话、不读 DOM、不碰其它插件的东西。
 *
 * 约定：
 *   · 每个工具一个 keyed 注册，key 就是工具名；
 *   · 样式只用 --dsw-alias-* 主题变量（都带兜底值），所以明暗主题都不塌；
 *   · 结果缺失或格式不对时降级成一行文本，绝不空屏。
 */

window.__ModuleLoader__.load({
  id: 'dsh-zotero-flow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const CSS = `
.zf-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.22));
  background: var(--dsw-alias-bg-base, rgba(127,127,127,0.05));
  color: var(--dsw-alias-text-primary, inherit);
  font-size: 13px; line-height: 1.5;
}
.zf-head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.zf-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.zf-dot.ok { background: #2f9e63; }
.zf-dot.warn { background: #d99a1f; }
.zf-dot.bad { background: #c8452f; }
.zf-dot.idle { background: rgba(127,127,127,0.5); }
.zf-sub { color: var(--dsw-alias-text-secondary, rgba(127,127,127,0.95)); font-size: 12px; }
.zf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }
.zf-site {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.18));
  background: var(--dsw-alias-bg-elevated, rgba(127,127,127,0.04));
}
.zf-avatar {
  width: 28px; height: 28px; border-radius: 50%; flex: none;
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 13px; font-weight: 700;
}
.zf-site-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zf-site-host { font-size: 11px; color: var(--dsw-alias-text-secondary, rgba(127,127,127,0.95)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zf-badge {
  display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.28));
  color: var(--dsw-alias-text-secondary, rgba(127,127,127,0.95));
  margin-right: 4px;
}
.zf-badge.auto { color: #2f9e63; border-color: rgba(47,158,99,0.45); }
.zf-badge.manual { color: #d99a1f; border-color: rgba(217,154,31,0.45); }
.zf-row { display: flex; gap: 8px; align-items: baseline; }
.zf-k { color: var(--dsw-alias-text-secondary, rgba(127,127,127,0.95)); flex: none; min-width: 62px; font-size: 12px; }
.zf-v { word-break: break-all; }
.zf-item { padding: 7px 9px; border-radius: 7px; background: var(--dsw-alias-bg-elevated, rgba(127,127,127,0.05)); }
.zf-item + .zf-item { margin-top: 6px; }
.zf-title { font-weight: 600; }
.zf-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; word-break: break-all; }
.zf-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.zf-warn { color: #d99a1f; font-size: 12px; }
.zf-fallback { font-size: 12px; color: var(--dsw-alias-text-secondary, rgba(127,127,127,0.95)); }
`;

    /** 结果块的持久化 meta；没有或格式不对就返回 undefined。 */
    function metaOf(block) {
      if (block === null || typeof block !== 'object') return undefined;
      const meta = block.meta;
      if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
      return meta;
    }

    /** 结果文本首行，用于降级展示。 */
    function firstLine(block) {
      const content = block && Array.isArray(block.content) ? block.content : [];
      for (const part of content) {
        if (part && part.type === 'text' && typeof part.text === 'string' && part.text !== '') {
          const newline = part.text.indexOf('\n');
          return newline === -1 ? part.text : part.text.slice(0, newline);
        }
      }
      return '没有可展示的结果';
    }

    function Shell({ block, title, tone, children, footer }) {
      return h('div', { className: 'zf-card' },
        h('style', null, CSS),
        h('div', { className: 'zf-head' },
          h('span', { className: `zf-dot ${tone}` }),
          h('span', null, title),
        ),
        children,
        footer ? h('div', { className: 'zf-sub' }, footer) : null,
      );
    }

    function Row({ label, children }) {
      return h('div', { className: 'zf-row' },
        h('span', { className: 'zf-k' }, label),
        h('span', { className: 'zf-v' }, children),
      );
    }

    function Wrap({ callId, block, title, pick }) {
      if (!block || typeof block !== 'object' || !('kind' in block)) {
        return h('div', { key: callId, className: 'zf-fallback' }, `⏳ ${title} …`);
      }
      if (block.isError) {
        return h('div', { key: callId, className: 'zf-fallback' }, `⚠️ ${firstLine(block)}`);
      }
      const meta = metaOf(block);
      if (meta === undefined) {
        return h('div', { key: callId, className: 'zf-fallback' }, firstLine(block));
      }
      try {
        return h('div', { key: callId }, pick(meta));
      } catch (error) {
        return h('div', { key: callId, className: 'zf-fallback' }, firstLine(block));
      }
    }

    function toneOf(value) {
      return value ? 'ok' : 'bad';
    }

    /* ---------------- 各工具的卡片 ---------------- */

    function StatusView({ callId, block }) {
      return h(Wrap, {
        callId,
        block,
        title: 'Zotero 体检',
        pick: (meta) => {
          const zotero = meta.zotero ?? {};
          const browser = meta.browser ?? {};
          return h(Shell, {
            title: zotero.running ? `Zotero ${zotero.version ?? ''} 已连接` : 'Zotero 未连接',
            tone: toneOf(zotero.running),
            footer: meta.current?.name ? `当前归档目标：${meta.current.name}` : undefined,
          },
            h(Row, { label: '本地 API' }, zotero.localApiEnabled ? '已开启' : '未开启（分类树与库内检索受限）'),
            h(Row, { label: '浏览器' }, browser.running ? `${browser.browser || '已启动'} · ${browser.tabs ?? 0} 个标签页` : '未启动'),
            h(Row, { label: 'PDF 目录' }, h('span', { className: 'zf-mono' }, browser.downloadDir ?? meta.config?.downloadDir ?? '—')),
          );
        },
      });
    }

    function SitesView({ callId, block }) {
      return h(Wrap, {
        callId,
        block,
        title: '数据资源清单',
        pick: (meta) => {
          const sites = Array.isArray(meta.sites) ? meta.sites : [];
          return h(Shell, {
            title: `数据资源数据库 · ${meta.count ?? sites.length} 个`,
            tone: 'ok',
          }, h('div', { className: 'zf-grid' }, sites.map((site) => h('div', { className: 'zf-site', key: site.id },
            h('div', { className: 'zf-avatar', style: { background: site.color || '#5b6b7c' } }, (site.name || '?').slice(0, 1)),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'zf-site-name' }, site.name),
              h('div', { className: 'zf-site-host' }, site.host),
            ),
          ))),
            h('div', null,
              h('span', { className: 'zf-badge auto' }, '可自动取 PDF'),
              h('span', { className: 'zf-badge manual' }, '多需人工点击'),
              h('span', { className: 'zf-badge' }, 'JS 站点'),
            ),
          );
        },
      });
    }

    function LookupView({ callId, block }) {
      return h(Wrap, {
        callId,
        block,
        title: '文献解析',
        pick: (meta) => {
          const candidates = Array.isArray(meta.candidates) ? meta.candidates : [];
          return h(Shell, {
            title: `文献解析 · ${meta.count ?? candidates.length} 条`,
            tone: candidates.length > 0 ? 'ok' : 'warn',
            footer: meta.publisher?.siteLabel ? `推断归属：${meta.publisher.publisherLabel} → ${meta.publisher.siteLabel}` : (meta.query || undefined),
          }, candidates.slice(0, 6).map((candidate, index) => h('div', { className: 'zf-item', key: `${candidate.doi}-${index}` },
            h('div', { className: 'zf-title' }, candidate.title),
            h('div', { className: 'zf-sub' }, [candidate.authors, candidate.venue, candidate.year].filter(Boolean).join(' · ')),
            candidate.doi ? h('div', { className: 'zf-mono' }, `DOI ${candidate.doi}`) : null,
            candidate.oaPdfUrl ? h('div', { className: 'zf-mono' }, candidate.oaPdfUrl) : null,
          )));
        },
      });
    }

    function SessionView({ callId, block }) {
      return h(Wrap, {
        callId,
        block,
        title: '机构会话',
        pick: (meta) => {
          const page = meta.page ?? {};
          return h(Shell, {
            title: page.title ? `已打开：${page.title}` : `机构会话 · ${meta.action ?? ''}`,
            tone: meta.running ? 'ok' : 'warn',
            footer: page.url ?? meta.profileDir,
          },
            page.doi ? h(Row, { label: '页面 DOI' }, h('span', { className: 'zf-mono' }, page.doi)) : null,
            page.citationPdfUrl ? h(Row, { label: 'PDF 直链' }, h('span', { className: 'zf-mono' }, page.citationPdfUrl)) : null,
            Array.isArray(page.loginHints) && page.loginHints.length > 0
              ? h(Row, { label: '页面迹象' }, page.loginHints.join('、'))
              : null,
            Array.isArray(page.pdfLinks) && page.pdfLinks.length > 0
              ? h('div', { className: 'zf-tags' }, page.pdfLinks.slice(0, 4).map((link, index) => h('span', { className: 'zf-badge', key: index }, link.text || link.url.slice(0, 42))))
              : null,
          );
        },
      });
    }

    function DownloadView({ callId, block }) {
      return h(Wrap, {
        callId,
        block,
        title: '抓取 PDF',
        pick: (meta) => h(Shell, {
          title: meta.ok ? `已抓到 PDF · ${meta.filename ?? ''}` : '抓取未成功',
          tone: toneOf(meta.ok),
          footer: meta.ok ? meta.path : '可让用户在浏览器里手动下载，然后重试接管下载目录',
        },
          meta.ok ? h(Row, { label: '大小' }, `${Math.round((meta.size ?? 0) / 1024)} KB`) : null,
          meta.ok && meta.via ? h(Row, { label: '通道' }, meta.via) : null,
          meta.ok && meta.sha256 ? h(Row, { label: 'sha256' }, h('span', { className: 'zf-mono' }, `${meta.sha256.slice(0, 16)}…`)) : null,
        ),
      });
    }

    function CollectionsView({ callId, block }) {
      return h(Wrap, {
        callId,
        block,
        title: 'Zotero 分类',
        pick: (meta) => {
          const collections = Array.isArray(meta.collections) ? meta.collections : [];
          return h(Shell, {
            title: `Zotero 分类 · ${collections.length} 项`,
            tone: collections.length > 0 ? 'ok' : 'warn',
            footer: meta.current?.name ? `当前目标：${meta.current.name}（${meta.current.targetId ?? ''}）` : undefined,
          }, collections.slice(0, 24).map((collection, index) => h('div', { className: 'zf-item', key: `${collection.key}-${index}` },
            h('span', { style: { paddingLeft: `${Math.max(0, Math.min(Number(collection.level) || 0, 6)) * 12}px` } },
              collection.name || '(未命名)',
              h('span', { className: 'zf-mono' }, `  ${collection.key}`),
            ),
          )));
        },
      });
    }

    function SaveView({ callId, block }) {
      return h(Wrap, {
        callId,
        block,
        title: '归档到 Zotero',
        pick: (meta) => {
          const item = meta.item ?? {};
          const target = meta.target ?? {};
          const pdf = meta.pdf ?? {};
          const warnings = Array.isArray(meta.warnings) ? meta.warnings : [];
          return h(Shell, {
            title: meta.saved ? `已归档：${item.title ?? ''}` : '归档未完成',
            tone: meta.saved ? 'ok' : 'bad',
            footer: target.name ? `分类：${target.name}（${target.targetId ?? ''}）` : undefined,
          },
            item.doi ? h(Row, { label: 'DOI' }, h('span', { className: 'zf-mono' }, item.doi)) : null,
            h(Row, { label: 'PDF' }, pdf.saved ? `${pdf.filename ?? ''}（${Math.round((pdf.size ?? 0) / 1024)} KB，${pdf.via ?? ''}）` : '未挂载'),
            Array.isArray(meta.tags) && meta.tags.length > 0
              ? h(Row, { label: '标签' }, h('span', { className: 'zf-tags' }, meta.tags.map((tag, index) => h('span', { className: 'zf-badge', key: index }, tag))))
              : null,
            h('div', null, warnings.map((warning, index) => h('div', { className: 'zf-warn', key: index }, `注意：${warning}`))),
          );
        },
      });
    }

    function ImportView({ callId, block }) {
      return h(Wrap, {
        callId,
        block,
        title: '导入 PDF',
        pick: (meta) => {
          const item = meta.item ?? {};
          const target = meta.target ?? {};
          const warnings = Array.isArray(meta.warnings) ? meta.warnings : [];
          return h(Shell, {
            title: meta.saved ? `已归档：${item.title ?? ''}` : '导入未完成',
            tone: meta.saved ? 'ok' : 'bad',
            footer: target.name ? `分类：${target.name}（${target.targetId ?? ''}）` : undefined,
          },
            h(Row, { label: '识别方式' }, meta.mode === 'doi' ? '从 PDF 里抠到 DOI' : (meta.mode === 'standalone' ? '交给 Zotero 自动识别' : '按标题检索')),
            item.doi ? h(Row, { label: 'DOI' }, h('span', { className: 'zf-mono' }, item.doi)) : null,
            h('div', null, warnings.map((warning, index) => h('div', { className: 'zf-warn', key: index }, `注意：${warning}`))),
          );
        },
      });
    }

    const VIEWS = {
      zotero_status: StatusView,
      library_sites: SitesView,
      literature_lookup: LookupView,
      scholar_session: SessionView,
      scholar_download: DownloadView,
      zotero_collections: CollectionsView,
      zotero_save: SaveView,
      zotero_import_pdf: ImportView,
    };

    return {
      inject: ['slots'],
      apply(ctx) {
        for (const [key, View] of Object.entries(VIEWS)) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
            { name: 'tool.call.toolview', key },
            View,
          ));
        }
      },
    };
  },
});
