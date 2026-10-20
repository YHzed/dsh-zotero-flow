/**
 * 面向模型的工具集。
 *
 * 分工：
 *   zotero_status        体检：Zotero 通道、本地 API、浏览器会话、配置
 *   library_sites        校内「数据资源数据库」清单 + 各站的取全文可行路径
 *   literature_lookup    用 DOI / 标题 / arXiv 号解析出规范元数据与开放获取直链
 *   scholar_session      机构登录会话：启动 / 查看 / 打开页面 / 关标签页
 *   scholar_download     在已登录会话里把 PDF 抓到本地（自动抓取 + 人工下载接管）
 *   zotero_collections   读取当前归档目标与可选分类
 *   zotero_save          元数据 + PDF 一次性归档到指定分类
 *   zotero_import_pdf    把本地已有 PDF（含人工下载的）归档到分类
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  LIBRARY_SITES,
  EXTRA_SITES,
  catalogCards,
  doiLanding,
  normalizeDoi,
  publisherFromDoi,
  siteById,
  siteByHostOrName,
  siteSearchUrl,
} from './catalog.js';
import { createBrowserSession } from './browser.js';
import { defineTool } from './define-tool.js';
import {
  arxivIdFrom,
  arxivWork,
  doiFromPdfBytes,
  lookupByDoi,
  makeHttp,
  openAccessPdf,
  searchWorks,
  titleFromPdfBytes,
  workFromPageMeta,
  workToZoteroItem,
} from './metadata.js';
import { createZoteroClient, ZoteroError } from './zotero.js';
import { assertCompleteSearch, normalizedTitle, requirePdf, selectImportParent, withImportGuard } from './dedup.js';

const TEXT = (value) => [{ type: 'text', text: value.text }];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeFilename(name, fallback = 'download.pdf') {
  const base = String(name ?? '').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/\s+/g, ' ').trim();
  const limited = base.length > 120 ? base.slice(0, 120) : base;
  if (limited === '') return fallback;
  return /\.pdf$/i.test(limited) ? limited : `${limited}.pdf`;
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last);
  } catch {
    return '';
  }
}

function authorLine(work, limit = 4) {
  const authors = Array.isArray(work.authors) ? work.authors : [];
  if (authors.length === 0) return '（无作者信息）';
  const names = authors.slice(0, limit).map((author) => (
    author.name ?? [author.given, author.family].filter(Boolean).join(' ')
  ));
  return names.join(', ') + (authors.length > limit ? ` 等 ${authors.length} 人` : '');
}

function candidateOf(work) {
  return {
    doi: work.doi ?? '',
    title: work.title ?? '(无标题)',
    authors: authorLine(work, 3),
    year: work.year ?? null,
    venue: work.containerTitle ?? '',
    type: work.type ?? '',
    oaPdfUrl: work.oaPdfUrl ?? '',
    url: work.url ?? (work.doi ? `https://doi.org/${work.doi}` : ''),
  };
}

/** 运行期共享状态：HTTP、Zotero 客户端、浏览器会话。 */
export function createRuntime(config = {}) {
  const http = makeHttp(config);
  const zotero = createZoteroClient({ port: config.zoteroPort ?? 23119 });
  const browser = createBrowserSession(config);
  return {
    config,
    http,
    zotero,
    browser,
    downloadDir: browser.paths.downloadDir,
  };
}

async function writePdf(rt, bytes, name) {
  await mkdir(rt.downloadDir, { recursive: true });
  let filename = safeFilename(name);
  let target = path.join(rt.downloadDir, filename);
  try {
    await stat(target);
    const stem = filename.replace(/\.pdf$/i, '');
    filename = `${stem}-${Date.now().toString(36)}.pdf`;
    target = path.join(rt.downloadDir, filename);
  } catch { /* 文件不存在，直接用原名 */ }
  await writeFile(target, bytes);
  return { path: target, filename, size: bytes.length, sha256: sha256(bytes) };
}

/** 由参数解析出规范 Work：DOI 优先，其次 arXiv，再次标题检索。 */
async function resolveWork(rt, args, warnings) {
  const rawQuery = typeof args.doi === 'string' && args.doi.trim() !== ''
    ? args.doi.trim()
    : (typeof args.title === 'string' ? args.title.trim() : '');

  const doi = normalizeDoi(rawQuery);
  if (doi !== undefined) {
    const work = await lookupByDoi(doi, rt.http);
    return { work: work ?? undefined, via: 'doi', query: doi };
  }

  const arxiv = arxivIdFrom(rawQuery);
  if (arxiv !== undefined) {
    const base = arxivWork(arxiv);
    try {
      const enriched = await lookupByDoi(base.doi, rt.http);
      if (enriched?.title && !enriched.title.startsWith('arXiv:')) {
        return { work: { ...enriched, arxivId: arxiv, oaPdfUrl: enriched.oaPdfUrl ?? base.oaPdfUrl }, via: 'arxiv', query: arxiv };
      }
    } catch { /* 退回最小 Work */ }
    return { work: base, via: 'arxiv', query: arxiv };
  }

  if (rawQuery !== '') {
    const candidates = await searchWorks(rawQuery, 3, rt.http);
    const exact = candidates.filter(candidate => normalizedTitle(candidate.title) === normalizedTitle(rawQuery));
    if (exact.length === 1) return { work: exact[0], via: 'exact-title-search', query: rawQuery };
    if (exact.length > 1) throw new ZoteroError('标题元数据候选不唯一；请提供 DOI 后重试。未修改 Zotero。', 'IMPORT_IDENTITY_AMBIGUOUS', { candidates: exact.map(candidateOf) });
    warnings.push(`没有检索到「${rawQuery}」的规范元数据，将只用你提供的字段建条目。`);
  }

  return { work: undefined, via: 'manual', query: rawQuery };
}

/** 把解析到的 Work 与人工字段合成 Zotero 条目。 */
function buildItem(work, args) {
  const overrides = {
    title: typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : undefined,
    itemType: typeof args.itemType === 'string' && args.itemType !== '' ? args.itemType : undefined,
    creators: Array.isArray(args.creators)
      ? args.creators.map((creator) => {
        if (typeof creator === 'string') {
          const parts = creator.trim().split(/\s+/);
          if (parts.length === 1) return { creatorType: 'author', name: parts[0] };
          return { creatorType: 'author', firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
        }
        return { creatorType: 'author', ...creator };
      })
      : undefined,
    publicationTitle: typeof args.venue === 'string' && args.venue !== '' ? args.venue : undefined,
    date: typeof args.year === 'string' || typeof args.year === 'number' ? String(args.year) : undefined,
    extra: typeof args.extra === 'string' ? args.extra : undefined,
    url: typeof args.url === 'string' && args.url !== '' ? args.url : undefined,
  };
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === undefined) delete overrides[key];
  }

  const effectiveWork = work ?? {
    doi: normalizeDoi(args.doi ?? '') ?? undefined,
    title: args.title,
    authors: [],
    url: typeof args.url === 'string' ? args.url : undefined,
    oaPdfUrl: undefined,
    sources: [],
  };
  return workToZoteroItem(effectiveWork, overrides);
}

/** 在会话里挂一个 PDF。 */
async function attachBytes(rt, sessionId, itemKey, bytes, filename, sourceUrl, doi) {
  await rt.zotero.attachPdf({
    sessionId,
    parentItemKey: itemKey,
    filename,
    bytes,
    sourceUrl,
    doi,
  });
}

/** 归档主体：建条目 → 定向分类 → 加标签 → 挂 PDF。 */
export async function saveToZotero(rt, options) {
  return withImportGuard(rt, () => saveToZoteroGuarded(rt, options));
}

async function saveToZoteroGuarded(rt, options) {
  const warnings = [...(options.warnings ?? [])];
  const bytes = options.pdfBytes;
  if (bytes != null) requirePdf(bytes);
  if (typeof rt.zotero.findImportCandidates !== 'function') {
    throw new ZoteroError('Complete local API duplicate search is required before import. No library writes were made.', 'IMPORT_SEARCH_INCOMPLETE');
  }
  const md5 = bytes == null ? undefined : createHash('md5').update(bytes).digest('hex');
  const found = await rt.zotero.findImportCandidates({ doi: options.item?.DOI, title: options.item?.title, md5 });
  assertCompleteSearch(found);
  const match = selectImportParent(found.items, { doi: options.item?.DOI, title: options.item?.title });
  if (match) {
    const foreign = md5 ? found.attachments.filter(item => item.md5?.toLowerCase() === md5 && item.parentItem !== match.item.key) : [];
    if (foreign.length) throw new ZoteroError(`This PDF already exists under a different or standalone attachment. Confirm ownership before attaching; no writes were made. Candidates: ${JSON.stringify(foreign.map(item => ({ key: item.key, parentItem: item.parentItem ?? '' })))}`, 'IMPORT_IDENTITY_AMBIGUOUS', { candidates: foreign });
    let attached;
    if (bytes != null) {
      // Attachment failure MUST propagate; never fall back to creating a parent.
      attached = await rt.zotero.attachExistingPdf({ parentItemKey: match.item.key, bytes,
        filename: safeFilename(options.pdfName ?? 'paper.pdf'), sourceUrl: options.pdfSourceUrl });
      if (attached?.attached !== true) throw new ZoteroError('Existing-parent attachment did not complete; no new parent was created.', 'ATTACH_PDF_FAILED');
    }
    const action = attached?.duplicate ? 'duplicate' : 'reused';
    if ((options.tags?.length ?? 0) || options.note) warnings.push('已有条目的分类、标签和笔记保持不变；本次未应用传入的分类、标签或笔记。');
    if (bytes == null && options.tryResolver) warnings.push('已复用已有条目；未为已有条目启动 Connector 开放获取解析器。');
    return { action, mode: action, itemKey: match.item.key, parentItemKey: match.item.key,
      matchedBy: match.matchedBy, target: { source: 'existing', preserved: true, collections: match.item.collections ?? [] }, tags: [], warnings,
      pdf: attached ? { saved: true, duplicate: attached.duplicate === true, attachmentKey: attached.attachmentKey,
        filename: safeFilename(options.pdfName), size: bytes.length, sha256: sha256(bytes), md5,
        via: options.pdfVia ?? 'local-file', localPath: options.pdfLocalPath ?? '' } : undefined };
  }
  const hashDuplicates = md5 ? found.attachments.filter(item => item.md5?.toLowerCase() === md5) : [];
  if (!options.standalone && hashDuplicates.length) {
    throw new ZoteroError(`This exact PDF already exists, but its parent could not be confirmed from the supplied identity. No parent was created. Confirm the existing attachment and parent in Zotero before retrying. Candidates: ${JSON.stringify(hashDuplicates.map(item => ({ key: item.key, parentItem: item.parentItem ?? '' })))}`, 'IMPORT_IDENTITY_AMBIGUOUS', { candidates: hashDuplicates.map(item => ({ key: item.key, parentItem: item.parentItem ?? '' })) });
  }
  if (options.standalone) {
    const duplicates = hashDuplicates;
    if (duplicates.length) {
      if (duplicates.length > 1) throw new ZoteroError(`Multiple attachments have this PDF hash; confirm in Zotero. Candidates: ${JSON.stringify(duplicates.map(item => ({ key: item.key, parentItem: item.parentItem ?? '' })))}`, 'IMPORT_IDENTITY_AMBIGUOUS');
      const duplicate = duplicates[0];
      return { action: 'duplicate', mode: 'duplicate', parentItemKey: duplicate.parentItem || '', itemKey: duplicate.parentItem || '',
        target: { source: 'existing', preserved: true }, tags: [], warnings,
        pdf: { saved: true, duplicate: true, attachmentKey: duplicate.key, filename: options.pdfName, size: bytes.length,
          sha256: sha256(bytes), md5, via: 'existing', localPath: options.pdfLocalPath ?? '' } };
    }
  }

  const targetsPayload = await rt.zotero.getTargets();
  const resolved = rt.zotero.resolveTarget(targetsPayload, options.collection);
  if (resolved === undefined) {
    const available = rt.zotero.targetsOf(targetsPayload).map((target) => `${target.name}（${target.id}）`).join('、');
    throw new Error(
      `在 Zotero 里找不到分类「${options.collection}」。当前可选目标是：${available || '（无）'}。`
      + '注意：Zotero 连接器只能定位「当前选中的分类」与「最近用过的分类」；'
      + '请先在 Zotero 左侧点选目标分类，再重试。',
    );
  }

  if (options.standalone) {
    const saved = await rt.zotero.saveStandalonePdf({ filename: safeFilename(options.pdfName), bytes,
      sourceUrl: options.pdfSourceUrl ?? '', target: resolved.targetId });
    return { action: 'new', mode: 'standalone', sessionId: saved.sessionId, itemKey: '', parentItemKey: '',
      target: resolved, tags: [], warnings,
      pdf: { saved: true, filename: safeFilename(options.pdfName), size: bytes.length, sha256: sha256(bytes), md5,
        via: 'standalone', localPath: options.pdfLocalPath ?? '' } };
  }
  const { sessionId, itemKey } = await rt.zotero.saveItem({ item: options.item });
  const tags = Array.isArray(options.tags) ? options.tags.filter((tag) => String(tag).trim() !== '') : [];
  try {
    await rt.zotero.updateSession({ sessionId, target: resolved.targetId, tags, note: options.note ?? '' });
  } catch (error) {
    throw new ZoteroError(`条目已入库，但分类/标签/笔记更新失败、PDF 未附上：${error.message}。请先检索已有条目，不要重新创建父条目。`, error.code ?? 'UPDATE_SESSION_FAILED', { parentCreated: true, sessionId, connectorItemId: itemKey });
  }

  let pdf;
  if (options.pdfBytes !== undefined && options.pdfBytes !== null) {
    const name = safeFilename(options.pdfName ?? 'paper.pdf');
    try {
      await attachBytes(rt, sessionId, itemKey, options.pdfBytes, name, options.pdfSourceUrl, options.item?.DOI);
    } catch (error) {
      throw new ZoteroError(`条目已入库、PDF 未附上：${error.message}。不要重新创建父条目；先用 zotero_search 找到刚建立的真实 itemKey，再用 zotero_attach_pdf 补附件。`, error.code ?? 'ATTACH_PDF_FAILED', { ...(error.detail ?? {}), parentCreated: true, sessionId, connectorItemId: itemKey });
    }
    pdf = {
      saved: true,
      filename: name,
      size: options.pdfBytes.length,
      sha256: sha256(options.pdfBytes),
      via: options.pdfVia ?? 'manual',
      localPath: options.pdfLocalPath ?? '',
    };
  } else if (options.tryResolver === true) {
    const available = await rt.zotero.hasResolvers(sessionId, itemKey);
    if (available.available) {
      const result = await rt.zotero.fetchWithResolver(sessionId, itemKey);
      if (result.saved) {
        pdf = { saved: true, filename: result.title ?? '', size: 0, sha256: '', via: 'zotero-resolver', localPath: '' };
      } else {
        warnings.push(`让 Zotero 自己找开放获取 PDF 失败：${result.message}`);
      }
    } else {
      warnings.push(`Zotero 报告该条目没有可用的开放获取解析器（${available.message}）。`);
    }
  }

  return { action: 'new', mode: 'new', sessionId, connectorItemId: itemKey, itemKey: '', parentItemKey: '', target: resolved, tags, pdf, warnings };
}

/* ------------------------------------------------------------------ */
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */

function zoteroStatusTool(rt) {
  return defineTool({
    name: 'zotero_status',
    description: '一次性体检：Zotero 桌面端是否在跑、连接器 API 与本地 API 的可用状态、当前归档目标、机构登录浏览器会话状态、插件当前配置。在做任何归档或下载之前先调用它，就知道还缺哪一步。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', required: true },
          zotero: { type: 'object' },
          targets: { type: 'array', items: { type: 'object' } },
          current: { type: 'object' },
          browser: { type: 'object' },
          config: { type: 'object' },
        },
      },
      render: (_args, value) => TEXT(value),
      presentationMeta: (_args, value) => ({ kind: 'zotero-status', ...value }),
    },
    isConcurrencySafe: () => true,
    async execute() {
      const probe = await rt.zotero.probe();
      const lines = [];
      const browserStatus = await rt.browser.status();

      lines.push(probe.running ? `Zotero 已连接：${probe.origin}（版本 ${probe.version ?? '未知'}）` : `Zotero 未响应：${probe.origin}`);
      lines.push(probe.localApiEnabled
        ? '本地 API：已开启（可读全部分类树与库内检索）'
        : '本地 API：未开启（可在 Zotero「编辑 → 设置 → 高级 → 常规」勾选「允许本机其他应用与 Zotero 通信」）');
      lines.push(browserStatus.running ? `浏览器会话：已在跑（${browserStatus.browser ?? '未知'}，端口 ${browserStatus.cdpPort}，${browserStatus.tabs.length} 个标签页）` : '浏览器会话：未启动（首次调用 scholar_session 会启动）');
      lines.push(`PDF 落盘目录：${rt.downloadDir}`);

      let targets = [];
      let current = {};
      if (probe.running) {
        try {
          const payload = await rt.zotero.getTargets();
          targets = rt.zotero.targetsOf(payload);
          const resolved = rt.zotero.resolveTarget(payload, '');
          current = resolved ?? {};
          lines.push(`当前归档目标：${resolved?.name ?? '未知'}（${resolved?.targetId ?? '?'}）`);
          if (targets.length > 1) {
            lines.push(`可选目标：${targets.map((target) => `${target.name}(${target.id})`).join('、')}`);
          }
        } catch (error) {
          lines.push(`读取归档目标失败：${error.message}`);
        }
      }

      return {
        text: lines.join('\n'),
        zotero: probe,
        targets,
        current,
        browser: {
          running: browserStatus.running,
          browser: browserStatus.browser ?? '',
          cdpPort: browserStatus.cdpPort,
          profileDir: browserStatus.profileDir,
          downloadDir: browserStatus.downloadDir,
          tabs: browserStatus.tabs.length,
        },
        config: {
          zoteroPort: rt.config.zoteroPort ?? 23119,
          mailto: rt.config.mailto ?? '',
          institutionProxy: rt.config.institutionProxy ?? '',
          downloadDir: rt.downloadDir,
        },
      };
    },
    presentCall: () => ({ card: 'generic', title: 'Zotero 体检', kind: 'other' }),
  });
}

function librarySitesTool(rt) {
  return defineTool({
    name: 'library_sites',
    description: '列出校内「数据资源数据库」里的各个数据库与出版社站点，以及每一站的取全文可行路径（能否直接取到 PDF 直链、检索页是否 JS 渲染、是否需要人工点击）。用户说「从知网/万方/ScienceDirect/IEEE…下载」时先看这里，再决定用 scholar_session 打开还是直接给 DOI。',
    parameters: {
      filter: { type: 'string', description: '可选：按名称或主机名过滤，例如 “IEEE”“sciencedirect.com”' },
      includeExtras: { type: 'boolean', description: '是否附带 arXiv、doi.org 这类开放入口（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', required: true },
          count: { type: 'number', required: true },
          sites: { type: 'array', items: { type: 'object' }, required: true },
        },
      },
      render: (_args, value) => TEXT(value),
      presentationMeta: (_args, value) => ({ kind: 'library-sites', count: value.count, sites: value.sites }),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const filter = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : '';
      let sites = [...LIBRARY_SITES, ...(args.includeExtras === true ? EXTRA_SITES : [])];
      if (filter !== '') {
        sites = sites.filter((site) => site.name.toLowerCase().includes(filter)
          || site.host.toLowerCase().includes(filter)
          || site.id.includes(filter));
      }
      if (sites.length === 0) {
        return { text: `没有匹配「${filter}」的站点。`, count: 0, sites: [] };
      }
      const cards = catalogCards();
      const payload = sites.map((site) => ({
        id: site.id,
        name: site.name,
        host: site.host,
        home: site.home,
        searchUrl: site.search !== null && site.stableSearch ? site.search : '',
        pdfPath: site.pdf,
        jsHeavy: site.js,
        note: site.note,
        color: (cards.find((card) => card.id === site.id)?.color) ?? '#5b6b7c',
        autoSearch: site.search !== null && site.stableSearch,
      }));

      const lines = [
        `共 ${payload.length} 个数据资源（pdfPath：meta-pdf=可自动取直链，mixed=部分可自动，manual=基本要人工点下载）`,
      ];
      for (const site of payload) {
        const flags = [site.pdfPath];
        if (site.jsHeavy) flags.push('JS');
        if (site.autoSearch) flags.push('有稳定检索链接');
        lines.push(`- ${site.name}（${site.id}，${site.host}）[${flags.join(' / ')}]`);
      }
      lines.push('提示：能给出 DOI 的文献，优先用 literature_lookup 拿到规范元数据，再 scholar_download 走机构会话取 PDF；中文库（知网/万方/ProQuest）通常需要人工点击，用 scholar_session 打开页面后由 scholar_download 接管下载目录。');
      return { text: lines.join('\n'), count: payload.length, sites: payload };
    },
    presentCall: () => ({ card: 'generic', title: '数据资源清单', kind: 'other' }),
  });
}

function literatureLookupTool(rt) {
  return defineTool({
    name: 'literature_lookup',
    description: '用 DOI、arXiv 编号或标题解析文献的规范元数据（Crossref / OpenAlex / Unpaywall，免密钥），并给出开放获取 PDF 直链。归档前用它拿到可靠的标题、作者、期刊、年份与 DOI。',
    parameters: {
      query: { type: 'string', required: true, description: 'DOI（10.xxxx/yyy）、arXiv 编号（2401.12345）或文献标题' },
      limit: { type: 'number', description: '标题检索返回的候选条数，默认 5，最多 20' },
      findPdf: { type: 'boolean', description: '是否顺带查开放获取 PDF 直链，默认 true' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', required: true },
          query: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          count: { type: 'number', required: true },
          candidates: { type: 'array', items: { type: 'object' }, required: true },
          publisher: { type: 'object' },
        },
      },
      render: (_args, value) => TEXT(value),
      presentationMeta: (_args, value) => ({ kind: 'literature-lookup', ...value }),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = String(args.query ?? '').trim();
      if (query === '') throw new Error('literature_lookup: query 是必填参数');
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(Number(args.limit), 20)) : 5;
      const findPdf = args.findPdf !== false;

      const doi = normalizeDoi(query);
      const arxiv = arxivIdFrom(query);
      let works = [];
      let kind = 'title';

      if (doi !== undefined) {
        kind = 'doi';
        const work = await lookupByDoi(doi, rt.http);
        if (work !== undefined) works = [work];
      } else if (arxiv !== undefined) {
        kind = 'arxiv';
        works = [arxivWork(arxiv)];
      } else {
        works = await searchWorks(query, limit, rt.http);
      }

      if (works.length === 0) {
        return {
          text: `没有解析到「${query}」的元数据。可以改用 DOI 重试，或直接提供标题/作者由 zotero_save 建条目。`,
          query,
          kind,
          count: 0,
          candidates: [],
          publisher: {},
        };
      }

      if (findPdf) {
        for (const work of works.slice(0, 3)) {
          if (work.oaPdfUrl !== undefined && work.oaPdfUrl !== '') continue;
          try {
            const pdf = await openAccessPdf(work.doi, rt.http, work.oaPdfUrl);
            if (pdf !== undefined) work.oaPdfUrl = pdf;
          } catch { /* 没有就没有 */ }
        }
      }

      const candidates = works.map(candidateOf);
      const first = works[0];
      const publisher = first.doi === undefined ? {} : (publisherFromDoi(first.doi) ?? {});

      const lines = [`解析方式：${kind}；命中 ${candidates.length} 条`];
      candidates.forEach((candidate, index) => {
        lines.push(`${index + 1}. ${candidate.title}`);
        lines.push(`   作者：${candidate.authors}`);
        lines.push(`   出处：${candidate.venue || '（未知）'}${candidate.year ? ` · ${candidate.year}` : ''}`);
        if (candidate.doi) lines.push(`   DOI：${candidate.doi}`);
        if (candidate.oaPdfUrl) lines.push(`   开放获取 PDF：${candidate.oaPdfUrl}`);
      });
      if (publisher.siteLabel !== undefined) {
        lines.push(`推断归属：${publisher.publisherLabel}，机构登录下建议走 ${publisher.siteLabel}（${publisher.siteId}）。`);
      }
      if (candidates[0].doi) lines.push(`落地页：${doiLanding(candidates[0].doi)}`);

      return { text: lines.join('\n'), query, kind, count: candidates.length, candidates, publisher };
    },
    presentCall: () => ({ card: 'generic', title: '文献解析', kind: 'other' }),
  });
}

function scholarSessionTool(rt) {
  return defineTool({
    name: 'scholar_session',
    description: '管理机构登录用的浏览器会话。action=start 启动一个独立资料目录的 Edge/Chrome 窗口（用户在这个窗口里登录学校 SSO / CARSI / WebVPN，登录状态长期保留）；action=goto 在会话里打开某个 URL 并返回页面分析（DOI、引文 PDF 直链、登录/付费/验证码迹象）；action=status 查看状态；action=tabs 列出标签页；action=close 断开连接（不关浏览器）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['start', 'goto', 'status', 'tabs', 'close'], description: '要执行的动作' },
      url: { type: 'string', description: 'action=goto 时打开的地址；也可以给 site（站点 id）+ query（检索词）由插件拼链接' },
      site: { type: 'string', description: '站点 id，例如 cnki、sciencedirect、ieee；与 query 搭配使用' },
      query: { type: 'string', description: '配合 site 使用的检索词或 DOI' },
      waitMs: { type: 'number', description: '页面加载后额外等待的毫秒数，默认 3000；JS 站点可加大' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', required: true },
          action: { type: 'string', required: true },
          running: { type: 'boolean', required: true },
          browser: { type: 'string' },
          cdpPort: { type: 'number' },
          profileDir: { type: 'string' },
          downloadDir: { type: 'string' },
          tabs: { type: 'array', items: { type: 'object' } },
          page: { type: 'object' },
        },
      },
      render: (_args, value) => TEXT(value),
      presentationMeta: (_args, value) => ({ kind: 'scholar-session', ...value }),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = String(args.action ?? '');
      const lines = [];

      if (action === 'close') {
        await rt.browser.close();
        return { text: '已断开 CDP 连接（浏览器窗口保持打开，登录状态保留）。', action, running: true, tabs: [] };
      }

      if (action === 'status' || action === 'tabs') {
        const status = await rt.browser.status();
        lines.push(status.running
          ? `浏览器会话在跑：${status.browser ?? '未知'}，端口 ${status.cdpPort}，${status.tabs.length} 个标签页`
          : `浏览器会话未启动（端口 ${status.cdpPort} 上没有浏览器）`);
        lines.push(`独立资料目录：${status.profileDir}`);
        lines.push(`PDF 落盘目录：${status.downloadDir}`);
        for (const tab of status.tabs) lines.push(`- ${tab.title || '(无标题)'} · ${tab.url}`);
        if (action === 'tabs' && status.tabs.length === 0 && !status.running) {
          lines.push('先执行 action=start 启动会话。');
        }
        return {
          text: lines.join('\n'),
          action,
          running: status.running,
          browser: status.browser ?? '',
          cdpPort: status.cdpPort,
          profileDir: status.profileDir,
          downloadDir: status.downloadDir,
          tabs: status.tabs.map((tab) => ({ title: tab.title, url: tab.url })),
        };
      }

      if (action === 'start') {
        const info = await rt.browser.ensure();
        const status = await rt.browser.status();
        lines.push(`已启动机构登录浏览器：${info.browser}（端口 ${info.cdpPort}）`);
        lines.push(`独立资料目录：${info.profileDir}`);
        lines.push(`PDF 落盘目录：${info.downloadDir}`);
        lines.push('请在这个窗口里完成学校登录（图书馆 SSO / CARSI / WebVPN），登录状态会长期保存在该资料目录里。');
        lines.push('登录完成后告诉 agent 继续，agent 会用 scholar_session(action=goto) 打开目标站点。');
        return {
          text: lines.join('\n'),
          action,
          running: true,
          browser: info.browser,
          cdpPort: info.cdpPort,
          profileDir: info.profileDir,
          downloadDir: info.downloadDir,
          tabs: status.tabs.map((tab) => ({ title: tab.title, url: tab.url })),
        };
      }

      if (action === 'goto') {
        let url = typeof args.url === 'string' ? args.url.trim() : '';
        if (url === '' && typeof args.site === 'string' && args.site !== '') {
          const site = siteById(args.site) ?? siteByHostOrName(args.site);
          if (site === undefined) throw new Error(`scholar_session: 不认识的站点「${args.site}」，先用 library_sites 查看可用 id`);
          const query = typeof args.query === 'string' ? args.query.trim() : '';
          if (query !== '') {
            const doi = normalizeDoi(query);
            if (doi !== undefined) {
              url = doiLanding(doi);
            } else {
              url = siteSearchUrl(site, query) ?? site.home;
            }
          } else {
            url = site.home;
          }
        }
        if (url === '') throw new Error('scholar_session: action=goto 需要 url，或 site(+query)');

        const proxy = typeof rt.config.institutionProxy === 'string' ? rt.config.institutionProxy.trim() : '';
        let effectiveUrl = url;
        if (proxy !== '' && !url.startsWith(proxy)) {
          effectiveUrl = proxy.endsWith('=') || proxy.endsWith('/') ? `${proxy}${url}` : `${proxy}${url}`;
        }

        const page = await rt.browser.open(effectiveUrl, { waitMs: Number.isFinite(args.waitMs) ? Number(args.waitMs) : 3000 });
        const hints = page.loginHints.length > 0 ? `；页面迹象：${page.loginHints.join('、')}` : '';
        lines.push(`已打开：${page.title || '(无标题)'}`);
        lines.push(`地址：${page.url}`);
        if (proxy !== '' && effectiveUrl !== url) lines.push(`（已套用机构代理前缀：${proxy}）`);
        lines.push(`引文 DOI：${page.doi ?? '未读到'}${hints}`);
        if (page.citationPdfUrl) lines.push(`PDF 直链：${page.citationPdfUrl}`);
        if (page.pdfLinks.length > 0) {
          lines.push('页面上的 PDF 相关链接：');
          for (const link of page.pdfLinks.slice(0, 8)) lines.push(`- ${link.url}${link.text ? `  「${link.text}」` : ''}`);
        }
        lines.push(page.citationPdfUrl || page.pdfLinks.length > 0
          ? '下一步：用 scholar_download 传上面的 PDF 地址取全文。'
          : '没读到直接 PDF 链接：如果这是需要人工点击的库，请在浏览器里点下载，然后运行 scholar_download（不传 url，只监视下载目录）。');

        return {
          text: lines.join('\n'),
          action,
          running: true,
          browser: '',
          cdpPort: rt.browser.paths.cdpPort,
          profileDir: rt.browser.paths.profileDir,
          downloadDir: rt.browser.paths.downloadDir,
          tabs: [],
          page: {
            url: page.url,
            title: page.title,
            doi: page.doi ?? '',
            journal: page.journal ?? '',
            citationPdfUrl: page.citationPdfUrl ?? '',
            pdfLinks: page.pdfLinks.slice(0, 10),
            loginHints: page.loginHints,
            bodyPreview: page.bodyPreview.slice(0, 400),
          },
        };
      }

      throw new Error(`scholar_session: 不支持的 action「${action}」`);
    },
    presentCall: () => ({ card: 'generic', title: '机构会话', kind: 'other' }),
  });
}

function scholarDownloadTool(rt) {
  return defineTool({
    name: 'scholar_download',
    description: '在已登录的机构会话里把 PDF 抓到本地并落盘。给 url 就直接导航抓取（自动处理 PDF 一律下载、内联响应体、页面内 fetch 三条通道）；不给 url 时只监视下载目录，用于用户在浏览器里手动点「下载全文」后由插件接管文件。返回本地绝对路径，供 zotero_save / zotero_import_pdf 使用。',
    parameters: {
      url: { type: 'string', description: 'PDF 地址或会跳转到 PDF 的地址；留空表示只监视下载目录' },
      saveAs: { type: 'string', description: '可选的落盘文件名' },
      timeoutMs: { type: 'number', description: '最多等多少毫秒，默认 90000；人工下载场景建议 180000' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          path: { type: 'string' },
          filename: { type: 'string' },
          size: { type: 'number' },
          sha256: { type: 'string' },
          via: { type: 'string' },
          sourceUrl: { type: 'string' },
        },
      },
      render: (_args, value) => TEXT(value),
      presentationMeta: (_args, value) => ({ kind: 'scholar-download', ...value }),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      const timeoutMs = Number.isFinite(args.timeoutMs) ? Math.max(5000, Number(args.timeoutMs)) : (url === '' ? 180000 : 90000);

      await rt.browser.ensure();

      if (url === '') {
        const since = Date.now();
        const found = await rt.browser.waitForDownload({ since, timeoutMs });
        if (found === undefined) {
          return {
            text: `在 ${Math.round(timeoutMs / 1000)} 秒内没有在下载目录里发现新的 PDF（监视了 ${rt.browser.paths.downloadDir} 与系统下载目录）。请在浏览器窗口里完成下载后重试。`,
            ok: false,
          };
        }
        const bytes = await readFile(found.path);
        return {
          text: `接管到人工下载的 PDF：${found.path}（${found.size} 字节）`,
          ok: true,
          path: found.path,
          filename: path.basename(found.path),
          size: found.size,
          sha256: sha256(bytes),
          via: 'manual-download',
          sourceUrl: '',
        };
      }

      const result = await rt.browser.capturePdf(url, { timeoutMs });
      if (result.error !== undefined && result.bytes === undefined) {
        const hints = Array.isArray(result.page?.loginHints) && result.page.loginHints.length > 0
          ? `；页面迹象：${result.page.loginHints.join('、')}`
          : '';
        return {
          text: `抓取失败：${result.error}${hints}。若这是需要人工点击的库，请先在浏览器窗口里下载，然后不带 url 再调用一次本工具接管下载目录。`,
          ok: false,
          sourceUrl: url,
        };
      }

      const name = typeof args.saveAs === 'string' && args.saveAs.trim() !== ''
        ? args.saveAs.trim()
        : (filenameFromUrl(result.finalUrl ?? url) || 'paper.pdf');
      const saved = await writePdf(rt, result.bytes, name);

      return {
        text: [
          `已抓取 PDF：${saved.filename}（${saved.size} 字节，通道 ${result.via ?? 'unknown'}）`,
          `本地路径：${saved.path}`,
          `sha256：${saved.sha256}`,
        ].join('\n'),
        ok: true,
        path: saved.path,
        filename: saved.filename,
        size: saved.size,
        sha256: saved.sha256,
        via: result.via ?? 'unknown',
        sourceUrl: result.finalUrl ?? url,
      };
    },
    presentCall: () => ({ card: 'generic', title: '抓取 PDF', kind: 'other' }),
  });
}

function zoteroCollectionsTool(rt) {
  return defineTool({
    name: 'zotero_collections',
    description: '查看 Zotero 当前的归档目标与可选分类，或新建分类。action=list 列出分类（本地 API 开启时是带 key 的完整树，否则是「当前选中 + 最近使用」）；action=targets 只列可直接归档的目标 id；action=create 新建分类（需要打开 Zotero 本地 API）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'targets', 'create'], description: '要执行的动作' },
      name: { type: 'string', description: 'action=create 时的分类名' },
      parent: { type: 'string', description: 'action=create 时的父分类 key（可选）' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', required: true },
          action: { type: 'string', required: true },
          source: { type: 'string' },
          collections: { type: 'array', items: { type: 'object' }, required: true },
          current: { type: 'object' },
          created: { type: 'object' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => TEXT(value),
      presentationMeta: (_args, value) => ({ kind: 'zotero-collections', ...value }),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = String(args.action ?? 'list');

      if (action === 'create') {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (name === '') throw new Error('zotero_collections: action=create 需要 name');
        const created = await rt.zotero.createCollection(name, args.parent ?? null);
        return {
          text: `已新建分类「${created.name}」（key ${created.key}）。`,
          action,
          source: 'local-api',
          collections: [],
          created: { key: created.key, name: created.name },
        };
      }

      const payload = await rt.zotero.getTargets();
      const current = rt.zotero.resolveTarget(payload, '') ?? {};

      if (action === 'targets') {
        const targets = rt.zotero.targetsOf(payload);
        const lines = [`当前目标：${current.name ?? '未知'}（${current.targetId ?? '?'}）`, '可直接归档的目标：'];
        for (const target of targets) {
          lines.push(`- ${target.name}（${target.id}）${target.recent ? ' · 最近用过' : ''}`);
        }
        lines.push('要归档到别的分类：先在 Zotero 左侧点选那个分类，再重试；Zotero 连接器只认「当前选中 / 最近使用」的目标。');
        return {
          text: lines.join('\n'),
          action,
          source: 'connector',
          collections: targets,
          current,
        };
      }

      const listed = await rt.zotero.listCollections();
      const lines = [`来源：${listed.source}；共 ${listed.collections.length} 个分类`];
      for (const collection of listed.collections.slice(0, 80)) {
        const depth = Number.isFinite(collection.level) ? collection.level : 0;
        lines.push(`${'  '.repeat(depth)}- ${collection.name}（${collection.key}）`);
      }
      if (listed.error !== undefined) lines.push(`说明：${listed.error}`);
      lines.push(`当前归档目标：${current.name ?? '未知'}（${current.targetId ?? '?'}）。zotero_save 的 collection 参数可以传分类名或目标 id（L1 / C12 这类）。`);

      return {
        text: lines.join('\n'),
        action,
        source: listed.source,
        collections: listed.collections.slice(0, 200),
        current,
        note: listed.error ?? '',
      };
    },
    presentCall: () => ({ card: 'generic', title: 'Zotero 分类', kind: 'other' }),
  });
}

function zoteroSaveTool(rt) {
  return defineTool({
    name: 'zotero_save',
    description: '把一篇文献归档进 Zotero：强制先通过本地 API 完整检索已有条目，精确核对 DOI/标题并检查 PDF 哈希。匹配已有条目时只追加 PDF 子附件或跳过重复，保留原分类、标签和笔记；仅确认无匹配后才新建父条目并应用指定分类。检索失败、API 未开启或身份有歧义时停止，不会盲目新建；附件失败也不会重建父条目。PDF 可来自本地 pdfPath、机构会话 pdfUrl，或新条目的开放获取解析器 fetchOpenAccess。',
    parameters: {
      doi: { type: 'string', description: 'DOI，最可靠；给了它就自动解析全部元数据' },
      title: { type: 'string', description: '标题（没有 DOI 时用；会先做一次元数据检索）' },
      collection: { type: 'string', description: '目标分类名或目标 id（L1/C12）。留空则用 Zotero 当前选中的分类' },
      tags: { type: 'array', items: { type: 'string' }, description: '要加的标签列表' },
      note: { type: 'string', description: '要作为子笔记写入的内容，例如抓取来源与时间' },
      pdfPath: { type: 'string', description: '已下载好的本地 PDF 绝对路径' },
      pdfUrl: { type: 'string', description: 'PDF 在线地址；插件会在机构登录会话里抓取后挂上' },
      fetchOpenAccess: { type: 'boolean', description: '没有本地/在线 PDF 时，让 Zotero 自己尝试获取开放获取副本，默认 true' },
      itemType: { type: 'string', description: '覆盖条目类型，如 journalArticle / conferencePaper / thesis / preprint' },
      venue: { type: 'string', description: '覆盖期刊/会议名' },
      year: { type: 'string', description: '覆盖年份' },
      creators: { type: 'array', items: { type: 'string' }, description: '覆盖作者列表，例如 ["Knuth, Donald E."]' },
      extra: { type: 'string', description: '追加到 Zotero extra 字段的文本' },
      url: { type: 'string', description: '覆盖条目 URL' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', required: true },
          saved: { type: 'boolean', required: true },
          item: { type: 'object' },
          target: { type: 'object' },
          tags: { type: 'array', items: { type: 'string' } },
          pdf: { type: 'object' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => TEXT(value),
      presentationMeta: (_args, value) => ({ kind: 'zotero-save', ...value }),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const warnings = [];
      if (typeof args.doi !== 'string' && typeof args.title !== 'string') {
        throw new Error('zotero_save: 至少要给 doi 或 title');
      }

      const { work, via } = await resolveWork(rt, args, warnings);
      const item = buildItem(work, args);

      let pdfBytes;
      let pdfName;
      let pdfSourceUrl = '';
      let pdfVia = 'local-file';
      let pdfLocalPath = '';

      if (typeof args.pdfPath === 'string' && args.pdfPath.trim() !== '') {
        const localPath = args.pdfPath.trim();
        try {
          pdfBytes = await readFile(localPath);
        } catch (error) {
          throw new Error(`zotero_save: 读不到本地 PDF「${localPath}」：${error.message}`);
        }
        pdfName = path.basename(localPath);
        pdfLocalPath = localPath;
      } else if (typeof args.pdfUrl === 'string' && args.pdfUrl.trim() !== '') {
        const captured = await rt.browser.capturePdf(args.pdfUrl.trim(), { timeoutMs: 120000 });
        if (captured.bytes === undefined) {
          throw new Error(`从 ${args.pdfUrl} 抓取 PDF 失败：${captured.error}。未修改 Zotero。`);
        } else {
          pdfBytes = captured.bytes;
          pdfName = filenameFromUrl(captured.finalUrl ?? args.pdfUrl) || 'paper.pdf';
          pdfSourceUrl = captured.finalUrl ?? args.pdfUrl;
          pdfVia = captured.via ?? 'browser';
        }
      }

      const result = await saveToZotero(rt, {
        item,
        collection: args.collection,
        tags: Array.isArray(args.tags) ? args.tags : [],
        note: typeof args.note === 'string' ? args.note : '',
        pdfBytes,
        pdfName,
        pdfSourceUrl,
        pdfVia,
        pdfLocalPath,
        tryResolver: args.fetchOpenAccess !== false && pdfBytes === undefined,
        warnings,
      });

      const title = item.title ?? '(无标题)';
      const lines = [
        `已归档到 Zotero：${title}`,
        result.target.preserved ? '复用已有条目，原分类保持不变。' : `目标分类：${result.target.name}（${result.target.targetId}，按${result.target.source}匹配）`,
      ];
      if (work?.doi) lines.push(`DOI：${work.doi}`);
      lines.push(`元数据来源：${via}`);
      if (result.pdf !== undefined) {
        lines.push(`PDF：已挂载 ${result.pdf.via === 'zotero-resolver' ? '（Zotero 自行获取）' : `${result.pdf.filename}（${result.pdf.size} 字节，${result.pdf.via}）`}`);
      } else {
        lines.push('PDF：未挂载');
      }
      if (result.tags.length > 0) lines.push(`标签：${result.tags.join(', ')}`);
      for (const warning of result.warnings) lines.push(`注意：${warning}`);

      return {
        text: lines.join('\n'),
        saved: true,
        action: result.action,
        mode: result.mode,
        parentItemKey: result.parentItemKey,
        item: {
          itemType: item.itemType,
          title,
          doi: work?.doi ?? '',
          year: item.date ?? '',
          venue: item.publicationTitle ?? item.bookTitle ?? item.proceedingsTitle ?? '',
          creators: (item.creators ?? []).slice(0, 6).map((creator) => creator.name ?? [creator.firstName, creator.lastName].filter(Boolean).join(' ')),
        },
        target: result.target,
        tags: result.tags,
        pdf: result.pdf ?? {},
        warnings: result.warnings,
      };
    },
    presentCall: () => ({ card: 'generic', title: '归档到 Zotero', kind: 'other' }),
  });
}

function zoteroImportPdfTool(rt) {
  return defineTool({
    name: 'zotero_import_pdf',
    description: '把本地 PDF 安全导入 Zotero：解析 DOI/标题后强制完整检索已有条目并核对身份，已有父条目只追加 PDF 子附件，哈希相同则跳过，原分类保持不变；确认无匹配才新建父条目。无法识别的 PDF 也必须先全库检查附件哈希，确认无重复才保存为独立附件。需要本地 API；检索失败、身份歧义或附件失败时停止，绝不回退重建父条目。适合知网/万方等人工下载后的 PDF。',
    parameters: {
      pdfPath: { type: 'string', required: true, description: '本地 PDF 绝对路径' },
      collection: { type: 'string', description: '目标分类名或目标 id；留空用当前选中分类' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
      doi: { type: 'string', description: '已知 DOI 时直接给，跳过从 PDF 里抠' },
      title: { type: 'string', description: '抠不到 DOI 时的兜底标题' },
      note: { type: 'string', description: '子笔记内容' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', required: true },
          saved: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          item: { type: 'object' },
          target: { type: 'object' },
          pdf: { type: 'object' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => TEXT(value),
      presentationMeta: (_args, value) => ({ kind: 'zotero-import', ...value }),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const pdfPath = String(args.pdfPath ?? '').trim();
      if (pdfPath === '') throw new Error('zotero_import_pdf: pdfPath 是必填参数');

      let bytes;
      try {
        bytes = await readFile(pdfPath);
      } catch (error) {
        throw new Error(`zotero_import_pdf: 读不到「${pdfPath}」：${error.message}`);
      }
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error(`zotero_import_pdf: 「${pdfPath}」不是 PDF（文件头不是 %PDF-）`);
      }

      const warnings = [];
      let doi = normalizeDoi(args.doi ?? '') ?? undefined;
      let doiWhere = doi === undefined ? '' : '参数';
      if (doi === undefined) {
        const found = doiFromPdfBytes(bytes);
        if (found !== undefined) {
          doi = found.doi;
          doiWhere = `PDF 内（${found.where}）`;
        }
      }

      let work;
      if (doi !== undefined) {
        work = await lookupByDoi(doi, rt.http);
      } else {
        const guessedTitle = typeof args.title === 'string' && args.title.trim() !== ''
          ? args.title.trim()
          : titleFromPdfBytes(bytes);
        if (guessedTitle !== undefined) {
          const candidates = await searchWorks(guessedTitle, 5, rt.http);
          const exact = candidates.filter(candidate => normalizedTitle(candidate.title) === normalizedTitle(guessedTitle));
          if (exact.length > 1) throw new ZoteroError('标题元数据候选不唯一；请提供 DOI 后重试。未修改 Zotero。', 'IMPORT_IDENTITY_AMBIGUOUS', { candidates: exact.map(candidateOf) });
          if (exact.length === 1) {
            work = exact[0];
            warnings.push(`没有 PDF DOI，使用规范化精确标题「${guessedTitle}」匹配的元数据。`);
          } else {
            warnings.push(`没有 DOI，也没检索到标题「${guessedTitle}」的元数据。`);
          }
        } else {
          warnings.push('PDF 里既没有 DOI 也没有可读标题。');
        }
      }

      if (work === undefined && doi === undefined) {
        const result = await saveToZotero(rt, {
          standalone: true, item: { title: typeof args.title === 'string' ? args.title.trim() : titleFromPdfBytes(bytes) },
          collection: args.collection, pdfBytes: bytes, pdfName: path.basename(pdfPath),
          pdfLocalPath: pdfPath, pdfVia: 'local-file', warnings,
        });
        return {
          text: `${result.action === 'duplicate' ? '相同 PDF 已存在，跳过重复导入' : result.action === 'reused' ? 'PDF 已追加到已有条目，原分类保持不变' : '已作为独立附件存入 Zotero'}：${path.basename(pdfPath)}\n${result.parentItemKey ? `父条目 key：${result.parentItemKey}` : '未返回真实父条目 key'}\n${result.target.preserved ? '未改变已有条目的分类。' : `归入：${result.target.name}`}`,
          saved: true, action: result.action, mode: result.mode, parentItemKey: result.parentItemKey,
          item: { itemType: result.parentItemKey ? 'regular' : 'attachment', title: path.basename(pdfPath), key: result.parentItemKey },
          target: result.target, pdf: result.pdf, warnings: result.warnings,
        };
      }
      const item = buildItem(work, args);
      const result = await saveToZotero(rt, {
        item,
        collection: args.collection,
        tags: Array.isArray(args.tags) ? args.tags : [],
        note: typeof args.note === 'string' ? args.note : '',
        pdfBytes: bytes,
        pdfName: path.basename(pdfPath),
        pdfSourceUrl: '',
        pdfVia: 'local-file',
        pdfLocalPath: pdfPath,
        tryResolver: false,
        warnings,
      });

      const lines = [
        `已归档到 Zotero：${item.title ?? '(无标题)'}`,
        result.target.preserved ? '复用已有条目，原分类保持不变。' : `目标分类：${result.target.name}（${result.target.targetId}）`,
      ];
      if (doi !== undefined) lines.push(`DOI：${doi}（来源：${doiWhere}）`);
      lines.push(`PDF：${path.basename(pdfPath)}（${bytes.length} 字节）`);
      for (const warning of result.warnings) lines.push(`注意：${warning}`);

      return {
        text: lines.join('\n'),
        saved: true,
        mode: result.mode,
        action: result.action,
        parentItemKey: result.parentItemKey,
        item: {
          itemType: item.itemType,
          title: item.title ?? '',
          doi: doi ?? '',
          year: item.date ?? '',
          venue: item.publicationTitle ?? '',
        },
        target: result.target,
        pdf: result.pdf ?? {},
        warnings: result.warnings,
      };
    },
    presentCall: () => ({ card: 'generic', title: '导入 PDF', kind: 'other' }),
  });
}

function zoteroSearchTool(rt) {
  return defineTool({
    name: 'zotero_search',
    description: '检索 Zotero 库内已有条目（标题、作者、DOI），返回真实 itemKey。追加附件前先检索并核对；多个候选时请用户确认，不要猜 key。需要本地 API。',
    parameters: {
      query: { type: 'string', required: true, description: '标题、作者或 DOI' },
      limit: { type: 'number', description: '最多返回多少条，默认 10，上限 50' },
    },
    output: {
      schema: { type: 'object', properties: {
        text: { type: 'string', required: true },
        items: { type: 'array', items: { type: 'object' }, required: true },
      } },
      render: (_args, value) => TEXT(value),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('zotero_search: query 是必填参数');
      const result = await rt.zotero.searchItems(query, args.limit ?? 10);
      if (result.error) throw new Error(result.error);
      return {
        text: result.items.length
          ? result.items.map(item => `${item.title ?? '(无标题)'} | itemKey=${item.key} | DOI=${item.DOI ?? ''} | ${item.date ?? ''}`).join('\n')
          : '未找到已有条目；没有新建任何条目。',
        items: result.items,
      };
    },
    presentCall: () => ({ card: 'generic', title: '检索 Zotero 已有条目', kind: 'other' }),
  });
}

function zoteroAttachPdfTool(rt) {
  return defineTool({
    name: 'zotero_attach_pdf',
    description: '向 Zotero 已有条目追加本地 PDF 子附件，绝不新建书目、不改变分类。先用 zotero_search 获取并核对真实 itemKey。按文件哈希跳过重复附件。需要 Zotero 10+ 本地 API 和用户在 Zotero 窗口批准写入授权。失败会报告已创建但未完成的附件 key。',
    parameters: {
      itemKey: { type: 'string', required: true, description: 'zotero_search 返回的已有条目 key，不能用分类 id 或 Connector 会话 id' },
      pdfPath: { type: 'string', required: true, description: '已下载的本地 PDF 绝对路径；不重复下载' },
      title: { type: 'string', description: '附件显示标题，默认文件名' },
      sourceUrl: { type: 'string', description: '可选来源 URL，仅记录来源，不从这里下载' },
    },
    output: {
      schema: { type: 'object', properties: {
        text: { type: 'string', required: true },
        attached: { type: 'boolean', required: true },
        duplicate: { type: 'boolean' },
        parentItemKey: { type: 'string' },
        attachmentKey: { type: 'string' },
        pdfPath: { type: 'string' },
        error: { type: 'string' },
      } },
      render: (_args, value) => TEXT(value),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const itemKey = String(args.itemKey ?? '').trim();
      const pdfPath = String(args.pdfPath ?? '').trim();
      if (!/^[A-Z0-9]{8}$/.test(itemKey)) throw new Error('zotero_attach_pdf: 需要真实的 8 位 itemKey，请先用 zotero_search 核对');
      if (!path.isAbsolute(pdfPath)) throw new Error('zotero_attach_pdf: pdfPath 必须是绝对路径');
      const info = await stat(pdfPath);
      if (!info.isFile() || info.size >= 4 * 1024 ** 3) throw new Error('zotero_attach_pdf: 需要小于 4GB 的普通 PDF 文件');
      const bytes = await readFile(pdfPath);
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('zotero_attach_pdf: 文件头不是 %PDF-，未修改 Zotero');
      try {
        const result = await rt.zotero.attachExistingPdf({
          parentItemKey: itemKey, bytes, filename: path.basename(pdfPath),
          title: args.title, sourceUrl: args.sourceUrl,
        });
        return {
          text: `${result.duplicate ? '相同 PDF 已存在，已跳过重复添加' : 'PDF 已追加到已有条目'}：${itemKey}\n附件 key：${result.attachmentKey}\n本地 PDF：${pdfPath}\n未新建书目，原分类保持不变。`,
          attached: true, duplicate: result.duplicate === true,
          parentItemKey: itemKey, attachmentKey: result.attachmentKey, pdfPath,
        };
      } catch (error) {
        return {
          text: `PDF 追加失败：${error.message}\n未新建书目。${error.detail?.attachmentKey ? `附件 ${error.detail.attachmentKey} 已存在但操作未完成，请检查后恢复，不要反复创建。` : 'PDF 未确认附上。'}`,
          attached: false, parentItemKey: itemKey,
          ...(error.detail?.attachmentKey ? { attachmentKey: error.detail.attachmentKey } : {}),
          pdfPath, error: error.code ?? 'ATTACH_EXISTING_FAILED',
        };
      }
    },
    presentCall: () => ({ card: 'generic', title: '向已有条目追加 PDF', kind: 'other' }),
  });
}

/** 构造全部工具定义。 */
export function buildTools(rt) {
  return [
    zoteroStatusTool(rt),
    librarySitesTool(rt),
    literatureLookupTool(rt),
    scholarSessionTool(rt),
    scholarDownloadTool(rt),
    zoteroCollectionsTool(rt),
    zoteroSaveTool(rt),
    zoteroImportPdfTool(rt),
    zoteroSearchTool(rt),
    zoteroAttachPdfTool(rt),
  ];
}

export { ZoteroError };
