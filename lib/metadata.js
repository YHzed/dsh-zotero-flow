/**
 * 文献元数据解析：Crossref / OpenAlex / Unpaywall / arXiv，全部免密钥。
 *
 * 职责边界：
 *  - 这里只做「把外部数据整形成统一 Work」与「Work → Zotero 翻译器条目」。
 *  - 不碰网络凭据，不写文件；抓取入口集中在小节末的 makeHttp。
 */

import { normalizeDoi } from './catalog.js';

const DEFAULT_UA = 'dsh-zotero-flow/1.0 (DSH Desktop plugin; mailto:{mailto})';

function stripTags(text) {
  if (typeof text !== 'string') return undefined;
  const plain = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain === '' ? undefined : plain;
}

function yearOf(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  const match = String(value).match(/(1[6-9]\d{2}|20\d{2}|21\d{2})/);
  return match ? Number(match[1]) : undefined;
}

/** 统一的文献记录。所有字段都可能缺省。 */
function emptyWork() {
  return {
    doi: undefined,
    title: undefined,
    authors: [],
    year: undefined,
    date: undefined,
    containerTitle: undefined,
    volume: undefined,
    issue: undefined,
    pages: undefined,
    publisher: undefined,
    type: undefined,
    issn: undefined,
    isbn: undefined,
    abstract: undefined,
    url: undefined,
    language: undefined,
    arxivId: undefined,
    oaPdfUrl: undefined,
    sources: [],
  };
}

function crossrefDate(message) {
  const candidates = [
    message['published-print'],
    message['published-online'],
    message.published,
    message.issued,
    message.created,
  ];
  for (const candidate of candidates) {
    const parts = candidate?.['date-parts']?.[0];
    if (Array.isArray(parts) && parts.length > 0 && Number.isFinite(parts[0])) {
      const [y, m, d] = parts;
      const mm = Number.isFinite(m) ? String(m).padStart(2, '0') : undefined;
      const dd = Number.isFinite(d) ? String(d).padStart(2, '0') : undefined;
      return {
        year: y,
        date: mm === undefined ? String(y) : (dd === undefined ? `${y}-${mm}` : `${y}-${mm}-${dd}`),
      };
    }
  }
  return {};
}

function crossrefToWork(message) {
  const work = emptyWork();
  work.sources.push('crossref');
  work.doi = normalizeDoi(message.DOI ?? '') ?? undefined;
  work.title = (Array.isArray(message.title) ? message.title[0] : message.title) ?? undefined;
  work.containerTitle = (Array.isArray(message['container-title']) ? message['container-title'][0] : message['container-title']) ?? undefined;
  work.volume = message.volume ?? undefined;
  work.issue = message.issue ?? undefined;
  work.pages = message.page ?? undefined;
  work.publisher = message.publisher ?? undefined;
  work.type = message.type ?? undefined;
  work.url = message.URL ?? undefined;
  work.issn = Array.isArray(message.ISSN) ? message.ISSN[0] : message.ISSN ?? undefined;
  work.isbn = Array.isArray(message.ISBN) ? message.ISBN[0] : message.ISBN ?? undefined;
  work.abstract = stripTags(message.abstract);
  work.language = message.language ?? undefined;

  const { year, date } = crossrefDate(message);
  work.year = year;
  work.date = date;

  const authors = Array.isArray(message.author) ? message.author : [];
  work.authors = authors.map((author) => ({
    given: author.given ?? undefined,
    family: author.family ?? undefined,
    name: author.name ?? undefined,
  })).filter((author) => author.name !== undefined || author.family !== undefined || author.given !== undefined);
  return work;
}

function openAlexToWork(record) {
  const work = emptyWork();
  work.sources.push('openalex');
  work.doi = normalizeDoi(record.doi ?? '') ?? undefined;
  work.title = record.title ?? record.display_name ?? undefined;
  const location = record.primary_location ?? record.host_venue;
  work.containerTitle = location?.source?.display_name ?? undefined;
  work.volume = record.biblio?.volume ?? undefined;
  work.issue = record.biblio?.issue ?? undefined;
  if (record.biblio?.first_page) {
    work.pages = record.biblio.last_page
      ? `${record.biblio.first_page}-${record.biblio.last_page}`
      : String(record.biblio.first_page);
  }
  work.publisher = location?.source?.host_organization_name ?? record.publisher ?? undefined;
  work.type = record.type ?? undefined;
  work.url = location?.landing_page_url ?? record.id ?? undefined;
  work.year = record.publication_year ?? undefined;
  work.date = record.publication_date ?? (record.publication_year ? String(record.publication_year) : undefined);
  work.language = record.language ?? undefined;
  work.oaPdfUrl = record.best_oa_location?.pdf_url ?? record.open_access?.oa_url ?? undefined;

  const abstracts = record.abstract_inverted_index;
  if (abstracts && typeof abstracts === 'object') {
    const slots = [];
    const maxTokens = 10000;
    let entries = 0;
    let inspected = 0;
    for (const word in abstracts) {
      if (!Object.hasOwn(abstracts, word)) continue;
      if (++entries > maxTokens || inspected >= maxTokens * 2) break;
      const positions = abstracts[word];
      if (!Array.isArray(positions) || word.length > 1000) continue;
      for (const position of positions) {
        if (++inspected > maxTokens * 2) break;
        if (Number.isInteger(position) && position >= 0 && position < maxTokens) slots[position] = word;
      }
    }
    const text = slots.filter(Boolean).join(' ').trim();
    if (text !== '') work.abstract = text;
  }

  work.authors = (Array.isArray(record.authorships) ? record.authorships : []).map((authorship) => ({
    given: authorship.author?.given_name ?? undefined,
    family: authorship.author?.family_name ?? undefined,
    name: authorship.author?.display_name ?? undefined,
  })).filter((author) => author.name !== undefined || author.family !== undefined);

  const ids = record.ids ?? {};
  const arxiv = typeof ids.arxiv === 'string' ? ids.arxiv : undefined;
  if (arxiv !== undefined) {
    work.arxivId = arxiv.replace(/^https?:\/\/arxiv\.org\/abs\//, '');
    if (work.oaPdfUrl === undefined) work.oaPdfUrl = `https://arxiv.org/pdf/${work.arxivId}`;
  }
  return work;
}

/** 合并两份来源，早出现的字段优先，空字段由后者补齐。 */
function mergeWorks(primary, secondary) {
  if (primary === undefined) return secondary;
  if (secondary === undefined) return primary;
  const merged = { ...primary };
  for (const [key, value] of Object.entries(secondary)) {
    if (key === 'sources') {
      merged.sources = [...new Set([...(primary.sources ?? []), ...(secondary.sources ?? [])])];
      continue;
    }
    if (key === 'authors') {
      if (!Array.isArray(merged.authors) || merged.authors.length === 0) merged.authors = value;
      continue;
    }
    if (merged[key] === undefined || merged[key] === null || merged[key] === '') merged[key] = value;
  }
  return merged;
}

/** arXiv ID → 最小可用 Work（arXiv 不做检索，只按 ID 直接拼）。 */
export function arxivWork(id) {
  const cleaned = String(id).replace(/^arxiv:/i, '').replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, '').replace(/\.pdf$/i, '');
  const work = emptyWork();
  work.sources.push('arxiv');
  work.arxivId = cleaned;
  work.title = `arXiv:${cleaned}`;
  work.url = `https://arxiv.org/abs/${cleaned}`;
  work.oaPdfUrl = `https://arxiv.org/pdf/${cleaned}`;
  work.type = 'posted-content';
  work.doi = normalizeDoi(`10.48550/arXiv.${cleaned}`) ?? undefined;
  return work;
}

/** 从任意输入里识别 arXiv ID。 */
export function arxivIdFrom(input) {
  if (typeof input !== 'string') return undefined;
  const match = input.match(/(?:arxiv[:\s/]|arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:\.pdf)?/i);
  if (!match) return undefined;
  if (!/\d{4}\.\d{4,5}/.test(match[1]) && !/\/\d{7}/.test(match[1])) return undefined;
  return match[1];
}

/**
 * Work → Zotero 翻译器条目（ItemSaver 的输入格式）。
 * @param {object} work 统一 Work
 * @param {object} [overrides] 人工补充的字段，优先于抓取结果
 */
export function workToZoteroItem(work, overrides = {}) {
  const typeMap = {
    'journal-article': 'journalArticle',
    article: 'journalArticle',
    'proceedings-article': 'conferencePaper',
    proceedings: 'conferencePaper',
    'book-chapter': 'bookSection',
    'book-part': 'bookSection',
    book: 'book',
    monograph: 'book',
    dissertation: 'thesis',
    'posted-content': 'preprint',
    preprint: 'preprint',
    report: 'report',
    dataset: 'dataset',
    review: 'journalArticle',
  };
  const itemType = overrides.itemType ?? typeMap[String(work.type ?? '').toLowerCase()] ?? 'journalArticle';

  const creators = [];
  for (const author of work.authors ?? []) {
    if (author.name !== undefined) {
      creators.push({ creatorType: 'author', name: String(author.name) });
    } else if (author.family !== undefined || author.given !== undefined) {
      creators.push({
        creatorType: 'author',
        firstName: author.given ?? '',
        lastName: author.family ?? author.given ?? '',
      });
    }
  }
  if (Array.isArray(overrides.creators)) {
    creators.length = 0;
    creators.push(...overrides.creators);
  }

  const item = {
    itemType,
    title: overrides.title ?? work.title ?? '(无标题)',
  };
  if (creators.length > 0) item.creators = creators;

  const fields = {
    abstractNote: overrides.abstractNote ?? work.abstract,
    publicationTitle: overrides.publicationTitle ?? work.containerTitle,
    bookTitle: overrides.bookTitle ?? (itemType === 'bookSection' ? work.containerTitle : undefined),
    proceedingsTitle: overrides.proceedingsTitle ?? (itemType === 'conferencePaper' ? work.containerTitle : undefined),
    volume: overrides.volume ?? work.volume,
    issue: overrides.issue ?? work.issue,
    pages: overrides.pages ?? work.pages,
    date: overrides.date ?? work.date ?? (work.year === undefined ? undefined : String(work.year)),
    publisher: overrides.publisher ?? work.publisher,
    DOI: overrides.DOI ?? work.doi,
    url: overrides.url ?? work.url,
    ISSN: overrides.ISSN ?? work.issn,
    ISBN: overrides.ISBN ?? work.isbn,
    language: overrides.language ?? work.language,
    libraryCatalog: overrides.libraryCatalog,
    place: overrides.place,
    university: overrides.university ?? (itemType === 'thesis' ? work.publisher : undefined),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') item[key] = String(value);
  }

  const extras = [];
  if (work.arxivId !== undefined) extras.push(`arXiv:${work.arxivId}`);
  if (Array.isArray(work.sources) && work.sources.length > 0) extras.push(`元数据来源: ${work.sources.join(', ')}`);
  if (typeof overrides.extra === 'string' && overrides.extra !== '') extras.push(overrides.extra);
  if (extras.length > 0) item.extra = extras.join('\n');

  return item;
}

/** 常见出版社页面的元数据兜底（从页面 <meta> 抽取后调用）。 */
export function workFromPageMeta(meta) {
  const work = emptyWork();
  work.sources.push('page-meta');
  work.doi = normalizeDoi(meta.doi ?? '') ?? undefined;
  work.title = meta.title;
  work.containerTitle = meta.journal;
  work.date = meta.date;
  work.year = yearOf(meta.date);
  work.issn = meta.issn;
  work.volume = meta.volume;
  work.issue = meta.issue;
  work.pages = meta.pages;
  work.oaPdfUrl = meta.pdfUrl;
  work.url = meta.url;
  if (typeof meta.authors === 'string' && meta.authors !== '') {
    work.authors = meta.authors.split(/\s*;\s*|\s+and\s+/).filter(Boolean).map((name) => {
      const parts = name.trim().split(/\s+/);
      if (parts.length === 1) return { name: parts[0] };
      return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
    });
  }
  return work;
}

const DOI_IN_BYTES = /10\.\d{4,9}\/[A-Za-z0-9()<>[\]{};:/?&=+$_.!~*'%\-]+/g;

/**
 * 从 PDF 原始字节里找 DOI。
 * 优先看 XMP / Info 字典里的明文，其次全文扫一遍。
 */
export function doiFromPdfBytes(bytes) {
  const buffer = Buffer.from(bytes);
  const head = buffer.subarray(0, Math.min(buffer.length, 512 * 1024)).toString('latin1');

  const xmp = head.match(/<dc:identifier>[^<]*?(10\.\d{4,9}\/[^<\s]+)<\/dc:identifier>/i);
  if (xmp) {
    const doi = normalizeDoi(xmp[1]);
    if (doi !== undefined) return { doi, where: 'xmp' };
  }
  const prism = head.match(/<prism:doi>\s*([^<\s]+)\s*<\/prism:doi>/i);
  if (prism) {
    const doi = normalizeDoi(prism[1]);
    if (doi !== undefined) return { doi, where: 'xmp-prism' };
  }
  const plain = head.match(/(?:doi|DOI)\s*[:=]\s*(10\.\d{4,9}\/[^\s"'<>]+)/);
  if (plain) {
    const doi = normalizeDoi(plain[1]);
    if (doi !== undefined) return { doi, where: 'text' };
  }
  const all = head.match(DOI_IN_BYTES);
  if (all && all.length > 0) {
    // 取出现次数最多的那个，噪声最小
    const counts = new Map();
    for (const candidate of all) {
      const doi = normalizeDoi(candidate);
      if (doi === undefined) continue;
      counts.set(doi, (counts.get(doi) ?? 0) + 1);
    }
    if (counts.size > 0) {
      const [doi] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return { doi, where: 'scan' };
    }
  }
  return undefined;
}

/** PDF 首页标题兜底：抓 XMP dc:title 或 Info /Title。 */
export function titleFromPdfBytes(bytes) {
  const head = Buffer.from(bytes).subarray(0, Math.min(bytes.length, 256 * 1024)).toString('latin1');
  const xmp = head.match(/<dc:title>[\s\S]{0,400}?<rdf:li[^>]*>([\s\S]{1,300}?)<\/rdf:li>/i);
  if (xmp) {
    const title = xmp[1].replace(/\s+/g, ' ').trim();
    if (title !== '') return title;
  }
  const info = head.match(/\/Title\s*\(([^)]{3,300})\)/);
  if (info) {
    const title = info[1].replace(/\\([()\\])/g, '$1').replace(/\s+/g, ' ').trim();
    if (title !== '') return title;
  }
  return undefined;
}

/** 抓取入口：可选代理、超时、统一 UA。 */
export function makeHttp(config = {}) {
  const mailto = typeof config.mailto === 'string' && config.mailto !== '' ? config.mailto : 'anonymous@example.com';
  const userAgent = DEFAULT_UA.replace('{mailto}', mailto);
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 20000;
  let dispatcher;
  let dispatcherTried = false;

  async function getDispatcher() {
    if (dispatcherTried) return dispatcher;
    dispatcherTried = true;
    const proxyUrl = typeof config.proxyUrl === 'string' ? config.proxyUrl.trim() : '';
    if (proxyUrl === '') return undefined;
    try {
      const undici = await import('undici');
      dispatcher = new undici.ProxyAgent({ uri: proxyUrl });
    } catch {
      dispatcher = undefined;
    }
    return dispatcher;
  }

  /** @param {string} url @param {object} [options] */
  async function json(url, options = {}) {
    const agent = await getDispatcher();
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        'User-Agent': userAgent,
        ...(options.headers ?? {}),
      },
      ...(agent === undefined ? {} : { dispatcher: agent }),
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? timeoutMs),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { ok: response.ok, status: response.status, json: parsed, text };
  }

  return { json, userAgent, mailto };
}

/** 按 DOI 取一条完整记录。 */
export async function lookupByDoi(doi, http) {
  const normalized = normalizeDoi(doi);
  if (normalized === undefined) return undefined;

  let work;
  try {
    const response = await http.json(`https://api.crossref.org/works/${encodeURIComponent(normalized)}`);
    if (response.ok && response.json?.message) work = crossrefToWork(response.json.message);
  } catch { /* 继续用 OpenAlex */ }

  try {
    const response = await http.json(`https://api.openalex.org/works/doi:${encodeURIComponent(normalized)}`);
    if (response.ok && response.json?.id) work = mergeWorks(work, openAlexToWork(response.json));
  } catch { /* Crossref 结果已够用 */ }

  if (work === undefined) {
    work = emptyWork();
    work.doi = normalized;
    work.url = `https://doi.org/${normalized}`;
  }
  if (work.url === undefined) work.url = `https://doi.org/${normalized}`;
  return work;
}

/** 按标题/关键词检索，返回候选列表。 */
export async function searchWorks(query, limit, http) {
  const rows = Math.max(1, Math.min(Number(limit) || 5, 20));
  const results = [];
  const seen = new Set();

  try {
    const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${rows}&select=DOI,title,author,container-title,issued,type,volume,issue,page,publisher,URL,ISSN,abstract,language`;
    const response = await http.json(url);
    const items = response.json?.message?.items;
    if (response.ok && Array.isArray(items)) {
      for (const item of items) {
        const work = crossrefToWork(item);
        if (work.doi !== undefined && seen.has(work.doi)) continue;
        if (work.doi !== undefined) seen.add(work.doi);
        results.push(work);
      }
    }
  } catch { /* 落到 OpenAlex */ }

  if (results.length < rows) {
    try {
      const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${rows}`;
      const response = await http.json(url);
      const items = response.json?.results;
      if (response.ok && Array.isArray(items)) {
        for (const item of items) {
          const work = openAlexToWork(item);
          if (work.doi !== undefined && seen.has(work.doi)) continue;
          if (work.doi !== undefined) seen.add(work.doi);
          results.push(work);
        }
      }
    } catch { /* 只返回已有结果 */ }
  }

  return results.slice(0, rows);
}

/** 找开放获取 PDF 直链：OpenAlex 优先，Unpaywall 兜底。 */
export async function openAccessPdf(doi, http, openAlexPdfUrl) {
  if (typeof openAlexPdfUrl === 'string' && openAlexPdfUrl !== '') return openAlexPdfUrl;
  const normalized = normalizeDoi(doi);
  if (normalized === undefined) return undefined;

  try {
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(normalized)}?email=${encodeURIComponent(http.mailto)}`;
    const response = await http.json(url);
    if (response.ok && response.json) {
      const best = response.json.best_oa_location;
      const pdf = best?.url_for_pdf ?? best?.url;
      if (typeof pdf === 'string' && pdf !== '') return pdf;
      const locations = Array.isArray(response.json.oa_locations) ? response.json.oa_locations : [];
      for (const location of locations) {
        if (typeof location?.url_for_pdf === 'string' && location.url_for_pdf !== '') return location.url_for_pdf;
      }
    }
  } catch { /* 没有就没有 */ }
  return undefined;
}
