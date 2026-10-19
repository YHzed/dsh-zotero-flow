/**
 * 数据资源数据库目录。
 *
 * 只收录「确定成立」的事实：站点名、主入口、按 DOI 前缀可推断的出版社归属。
 * 检索 URL 只保留长期稳定的查询串形式；JS 渲染、必须交互、或有反爬校验的
 * 站点标记 js:true / stableSearch:false，让模型知道应当打开页面并交给人工点击，
 * 而不是拼一个会 404 的检索链接。
 */

const DOI_PREFIX_PUBLISHER = [
  ['10.1016', 'elsevier', 'Elsevier / ScienceDirect'],
  ['10.1007', 'springer', 'Springer'],
  ['10.1057', 'springer', 'Palgrave Macmillan (Springer Nature)'],
  ['10.1038', 'springer', 'Nature Portfolio (Springer Nature)'],
  ['10.1186', 'springer', 'BMC (Springer Nature)'],
  ['10.1109', 'ieee', 'IEEE'],
  ['10.1002', 'wiley', 'Wiley'],
  ['10.1111', 'wiley', 'Wiley'],
  ['10.1002/anie', 'wiley', 'Wiley (Angewandte)'],
  ['10.1080', 'tandf', 'Taylor & Francis'],
  ['10.1081', 'tandf', 'Taylor & Francis'],
  ['10.1021', 'acs', 'American Chemical Society'],
  ['10.1088', 'iop', 'IOP Publishing'],
  ['10.1149', 'iop', 'IOP Publishing (ECS)'],
  ['10.1090', 'ams', 'American Mathematical Society'],
  ['10.1145', 'acm', 'ACM'],
  ['10.1006', 'elsevier', 'Elsevier (legacy)'],
  ['10.1007/s', 'springer', 'Springer'],
  ['10.1017', 'cambridge', 'Cambridge University Press'],
  ['10.1088/1742', 'iop', 'IOP Publishing'],
  ['10.1093', 'oup', 'Oxford University Press'],
  ['10.1089', 'liebert', 'Mary Ann Liebert'],
  ['10.1155', 'hindawi', 'Hindawi / Wiley'],
  ['10.3390', 'mdpi', 'MDPI'],
  ['10.1371', 'plos', 'PLOS'],
  ['10.1039', 'rsc', 'Royal Society of Chemistry'],
  ['10.1080/1556', 'tandf', 'Taylor & Francis'],
  ['10.1088/1361', 'iop', 'IOP Publishing'],
];

/** 出版社标识 → 在机构登录下有稳定 PDF 出口的落地站。 */
const PUBLISHER_SITES = {
  elsevier: { siteId: 'sciencedirect', label: 'ScienceDirect' },
  springer: { siteId: 'springer', label: 'Springer Link' },
  ieee: { siteId: 'ieee', label: 'IEEE Xplore' },
  wiley: { siteId: 'wiley', label: 'Wiley Online Library' },
  tandf: { siteId: 'tandf', label: 'Taylor & Francis Online' },
  acs: { siteId: 'acs', label: 'ACS Publications' },
  iop: { siteId: 'iop', label: 'IOPscience' },
  ams: { siteId: 'mathscinet', label: 'AMS (MathSciNet)' },
  acm: { siteId: 'acm', label: 'ACM Digital Library' },
  cambridge: { siteId: 'cambridge', label: 'Cambridge Core' },
  oup: { siteId: 'oup', label: 'Oxford Academic' },
  rsc: { siteId: 'rsc', label: 'Royal Society of Chemistry' },
  mdpi: { siteId: 'mdpi', label: 'MDPI' },
  plos: { siteId: 'plos', label: 'PLOS' },
  hindawi: { siteId: 'hindawi', label: 'Hindawi' },
  liebert: { siteId: 'liebert', label: 'Mary Ann Liebert' },
};

/**
 * 数据库 / 出版社站点目录。顺序大致对应校内「数据资源数据库」列表。
 * @typedef {object} LibrarySite
 * @property {string} id 稳定标识，工具参数用
 * @property {string} name 展示名
 * @property {string} host 主机名
 * @property {string} home 主入口
 * @property {string|null} search 检索 URL 模板，{q} 为关键词占位符
 * @property {boolean} stableSearch search 是否为可直接跳转的稳定链接
 * @property {boolean} js 页面是否依赖 JS 渲染 / 需要交互才能出结果
 * @property {'meta-pdf'|'mixed'|'manual'} pdf 获取 PDF 的可行路径
 *   meta-pdf：落地页通常带 citation_pdf_url，可自动取到 PDF 直链
 *   mixed：部分条目有直链，部分需要人工点击
 *   manual：几乎只能人工在已登录页面里点下载
 * @property {string} color 卡片配色
 * @property {string} note 给模型的一句话提示
 */

/** @type {LibrarySite[]} */
export const LIBRARY_SITES = [
  {
    id: 'cnki',
    name: '中国知网',
    host: 'www.cnki.net',
    home: 'https://www.cnki.net/',
    search: 'https://kns.cnki.net/kns8s/defaultresult/index?kw={q}',
    stableSearch: false,
    js: true,
    pdf: 'manual',
    color: '#c8452f',
    note: '知网结果为 JS 渲染且有条数校验，PDF 多为分章节或需登录后点「PDF 下载」。请打开检索页，让人工在已登录窗口里点下载，插件会接管下载目录里出现的文件。',
  },
  {
    id: 'wanfang',
    name: '万方数据知识服务平台',
    host: 'g.wanfangdata.com.cn',
    home: 'https://g.wanfangdata.com.cn/',
    search: 'https://s.wanfangdata.com.cn/paper?q={q}',
    stableSearch: false,
    js: true,
    pdf: 'manual',
    color: '#2f6fb5',
    note: '检索走 JS 接口；登录机构账号后条目页有「下载全文」。适合人工点击 + 插件监视下载目录。',
  },
  {
    id: 'sciencedirect',
    name: 'ScienceDirect',
    host: 'www.sciencedirect.com',
    home: 'https://www.sciencedirect.com/',
    search: 'https://www.sciencedirect.com/search?qs={q}',
    stableSearch: true,
    js: false,
    pdf: 'meta-pdf',
    color: '#e2732a',
    note: '落地页含 citation_pdf_url；机构订阅下可直接取到 https://www.sciencedirect.com/science/article/pii/.../pdfft 直链。',
  },
  {
    id: 'webofscience',
    name: 'Web of Science',
    host: 'webofscience.clarivate.cn',
    home: 'https://webofscience.clarivate.cn/wos/woscc/basic-search',
    search: null,
    stableSearch: false,
    js: true,
    pdf: 'manual',
    color: '#6b5bd2',
    note: 'WoS 只做索引与文献传递，本身不托管 PDF。用它定位 DOI，再到出版社站点取全文。',
  },
  {
    id: 'springer',
    name: 'Springer Link',
    host: 'link.springer.com',
    home: 'https://link.springer.com/',
    search: 'https://link.springer.com/search?query={q}',
    stableSearch: true,
    js: false,
    pdf: 'meta-pdf',
    color: '#1b7f4c',
    note: '落地页含 citation_pdf_url，形如 https://link.springer.com/content/pdf/10.1007/sxxxxx.pdf。',
  },
  {
    id: 'ieee',
    name: 'IEL / IEEE Xplore',
    host: 'ieeexplore.ieee.org',
    home: 'https://ieeexplore.ieee.org/',
    search: 'https://ieeexplore.ieee.org/search/searchresult.jsp?queryText={q}',
    stableSearch: true,
    js: true,
    pdf: 'meta-pdf',
    color: '#0a6bb8',
    note: '落地页含 citation_pdf_url，形如 https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=xxxxxxx。检索页是 JS 渲染，直接跳转检索串通常可出结果。',
  },
  {
    id: 'wiley',
    name: 'Wiley Online Library',
    host: 'onlinelibrary.wiley.com',
    home: 'https://onlinelibrary.wiley.com/',
    search: 'https://onlinelibrary.wiley.com/action/doSearch?AllField={q}',
    stableSearch: true,
    js: false,
    pdf: 'meta-pdf',
    color: '#0f7c8c',
    note: '落地页含 citation_pdf_url，形如 https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/xxx。',
  },
  {
    id: 'tandf',
    name: 'Taylor & Francis Online',
    host: 'www.tandfonline.com',
    home: 'https://www.tandfonline.com/',
    search: 'https://www.tandfonline.com/action/doSearch?AllField={q}',
    stableSearch: true,
    js: false,
    pdf: 'meta-pdf',
    color: '#b0342c',
    note: '落地页含 citation_pdf_url；订阅内容需要机构登录。',
  },
  {
    id: 'acs',
    name: 'ACS Publications',
    host: 'pubs.acs.org',
    home: 'https://pubs.acs.org/',
    search: 'https://pubs.acs.org/action/doSearch?AllField={q}',
    stableSearch: true,
    js: false,
    pdf: 'meta-pdf',
    color: '#2b7bb9',
    note: '落地页含 citation_pdf_url，形如 https://pubs.acs.org/doi/pdf/10.1021/xxx。',
  },
  {
    id: 'scifinder',
    name: 'SciFinder-n',
    host: 'sso.cas.org',
    home: 'https://sso.cas.org/',
    search: null,
    stableSearch: false,
    js: true,
    pdf: 'manual',
    color: '#3b7f9e',
    note: '需要 CAS 账号或机构 SSO，且为纯 JS 应用。不提供自动下载，只用于人工检索与取原文链接。',
  },
  {
    id: 'iop',
    name: 'IOPscience',
    host: 'iopscience.iop.org',
    home: 'https://iopscience.iop.org/',
    search: null,
    stableSearch: false,
    js: false,
    pdf: 'meta-pdf',
    color: '#5a4a9c',
    note: '检索页无稳定查询串，但 DOI 落地页含 citation_pdf_url，直接用 DOI 打开即可。',
  },
  {
    id: 'mathscinet',
    name: 'MathSciNet',
    host: 'mathscinet.ams.org',
    home: 'https://mathscinet.ams.org/mathscinet/',
    search: null,
    stableSearch: false,
    js: false,
    pdf: 'manual',
    color: '#8b6b2f',
    note: '数学评论库，主要提供评论与链接；全文多指向出版社，需再跳一次。',
  },
  {
    id: 'proquest',
    name: 'ProQuest 学位论文全文库',
    host: 'www.pqdtcn.com',
    home: 'https://www.pqdtcn.com/',
    search: null,
    stableSearch: false,
    js: true,
    pdf: 'manual',
    color: '#2f5fa8',
    note: '学位论文 PDF 走专门阅读器与分片下载，请人工触发下载后由插件接管文件。',
  },
  {
    id: 'spischolar',
    name: 'SpiScholar 学术资源在线',
    host: 'spis.hnlat.com',
    home: 'https://spis.hnlat.com/',
    search: null,
    stableSearch: false,
    js: true,
    pdf: 'mixed',
    color: '#2b9c8f',
    note: '聚合检索与文献传递平台，常能给出可下载的 PDF 直链。',
  },
  {
    id: 'science-reading',
    name: '科学文库',
    host: 'book.sciencereading.cn',
    home: 'https://book.sciencereading.cn/',
    search: null,
    stableSearch: false,
    js: true,
    pdf: 'manual',
    color: '#1f7a4d',
    note: '中文电子书平台，按章节在线阅读，下载通常受限。',
  },
  {
    id: 'chaoxing',
    name: '超星发现 / 读秀（更多）',
    host: 'wisdom.chaoxing.com',
    home: 'https://wisdom.chaoxing.com/',
    search: null,
    stableSearch: false,
    js: true,
    pdf: 'manual',
    color: '#3a6fbf',
    note: '发现系统，常用于定位图书章节与文献传递。',
  },
];

/**
 * 上面这份清单是通用的一份：各校图书馆「数据资源数据库」页面上通常都能看到同样的主流库。
 * 要补上你所在机构独有的入口，往 LIBRARY_SITES 里加同形状的对象即可：
 *
 *   {
 *     id: 'campus-portal',
 *     name: '校内资源门户',
 *     host: 'portal.example.edu.cn',
 *     home: 'https://portal.example.edu.cn/',
 *     search: null,          // 只有长期稳定的查询串才填，用 {q} 占位
 *     stableSearch: false,   // JS 渲染 / 必须交互才能出结果的站点填 false
 *     js: true,
 *     pdf: 'manual',         // 'direct' | 'meta-pdf' | 'manual' | 'mixed'
 *     color: '#5b6b7c',
 *     note: '一句话说明这一站该怎么取全文。',
 *   },
 */

/** 额外的、不在校内清单但常打通的开放站点。 */
export const EXTRA_SITES = [
  {
    id: 'arxiv',
    name: 'arXiv',
    host: 'arxiv.org',
    home: 'https://arxiv.org/',
    search: 'https://arxiv.org/abs/{q}',
    stableSearch: true,
    js: false,
    pdf: 'meta-pdf',
    color: '#b31b1b',
    note: '开放获取；arXiv ID 或 DOI 均可解析，PDF 直链形如 https://arxiv.org/pdf/xxxx.pdf。',
  },
  {
    id: 'doiorg',
    name: 'DOI 解析（Crossref）',
    host: 'doi.org',
    home: 'https://doi.org/',
    search: 'https://doi.org/{q}',
    stableSearch: true,
    js: false,
    pdf: 'mixed',
    color: '#4a5568',
    note: '把 DOI 交给他，会 302 到出版社落地页；在已登录的机构会话里这是最通用的一步。',
  },
];

const ALL_SITES = [...LIBRARY_SITES, ...EXTRA_SITES];

/** 按 id 取站点。 */
export function siteById(id) {
  if (typeof id !== 'string') return undefined;
  const key = id.trim().toLowerCase();
  return ALL_SITES.find((site) => site.id === key);
}

/** 按主机名或名称模糊匹配站点。 */
export function siteByHostOrName(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  const needle = text.trim().toLowerCase();
  return ALL_SITES.find((site) => (
    needle === site.host.toLowerCase()
    || needle === site.name.toLowerCase()
    || site.host.toLowerCase().includes(needle)
    || site.name.toLowerCase().includes(needle)
  ));
}

/** 由 DOI 推断出版社与对应站点。 */
export function publisherFromDoi(doi) {
  if (typeof doi !== 'string') return undefined;
  const normalized = normalizeDoi(doi);
  if (normalized === undefined) return undefined;
  const lower = normalized.toLowerCase();
  // 长前缀优先，避免 10.1002 抢走 10.1002/anie 之外的判断
  const sorted = [...DOI_PREFIX_PUBLISHER].sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, key, label] of sorted) {
    if (lower.startsWith(prefix.toLowerCase())) {
      const site = PUBLISHER_SITES[key];
      return {
        doi: normalized,
        publisherKey: key,
        publisherLabel: label,
        siteId: site?.siteId,
        siteLabel: site?.label,
      };
    }
  }
  return { doi: normalized, publisherKey: 'unknown', publisherLabel: '未识别的出版社前缀', siteId: undefined, siteLabel: undefined };
}

/** 从任意文本里抠出 DOI。 */
export function normalizeDoi(input) {
  if (typeof input !== 'string') return undefined;
  let text = input.trim();
  if (text === '') return undefined;
  text = text.replace(/^doi:\s*/i, '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  text = text.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  const match = text.match(/10\.\d{4,9}\/[^\s"'<>，。；、)】]+/);
  if (!match) return undefined;
  return match[0].replace(/[.,;:]+$/, '');
}

/** DOI → 落地页。 */
export function doiLanding(doi) {
  const normalized = normalizeDoi(doi);
  return normalized === undefined ? undefined : `https://doi.org/${normalized}`;
}

/** 用关键词填充站点检索模板。 */
export function siteSearchUrl(site, query) {
  if (!site || typeof site.search !== 'string') return undefined;
  return site.search.replace('{q}', encodeURIComponent(String(query ?? '')));
}

/** 需要模型挑选时使用的紧凑清单。 */
export function catalogForModel() {
  return LIBRARY_SITES.map((site) => ({
    id: site.id,
    name: site.name,
    host: site.host,
    pdf: site.pdf,
    js: site.js,
    search: site.search !== null && site.stableSearch ? site.search : null,
  }));
}

/** 卡片网格用的展示数据。 */
export function catalogCards() {
  return LIBRARY_SITES.map((site) => ({
    id: site.id,
    name: site.name,
    host: site.host,
    color: site.color,
    pdf: site.pdf,
    autoSearch: site.search !== null && site.stableSearch,
  }));
}

export const SITE_COUNT = LIBRARY_SITES.length;
