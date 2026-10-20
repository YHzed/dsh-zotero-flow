/**
 * 机构登录用的浏览器会话。
 *
 * 思路：用**独立的浏览器资料目录**起一个可见的 Edge/Chrome，开启 CDP，
 * 让用户在这个窗口里完成一次学校 SSO / CARSI / WebVPN 登录；Cookie 落在
 * 该资料目录里长期保留。之后 agent 就可以在这个已认证会话里
 *
 *   1. 打开数据库 / DOI 落地页，读出 citation_pdf_url、DOI、PDF 直链；
 *   2. 直接导航到 PDF 地址，用 Network 域把响应体抓下来（绕过 CORS，
 *      也绕开 Edge 内建 PDF 阅读器「只显示不下载」的问题）；
 *   3. 抓不到时退回页面内 fetch，再退回监视下载目录（人工点击下载）。
 *
 * 只依赖 Node 内置能力：fetch + 全局 WebSocket（Node 22+ 自带）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { MAX_PDF_BYTES, readPdfFile, boundedMs, webUrl, validPort, cdpSocketUrl, interventionHints, interventionResult } from './safety.js';

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/microsoft-edge',
  '/usr/bin/chromium',
];

export function findBrowser(explicitPath) {
  if (typeof explicitPath === 'string' && explicitPath.trim() !== '') {
    return existsSync(explicitPath) ? explicitPath : undefined;
  }
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 用文件头判断是不是真 PDF，避免把「拦截页 / 空文件」当成功。 */
function looksLikePdf(bytes) {
  if (bytes === undefined || bytes === null || bytes.length < 5) return false;
  return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** 用文件名判断像不像 PDF（有些站点 Content-Type 给 octet-stream）。 */
function looksLikePdfUrl(url) {
  return typeof url === 'string' && /\.pdf(\?|#|$)/i.test(url);
}

/** 极简 CDP 客户端：一个 WebSocket 复用所有 target 会话。 */
class CdpConnection {
  constructor(webSocketUrl) {
    this.url = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 15000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      this.socket.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket 连接失败：${event?.message ?? 'unknown'}`));
      });
    });
    this.socket.addEventListener('message', (event) => this.#onMessage(event.data));
    this.socket.addEventListener('close', () => {
      this.closed = true;
      for (const [, entry] of this.pending) entry.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message}${message.error.data ? ` (${message.error.data})` : ''}`));
      else entry.resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify(payload));
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    try { this.socket.close(); } catch { /* 已关闭 */ }
  }
}

/** 在页面里跑的一段自包含脚本：抽取 DOI / 引文 PDF 直链 / 登录迹象。 */
const ANALYZE_EXPRESSION = `(() => {
  const meta = (names) => {
    for (const name of names) {
      const el = document.querySelector('meta[name="' + name + '"]')
        || document.querySelector('meta[property="' + name + '"]')
        || document.querySelector('meta[name="' + name.toLowerCase() + '"]');
      if (el && el.content) return el.content.trim();
    }
    return undefined;
  };
  const pdfLinks = [];
  const seen = new Set();
  const push = (url, text) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    pdfLinks.push({ url, text: (text || '').slice(0, 120) });
  };
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const href = a.href || '';
    const label = (a.textContent || '').trim();
    if (/\\.pdf(\\?|#|$)/i.test(href) || /\\/pdf\\b|pdfdirect|pdfft|getPDF|stampPDF|fulltext|download/i.test(href) || /pdf|全文|下载/i.test(label)) {
      push(href, label);
    }
  }
  const citationPdf = meta(['citation_pdf_url']);
  if (citationPdf) push(citationPdf, 'citation_pdf_url');
  // ScienceDirect 的 PDF 链接不放 <meta>，而是埋在页面 JSON 里的 md5/pid。
  // 页面路径形如 …/science/article/pii/<PII>，据此拼出可下载的 pdfft 地址。
  let scienceDirectPdfPath = null;
  try {
    const pii = (location.pathname.split('/pii/')[1] || '').split('/')[0];
    if (pii) {
      const flat = document.documentElement.outerHTML.replace(/\\\\/g, '');
      const md5 = flat.match(/md5"?:"?([0-9a-f]{16,})/i);
      // pid 只认严格形态：页面里别的地方也有 "pid"，宽松匹配会抓错。
      const expectedPid = '1-s2.0-' + pii + '-main.pdf';
      // Never substitute a reference article's pid or invent a fallback endpoint.
      if (md5 && /^[A-Za-z0-9]+$/.test(pii) && flat.includes(expectedPid)) {
        scienceDirectPdfPath = new URL('/science/article/pii/' + pii + '/pdfft?md5=' + md5[1]
          + '&pid=' + expectedPid, location.origin).href;
      }
    }
  } catch (error) { /* 不是 ScienceDirect 就算了 */ }
  const bodyText = (document.body ? document.body.innerText : '').slice(0, 4000);
  const loginHints = [];
  for (const [pattern, hint] of [
    [/\\b(sign in|log in|login)\\b/i, '需要登录'],
    [/institutional|机构|图书馆|统一身份|CARSI|校外访问|VPN/i, '机构/校外访问入口'],
    [/purchase|buy this article|获取全文|订阅|付费|purchase access|get access/i, '可能无订阅权限'],
    [/access denied|403 forbidden|not authorized/i, '访问被拒绝'],
    [/verify you are human|captcha|just a moment|checking your browser|turnstile|验证您是真人|验证码|安全验证|滑动验证/i, '有人机校验，需要人工操作'],
  ]) {
    if (pattern.test(bodyText)) loginHints.push(hint);
  }
  return JSON.stringify({
    url: location.href,
    title: document.title || '',
    contentType: document.contentType || '',
    citationPdfUrl: citationPdf || null,
    doi: meta(['citation_doi', 'dc.identifier', 'DC.Identifier', 'dc.Identifier.DOI']) || null,
    journal: meta(['citation_journal_title', 'dc.source', 'DC.Source']) || null,
    date: meta(['citation_publication_date', 'citation_date', 'dc.date', 'DC.Date', 'citation_online_date']) || null,
    volume: meta(['citation_volume']) || null,
    issue: meta(['citation_issue']) || null,
    pages: meta(['citation_firstpage']) ? (meta(['citation_firstpage']) + (meta(['citation_lastpage']) ? '-' + meta(['citation_lastpage']) : '')) : null,
    issn: meta(['citation_issn']) || null,
    authors: meta(['citation_author', 'dc.creator', 'DC.Creator']) || null,
    pdfLinks: pdfLinks.slice(0, 25),
    scienceDirectPdfPath,
    loginHints,
    bodyPreview: bodyText.slice(0, 600),
  });
})()`;

/** 页面内 fetch 成 base64（跨域会被 CORS 拦，作为兜底使用）。 */
const FETCH_BASE64_EXPRESSION = (url) => `(async () => {
  try {
    const response = await fetch(${JSON.stringify(url)}, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) return JSON.stringify({ ok: false, status: response.status });
    const max = ${MAX_PDF_BYTES};
    if (Number(response.headers.get('content-length')) > max || !response.body) return JSON.stringify({ok:false});
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.length;
        if (total > max) { await reader.cancel(); return JSON.stringify({ok:false}); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const part of chunks) { buffer.set(part, offset); offset += part.length; }
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < buffer.length; i += chunk) {
      binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
    }
    return JSON.stringify({
      ok: true,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      base64: btoa(binary),
    });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error && error.message || error) });
  }
})()`;

/** 新的浏览器会话控制器。 */
export function createBrowserSession(config = {}) {
  const cdpPort = validPort(config.cdpPort ?? 9333);
  const profileDir = typeof config.browserProfileDir === 'string' && config.browserProfileDir !== ''
    ? config.browserProfileDir
    : path.join(homedir(), '.dsh-zotero-flow', 'edge-profile');
  const downloadDir = typeof config.downloadDir === 'string' && config.downloadDir !== ''
    ? config.downloadDir
    : path.join(homedir(), '.dsh-zotero-flow', 'downloads');
  const osDownloadDir = path.join(homedir(), 'Downloads');
  const browserPath = findBrowser(config.browserPath);

  let connection;
  let browserProps;
  let launchPromise;
  // Only targets created by this controller may be automatically closed.
  const ownedTargets = new Set();
  const targetGuards = new Map();
  const blockedResponses = new Map();
  let landing;

  async function cdpHttp(pathname) {
    const response = await fetch(`http://127.0.0.1:${cdpPort}${pathname}`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
    if (!response.ok) throw new Error(`CDP HTTP ${pathname} 返回 ${response.status}`);
    return response.json();
  }

  async function isRunning() {
    try {
      const version = await cdpHttp('/json/version');
      return version;
    } catch {
      return undefined;
    }
  }

  /**
   * Chromium 默认用内建阅读器**显示** PDF，此时响应体不经网络栈暴露给 CDP，
   * 也没法落盘。把这套独立资料目录设成「PDF 一律下载」，PDF 就会直接进
   * downloadDir —— 既拿到字节，用户也顺手得到文件。必须在启动前写入。
   */
  async function ensureProfilePrefs() {
    const defaultDir = path.join(profileDir, 'Default');
    await mkdir(defaultDir, { recursive: true });
    const prefsPath = path.join(defaultDir, 'Preferences');
    let prefs = {};
    try {
      prefs = JSON.parse(await readFile(prefsPath, 'utf8'));
    } catch {
      prefs = {};
    }
    if (prefs.plugins?.always_open_pdf_externally === true) return { changed: false, prefsPath };
    prefs.plugins = { ...(prefs.plugins ?? {}), always_open_pdf_externally: true };
    prefs.download = {
      ...(prefs.download ?? {}),
      default_directory: downloadDir,
      prompt_for_download: false,
      directory_upgrade: true,
    };
    try {
      await writeFile(prefsPath, JSON.stringify(prefs), 'utf8');
      return { changed: true, prefsPath };
    } catch (error) {
      return { changed: false, prefsPath, error: error.message };
    }
  }

  async function connect() {
    const version = await isRunning();
    if (version === undefined) throw new Error(`调试端口 ${cdpPort} 上没有浏览器`);
    if (connection === undefined || connection.closed) {
      connection = new CdpConnection(cdpSocketUrl(version.webSocketDebuggerUrl, cdpPort));
      await connection.ready;
    }
    if (browserProps === undefined) {
      browserProps = await connection.send('Browser.getVersion');
    }
    return { version, browserProps };
  }

  async function launch() {
    if (browserPath === undefined) {
      throw new Error('没找到 Edge/Chrome。请在插件配置里把 browserPath 指向浏览器可执行文件。');
    }
    await mkdir(profileDir, { recursive: true });
    await mkdir(downloadDir, { recursive: true });
    await ensureProfilePrefs();

    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeSidebarV2',
      '--start-maximized',
      'about:blank',
    ];
    const child = spawn(browserPath, args, { detached: true, stdio: 'ignore' });
    child.unref();

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const version = await isRunning();
      if (version !== undefined) return version;
      await sleep(500);
    }
    throw new Error(`浏览器已启动但调试端口 ${cdpPort} 30 秒内没有就绪，可能是端口被占用。`);
  }

  /** 确保浏览器在跑并且 CDP 已连上。 */
  async function ensure() {
    const running = await isRunning();
    if (running === undefined) {
      if (launchPromise === undefined) {
        launchPromise = launch().finally(() => { launchPromise = undefined; });
      }
      await launchPromise;
    }
    const { version } = await connect();
    try {
      await connection.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
        eventsEnabled: true,
      });
    } catch { /* 某些版本不支持 eventsEnabled，忽略 */ }
    return { browserPath, cdpPort, profileDir, downloadDir, browser: version.Browser };
  }

  async function listTabs() {
    const targets = await cdpHttp('/json/list');
    return targets
      .filter((target) => target.type === 'page')
      .map((target) => ({ id: target.id, url: target.url, title: target.title, webSocketDebuggerUrl: target.webSocketDebuggerUrl }));
  }

  async function attach(targetId) {
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    const off = connection.on((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Network.responseReceived' && message.params.type === 'Document') {
        const status = message.params.response?.status;
        if ([403, 429].includes(status)) blockedResponses.set(sessionId, status);
        else if (status >= 200 && status < 300) blockedResponses.delete(sessionId);
      }
      if (message.method !== 'Fetch.requestPaused') return;
      const requestId = message.params.requestId;
      let allowed = false;
      try { webUrl(message.params.request.url); allowed = true; } catch { /* reject */ }
      connection.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
    });
    try {
      await connection.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }, sessionId);
      await connection.send('Network.enable', {}, sessionId);
    } catch (error) { off(); throw error; }
    targetGuards.set(targetId, off);
    return sessionId;
  }

  async function createTab(url = 'about:blank') {
    const { targetId } = await connection.send('Target.createTarget', { url });
    ownedTargets.add(targetId);
    const sessionId = await attach(targetId);
    return { targetId, sessionId };
  }

  async function closeTab(targetId) {
    if (!ownedTargets.has(targetId)) return;
    try {
      await connection.send('Target.closeTarget', { targetId });
      ownedTargets.delete(targetId);
      targetGuards.get(targetId)?.();
      targetGuards.delete(targetId);
    } catch { /* 已经关了 */ }
  }

  async function evaluate(sessionId, expression) {
    const result = await connection.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(`页面脚本执行失败：${result.exceptionDetails.text ?? 'unknown'}`);
    }
    return result.result?.value;
  }

  async function waitForLoad(sessionId, timeoutMs = 30000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { off(); resolve({ loaded: false }); }, timeoutMs);
      const off = connection.on((message) => {
        if (message.method === 'Page.loadEventFired' && message.sessionId === sessionId) {
          clearTimeout(timer);
          off();
          resolve({ loaded: true });
        }
      });
    });
  }

  /**
   * 抓一个 PDF。
   *
   * 三条通道同时进行，谁先拿到字节就用谁：
   *   A. 下载落盘：资料目录已设成「PDF 一律下载」，导航即触发下载，
   *      文件进 downloadDir（或系统下载目录）—— 最稳，且不挑站点。
   *   B. Network 响应体：对走 XHR/内联返回 PDF 的页面有效。
   *   C. 页面内 fetch：同源或允许 CORS 时最快。
   *
   * @returns {Promise<{bytes?: Buffer, path?: string, mimeType?: string, finalUrl?: string, via?: string, error?: string, page?: object}>}
   */
  async function capturePdf(url, options = {}) {
    url = webUrl(url);
    const timeoutMs = boundedMs(options.timeoutMs, 90000);
    // 自己把浏览器会话准备好：调用方不一定先调过 open()/ensure()，
    // 而下面立刻要用 connection，缺了会报 "Cannot read properties of undefined (reading 'send')"。
    await ensure();
    // Recheck a previously blocked landing page; never automatically bypass it.
    if (landing?.blocked) {
      const current = await analyze(landing.sessionId);
      if (interventionHints(current).length) return interventionResult(current);
      landing.blocked = false;
    }
    const since = Date.now();
    const abort = new AbortController();
    const { targetId, sessionId } = await createTab('about:blank');
    let succeeded = false;
    let intervention;

    const candidates = [];
    const cleanup = [];

    // 通道 A：PDF 会被直接下载，轮询目录并校验文件头
    const downloadPromise = waitForDownload({
      since,
      timeoutMs,
      dirs: [downloadDir],
      signal: abort.signal,
      accept: async (found) => Boolean(await readPdfFile(found.path).catch(() => undefined)),
    }).then(async (found) => {
      if (found === undefined) return undefined;
      const bytes = await readPdfFile(found.path);
      return { bytes, path: found.path, mimeType: 'application/pdf', via: 'download' };
    });
    const networkPromise = new Promise((resolve) => {
      const off = connection.on((message) => {
        if (message.sessionId !== sessionId) return;
        if (message.method === 'Network.responseReceived') {
          const { requestId, response } = message.params;
          if (message.params.type === 'Document' && [403, 429].includes(response?.status)) {
            intervention = { url: response.url, loginHints: [response.status === 429 ? '站点限流 429' : '访问被拒绝'] };
            resolve(interventionResult(intervention));
            return;
          }
          const mime = String(response?.mimeType ?? '').toLowerCase();
          const responseUrl = String(response?.url ?? '');
          const looksPdf = mime.includes('pdf')
            || /\.pdf(\?|#|$)/i.test(responseUrl)
            || (mime === 'application/octet-stream' && /pdf/i.test(responseUrl));
          if (looksPdf && candidates.length < 64 && Number(response.status) >= 200 && Number(response.status) < 300) {
            try { webUrl(responseUrl); } catch { return; }
            candidates.push({ requestId, mimeType: mime, url: responseUrl });
          }
        }
        if (message.method === 'Network.loadingFinished') {
          const candidate = candidates.find((item) => item.requestId === message.params.requestId);
          if (!candidate || candidate.attempted) return;
          candidate.attempted = true;
          if (message.params.encodedDataLength > MAX_PDF_BYTES) return;
          connection.send('Network.getResponseBody', { requestId: candidate.requestId }, sessionId)
            .then((body) => {
              if (typeof body.body !== 'string' || body.body.length > Math.ceil(MAX_PDF_BYTES * 4 / 3) + 4) return;
              const bytes = Buffer.from(body.body, body.base64Encoded === true ? 'base64' : 'utf8');
              if (looksLikePdf(bytes) && bytes.length <= MAX_PDF_BYTES) {
                resolve({ bytes, mimeType: candidate.mimeType, finalUrl: candidate.url, via: 'network' });
              }
            })
            .catch(() => { /* 响应体可能已被阅读器接管或回收 */ });
        }
      });
      cleanup.push(off);
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref?.();
      cleanup.push(() => clearTimeout(timer));
    });

    let info = {};
    try {
      await connection.send('Network.enable', {}, sessionId);
      await connection.send('Page.enable', {}, sessionId);
      await connection.send('Page.navigate', { url }, sessionId);

      const raced = await Promise.race([
        downloadPromise,
        networkPromise,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(undefined), timeoutMs);
          cleanup.push(() => clearTimeout(timer));
        }),
        // Read the rendered page over CDP only; never refresh/retry a challenge.
        new Promise((resolve) => {
          const timer = setTimeout(async () => {
            try {
              const page = await analyze(sessionId);
              if (interventionHints(page).length) { intervention = page; resolve(interventionResult(page)); }
            } catch { /* navigation may still be loading */ }
          }, Math.min(timeoutMs, 1500));
          cleanup.push(() => clearTimeout(timer));
        }),
      ]);
      if (raced?.requiresUserAction) return { ...raced, targetId, sessionId };
      if (raced !== undefined && raced.bytes !== undefined) {
        succeeded = true;
        return { ...raced, targetId, sessionId };
      }

      // 通道 C：页面自己停在 PDF 上时，用页面内 fetch 拿字节
      try {
        info = await analyze(sessionId);
      } catch { info = {}; }
      if (interventionHints(info).length) return { ...interventionResult(info), targetId, sessionId };
      if (String(info.contentType ?? '').includes('pdf') || looksLikePdfUrl(info.url)) {
        webUrl(info.url);
        const fetched = await evaluate(sessionId, FETCH_BASE64_EXPRESSION(info.url));
        const parsed = typeof fetched === 'string' ? JSON.parse(fetched) : undefined;
        if (parsed?.ok === true && typeof parsed.base64 === 'string' && parsed.base64.length <= Math.ceil(MAX_PDF_BYTES * 4 / 3) + 4) {
          const bytes = Buffer.from(parsed.base64, 'base64');
          if (looksLikePdf(bytes) && bytes.length <= MAX_PDF_BYTES) {
            succeeded = true;
            return {
              bytes,
              mimeType: parsed.contentType,
              finalUrl: info.url,
              via: 'in-page-fetch',
              targetId,
              sessionId,
            };
          }
        }
      }

      const late = await downloadPromise;
      if (late !== undefined) { succeeded = true; return { ...late, targetId, sessionId }; }

      return { error: `在 ${Math.round(timeoutMs / 1000)} 秒内没有拿到 PDF 字节`, page: info, targetId, sessionId };
    } finally {
      abort.abort();
      for (const off of cleanup) off();
      // 抓取用的标签页用完就关：字节已在内存里，落盘文件也留在下载目录，
      // 批量抓取时会堆出上百个标签页。需要留在窗口里观察时传 keepTab: true。
      // Keep failed/challenged pages visible for the user; never close login tabs.
      if (succeeded && options.keepTab !== true) {
        await closeTab(targetId);
        if (landing?.pdfUrls.has(url)) {
          // The user may have navigated this tab to SSO while a PDF downloaded.
          // Do not close it unless it is still the landing page we analyzed.
          try {
            const { targetInfo } = await connection.send('Target.getTargetInfo', { targetId: landing.targetId });
            if (targetInfo?.url === landing.url) await closeTab(landing.targetId);
          } catch { /* already closed */ }
          landing = undefined;
        }
      } else {
        landing = { targetId, sessionId, url, blocked: true, pdfUrls: new Set([url]) };
      }
    }
  }

  async function analyze(sessionId) {
    const raw = await evaluate(sessionId, ANALYZE_EXPRESSION);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : {};
    return {
      url: parsed.url ?? '',
      title: parsed.title ?? '',
      contentType: parsed.contentType ?? '',
      citationPdfUrl: parsed.citationPdfUrl ?? undefined,
      scienceDirectPdfPath: parsed.scienceDirectPdfPath ?? undefined,
      doi: parsed.doi ?? undefined,
      journal: parsed.journal ?? undefined,
      date: parsed.date ?? undefined,
      volume: parsed.volume ?? undefined,
      issue: parsed.issue ?? undefined,
      pages: parsed.pages ?? undefined,
      issn: parsed.issn ?? undefined,
      authors: parsed.authors ?? undefined,
      pdfLinks: [
        ...(typeof parsed.scienceDirectPdfPath === 'string' && parsed.scienceDirectPdfPath !== ''
          ? [{ url: parsed.scienceDirectPdfPath, text: 'ScienceDirect 页面内嵌的 pdfft 下载地址' }]
          : []),
        ...(Array.isArray(parsed.pdfLinks) ? parsed.pdfLinks : []),
      ],
      loginHints: [...(Array.isArray(parsed.loginHints) ? parsed.loginHints : []),
        ...(blockedResponses.has(sessionId) ? [blockedResponses.get(sessionId) === 429 ? '站点限流 429' : '访问被拒绝'] : [])],
      bodyPreview: parsed.bodyPreview ?? '',
    };
  }

  /** 打开一个页面并等它稳定下来，返回页面分析结果。 */
  async function open(url, options = {}) {
    url = webUrl(url);
    const waitMs = boundedMs(options.waitMs, 3000, 30000);
    await ensure();
    if (landing?.blocked) {
      const current = await analyze(landing.sessionId);
      if (interventionHints(current).length) return { ...current, targetId: landing.targetId, sessionId: landing.sessionId };
      landing.blocked = false;
    }
    const { targetId, sessionId } = await createTab('about:blank');
    await connection.send('Page.enable', {}, sessionId);
    const loaded = waitForLoad(sessionId, boundedMs(options.loadTimeoutMs, 30000, 30000));
    await connection.send('Page.navigate', { url }, sessionId);
    await loaded;
    if (waitMs > 0) await sleep(waitMs);
    const info = await analyze(sessionId);
    const pdfUrls = new Set();
    for (const candidate of [info.citationPdfUrl, ...info.pdfLinks.map((link) => link.url)]) {
      if (!candidate) continue;
      try { pdfUrls.add(webUrl(new URL(candidate, info.url).href)); } catch { /* non-web links */ }
    }
    landing = { targetId, sessionId, url: info.url, pdfUrls, blocked: interventionHints(info).length > 0 };
    // 只做分析、不需要留窗时传 closeTab：批量打开落地页会堆出很多标签页。
    if (options.closeTab === true) await closeTab(targetId);
    return { ...info, targetId, sessionId };
  }

  /** 复用已有标签页做分析，避免每步都开新窗口。 */
  async function openInExisting(url) {
    // Do not navigate arbitrary user/SSO tabs. Reuse the normal guarded path.
    return open(url);
  }

  async function close() {
    if (connection !== undefined) {
      connection.close();
      connection = undefined;
    }
    browserProps = undefined;
    for (const off of targetGuards.values()) off();
    targetGuards.clear();
  }

  async function status() {
    const version = await isRunning();
    if (version === undefined) {
      return { running: false, browserPath, cdpPort, profileDir, downloadDir, tabs: [] };
    }
    // 只用 HTTP 端点读标签页，不建 WebSocket：让 status 保持无副作用，
    // 不会因为「看一眼状态」就把连接生命周期拉起来。
    let tabs = [];
    try {
      tabs = await listTabs();
    } catch { /* 读不到就当没有 */ }
    return {
      running: true,
      browser: version.Browser,
      browserPath,
      cdpPort,
      profileDir,
      downloadDir,
      tabs,
    };
  }

  /**
   * 目录监视：等一个新出现的 PDF 落盘（人工点击下载的兜底通道，也是
   * 「PDF 一律下载」通道的落地方式）。
   *
   * @param {object} [options]
   * @param {number} [options.since] 只认这个时间点之后写入的文件
   * @param {number} [options.timeoutMs]
   * @param {string[]} [options.dirs]
   * @param {(found: {path: string, size: number}) => Promise<boolean>|boolean} [options.accept]
   *        内容校验；返回 false 的文件会被永久跳过，不再反复命中
   * @returns {Promise<{path: string, size: number}|undefined>}
   */
  async function waitForDownload(options = {}) {
    const since = Number.isFinite(options.since) ? options.since : Date.now();
    const timeoutMs = boundedMs(options.timeoutMs, 120000);
    const dirs = Array.isArray(options.dirs) && options.dirs.length > 0
      ? options.dirs
      : [downloadDir, osDownloadDir];
    const accept = typeof options.accept === 'function' ? options.accept : (() => true);
    const rejected = new Set();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline && !options.signal?.aborted) {
      for (const dir of dirs) {
        let entries;
        try {
          entries = await readdir(dir);
        } catch {
          continue;
        }
        let best;
        for (const entry of entries) {
          if (!/\.pdf$/i.test(entry)) continue;
          const full = path.join(dir, entry);
          if (rejected.has(full)) continue;
          let info;
          try {
            info = await stat(full);
          } catch {
            continue;
          }
          if (info.mtimeMs < since - 2000) continue;
          if (!info.isFile() || info.size < 5 || info.size > MAX_PDF_BYTES) continue;
          if (best === undefined || info.mtimeMs > best.mtimeMs) {
            best = { path: full, size: info.size, mtimeMs: info.mtimeMs };
          }
        }
        if (best !== undefined) {
          // 等文件大小稳定，避免读到半截
          await sleep(600);
          let stable = false;
          try {
            const again = await stat(best.path);
            stable = again.size === best.size;
          } catch {
            stable = false;
          }
          if (!stable) continue;
          const found = { path: best.path, size: best.size };
          if (await accept(found)) return found;
          rejected.add(best.path);
        }
      }
      await sleep(500);
    }
    return undefined;
  }

  let operationActive = false;
  const exclusive = (operation) => async (...args) => {
    if (operationActive) throw new Error('机构浏览器正在处理一篇文献，请等待当前操作结束');
    operationActive = true;
    try { return await operation(...args); } finally { operationActive = false; }
  };
  return {
    ensure,
    status,
    open: exclusive(open),
    openInExisting: exclusive(openInExisting),
    analyze,
    capturePdf: exclusive(capturePdf),
    createTab,
    closeTab,
    close,
    listTabs,
    evaluate,
    waitForDownload,
    paths: { profileDir, downloadDir, osDownloadDir, browserPath, cdpPort },
  };
}
