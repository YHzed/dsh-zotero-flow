/**
 * Zotero 本地客户端。
 *
 * 两条通道，按可用性自动选择：
 *
 *  1. Connector API（Zotero 桌面端默认开启，127.0.0.1:23119/connector）
 *     - POST /connector/getSelectedCollection  读取当前目标与可选目标、标签
 *     - POST /connector/saveItems              按翻译器条目格式建条目
 *     - POST /connector/updateSession          改目标分类、加标签、加子笔记
 *     - POST /connector/saveAttachment         把 PDF 字节流挂到该条目
 *     - POST /connector/saveStandaloneAttachment  无父条目的附件
 *     - POST /connector/hasAttachmentResolvers / saveAttachmentFromResolver
 *                                              让 Zotero 自己去找开放获取 PDF
 *     注意：saveItems / updateSession 会同时把 Zotero 界面里选中的分类切过去，
 *     这是 Zotero 自身的设计（见 server_connector.js 的 SaveSession#update）。
 *
 *  2. Local API（需在 Zotero 高级设置里打开
 *     extensions.zotero.httpServer.localAPI.enabled，127.0.0.1:23119/api/users/0）
 *     提供完整分类树（含 key）、条目检索、新建分类。
 *
 * 会话（session）由客户端生成 ID，saveItems 时创建，10 分钟内有效；
 * 同一会话内 items[i].id 就是后续 saveAttachment 的 parentItemID。
 */

import { randomUUID } from 'node:crypto';

const CONNECTOR_API_VERSION = 3;

export class ZoteroError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'ZoteroError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}${path}`;
}

async function readBody(response) {
  const text = await response.text();
  if (text === '') return { text: '', json: undefined };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: undefined };
  }
}

/** 把 Zotero 的本地端口封装成一个小客户端。 */
export function createZoteroClient(options = {}) {
  const port = Number.isFinite(options.port) ? options.port : 23119;
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : '127.0.0.1';
  const origin = `http://${host}:${port}`;
  const connectorBase = joinUrl(origin, '/connector');
  const apiBase = joinUrl(origin, '/api/users/0');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const library = typeof options.library === 'string' ? options.library : 'users/0';

  let localApiCache;

  async function request(url, init = {}) {
    let response;
    try {
      response = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? timeoutMs),
      });
    } catch (error) {
      const code = error?.cause?.code ?? error?.code;
      if (code === 'ECONNREFUSED' || code === 'UND_ERR_SOCKET' || code === 'ECONNRESET') {
        throw new ZoteroError(
          `连不上 Zotero 本地服务（${origin}）。请确认 Zotero 桌面端正在运行；若改过端口，请在插件配置里同步 zoteroPort。`,
          'ZOTERO_UNREACHABLE',
          code,
        );
      }
      throw new ZoteroError(`请求 Zotero 失败：${error.message}`, 'ZOTERO_REQUEST_FAILED', code);
    }
    return response;
  }

  async function connectorPost(path, body, extraHeaders = {}) {
    const isBinary = body instanceof Uint8Array || body instanceof ArrayBuffer;
    const response = await request(joinUrl(connectorBase, path), {
      method: 'POST',
      headers: {
        ...(isBinary
          ? { 'Content-Type': extraHeaders['Content-Type'] ?? 'application/octet-stream' }
          : { 'Content-Type': 'application/json' }),
        'X-Zotero-Connector-API-Version': String(CONNECTOR_API_VERSION),
        ...extraHeaders,
      },
      body: isBinary ? body : JSON.stringify(body ?? {}),
    });
    return response;
  }

  async function apiRequest(path, init = {}) {
    const response = await request(joinUrl(apiBase, path), {
      ...init,
      headers: {
        'Zotero-API-Version': String(CONNECTOR_API_VERSION),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    });
    return response;
  }

  /** 端口上是否有 Zotero HTTP 服务在应答。 */
  async function ping() {
    try {
      const response = await request(joinUrl(origin, '/connector/ping'), { timeoutMs: 4000 });
      const text = await response.text();
      return { alive: response.ok, body: text.trim() };
    } catch (error) {
      return { alive: false, body: '' , error: error.message };
    }
  }

  /** 一次性探测：版本、connector、local API 是否可用。 */
  async function probe() {
    const result = {
      origin,
      running: false,
      version: undefined,
      connectorApiVersion: undefined,
      localApiEnabled: false,
      localApiMessage: '',
      connectorMessage: '',
    };

    try {
      const root = await request(joinUrl(origin, '/'), { timeoutMs: 4000 });
      result.running = true;
      result.version = root.headers.get('x-zotero-version') ?? undefined;
      result.connectorApiVersion = root.headers.get('x-zotero-connector-api-version') ?? undefined;
    } catch (error) {
      result.connectorMessage = error.message;
      return result;
    }

    try {
      const connector = await connectorPost('/getSelectedCollection', {});
      const { text } = await readBody(connector);
      result.connectorMessage = connector.ok ? 'ok' : `HTTP ${connector.status}: ${text.slice(0, 120)}`;
    } catch (error) {
      result.connectorMessage = error.message;
    }

    try {
      const api = await apiRequest('/items?limit=1', { timeoutMs: 6000 });
      if (api.ok) {
        result.localApiEnabled = true;
        result.localApiMessage = 'ok';
        localApiCache = true;
      } else {
        const { text } = await readBody(api);
        result.localApiMessage = `HTTP ${api.status}: ${text.slice(0, 120)}`;
        localApiCache = false;
      }
    } catch (error) {
      result.localApiMessage = error.message;
      localApiCache = false;
    }

    return result;
  }

  /** 当前保存目标 + 可选目标 + 已有标签。 */
  async function getTargets() {
    const response = await connectorPost('/getSelectedCollection', {});
    const { json, text } = await readBody(response);
    if (!response.ok || json === undefined) {
      throw new ZoteroError(
        `读取 Zotero 保存目标失败（HTTP ${response.status}）：${text.slice(0, 200)}`,
        'ZOTERO_TARGET_FAILED',
      );
    }
    return json;
  }

  function targetsOf(payload) {
    const targets = Array.isArray(payload?.targets) ? payload.targets : [];
    return targets.map((target) => ({
      id: String(target.id),
      name: String(target.name ?? ''),
      level: Number.isInteger(target.level) ? target.level : Number(target.level ?? 0),
      recent: target.recent === true,
      filesEditable: target.filesEditable !== false,
    }));
  }

  /**
   * 解析用户给出的分类名/目标 id。
   * @returns {{targetId: string, name: string, source: string}|undefined}
   */
  function resolveTarget(payload, wanted) {
    const targets = targetsOf(payload);
    const current = payload?.id == null
      ? { id: `L${payload?.libraryID ?? 1}`, name: payload?.libraryName ?? '我的文库' }
      : { id: `C${payload.id}`, name: payload?.name ?? '' };

    if (wanted === undefined || wanted === null || String(wanted).trim() === '') {
      return { targetId: current.id, name: current.name, source: 'current' };
    }
    const needle = String(wanted).trim();
    const lower = needle.toLowerCase();

    const byId = targets.find((target) => target.id.toLowerCase() === lower);
    if (byId) return { targetId: byId.id, name: byId.name, source: 'id' };

    const exact = targets.filter((target) => target.name === needle);
    if (exact.length === 1) return { targetId: exact[0].id, name: exact[0].name, source: 'name' };

    const partial = targets.filter((target) => target.name.toLowerCase().includes(lower));
    if (partial.length >= 1) {
      // 取最深的匹配：同名嵌套时更可能是用户想要的那一级
      const deepest = partial.reduce((best, item) => (item.level >= best.level ? item : best), partial[0]);
      return { targetId: deepest.id, name: deepest.name, source: partial.length === 1 ? 'name' : 'name-partial' };
    }
    return undefined;
  }

  async function localApiAvailable() {
    if (localApiCache !== undefined) return localApiCache;
    try {
      const api = await apiRequest('/items?limit=1', { timeoutMs: 6000 });
      localApiCache = api.ok;
    } catch {
      localApiCache = false;
    }
    return localApiCache;
  }

  /** 分类树。local API 可用时返回带 key 的完整树，否则回退到 connector 的可选目标。 */
  async function listCollections() {
    if (await localApiAvailable()) {
      const response = await apiRequest('/collections?limit=100&format=json');
      const { json, text } = await readBody(response);
      if (response.ok && Array.isArray(json)) {
        return {
          source: 'local-api',
          collections: json.map((entry) => ({
            key: entry.key,
            name: entry.data?.name ?? '',
            parentCollection: entry.data?.parentCollection === false ? null : entry.data?.parentCollection,
            numItems: entry.meta?.numItems ?? null,
          })),
        };
      }
      return { source: 'local-api', collections: [], error: `HTTP ${response.status}: ${text.slice(0, 160)}` };
    }
    const payload = await getTargets();
    return {
      source: 'connector',
      collections: targetsOf(payload).map((target) => ({
        key: target.id,
        name: target.name,
        parentCollection: target.level > 0 ? '(见 level)' : null,
        numItems: null,
        level: target.level,
        recent: target.recent,
      })),
      error: 'Zotero 本地 API 未开启：只能看到当前选中的分类与最近使用过的目标。要列出全部分类，请在 Zotero「编辑 → 设置 → 高级 → 常规」里勾选「允许本机其他应用与 Zotero 通信」。',
    };
  }

  /** 新建分类（需要 local API）。 */
  async function createCollection(name, parentCollection = null) {
    if (!(await localApiAvailable())) {
      throw new ZoteroError(
        '新建分类需要 Zotero 本地 API。请在 Zotero「编辑 → 设置 → 高级 → 常规」勾选「允许本机其他应用与 Zotero 通信」，然后重试。',
        'LOCAL_API_DISABLED',
      );
    }
    const body = [{ name: String(name), parentCollection: parentCollection ?? false }];
    const response = await apiRequest('/collections', { method: 'POST', body: JSON.stringify(body) });
    const { json, text } = await readBody(response);
    if (!response.ok) {
      throw new ZoteroError(`新建分类失败（HTTP ${response.status}）：${text.slice(0, 200)}`, 'CREATE_COLLECTION_FAILED');
    }
    const entry = json?.successful?.['0'];
    return { key: entry?.key, name: entry?.data?.name ?? String(name), raw: json };
  }

  /** 在库里检索条目（需要 local API）。 */
  async function searchItems(query, limit = 10) {
    if (!(await localApiAvailable())) {
      return { source: 'connector', items: [], error: 'Zotero 本地 API 未开启，无法检索库内已有条目。' };
    }
    const params = new URLSearchParams({
      q: String(query),
      qmode: 'titleCreatorYear',
      limit: String(Math.max(1, Math.min(limit, 50))),
      format: 'json',
    });
    const response = await apiRequest(`/items/top?${params.toString()}`);
    const { json, text } = await readBody(response);
    if (!response.ok || !Array.isArray(json)) {
      return { source: 'local-api', items: [], error: `HTTP ${response.status}: ${text.slice(0, 160)}` };
    }
    return {
      source: 'local-api',
      items: json.map((entry) => ({
        key: entry.key,
        itemType: entry.data?.itemType,
        title: entry.data?.title,
        date: entry.data?.date,
        DOI: entry.data?.DOI,
        url: entry.data?.url,
      })),
    };
  }

  function newSessionId() {
    return `dsh-zotero-${randomUUID()}`;
  }

  /**
   * 保存一个条目并把目标分类 / 标签 / 子笔记落到同一次会话里。
   * @returns {{sessionId: string, itemKey: string}}
   */
  async function saveItem({ item, target, tags = [], note = '' }) {
    const sessionId = newSessionId();
    const connectorKey = item?.id ?? 'dsh-item-1';
    const payload = { sessionID: sessionId, items: [{ ...item, id: connectorKey }] };

    const response = await connectorPost('/saveItems', payload);
    const { text } = await readBody(response);
    if (!response.ok) {
      throw new ZoteroError(
        `Zotero 保存条目失败（HTTP ${response.status}）：${text.slice(0, 240)}`,
        'SAVE_ITEM_FAILED',
      );
    }
    return { sessionId, itemKey: String(connectorKey) };
  }

  /** 切换目标分类 / 加标签 / 加子笔记。 */
  async function updateSession({ sessionId, target, tags, note }) {
    const body = { sessionID: sessionId };
    if (target !== undefined && target !== null && target !== '') body.target = String(target);
    if (Array.isArray(tags) && tags.length > 0) body.tags = tags.map(String);
    if (typeof note === 'string' && note !== '') body.note = note;
    if (body.target === undefined && body.tags === undefined && body.note === undefined) {
      return { updated: false };
    }
    const response = await connectorPost('/updateSession', body);
    const { json, text } = await readBody(response);
    if (!response.ok) {
      throw new ZoteroError(
        `Zotero 更新归档位置失败（HTTP ${response.status}）：${text.slice(0, 240)}`,
        'UPDATE_SESSION_FAILED',
        json,
      );
    }
    return { updated: true };
  }

  /**
   * 附件条目的来源 URL。
   *
   * Zotero 的 importFromNetworkStream 在 url 为空/缺失/null 时直接抛异常，
   * 服务端只回一个光秃秃的 500。所以这里必须兜一个非空值。
   */
  function attachmentUrl(sourceUrl, fallbackDoi) {
    const candidates = [
      typeof sourceUrl === 'string' ? sourceUrl.trim() : '',
      typeof fallbackDoi === 'string' && fallbackDoi.trim() !== '' ? `https://doi.org/${fallbackDoi.trim()}` : '',
      'https://www.zotero.org/',
    ];
    return candidates.find((candidate) => candidate !== '') ?? 'https://www.zotero.org/';
  }

  /**
   * HTTP 头只能装 Latin-1。
   *
   * X-Metadata 走的是请求头，标题里带中文（`PMU022_谢鑫_2023.pdf` 这类文件名）
   * 时 fetch 会直接抛：
   *   Cannot convert argument to a ByteString because the character at index … has a value of 26041
   * 于是条目建好了、PDF 却挂不上。这里统一压成 ASCII 再发。
   */
  function headerSafe(value) {
    return String(value ?? '').replace(/[^\x20-\x7E]/g, '_');
  }

  /** 把 PDF 字节流挂到会话里已保存的条目上。 */
  async function attachPdf({ sessionId, parentItemKey, filename, bytes, sourceUrl, doi }) {
    const metadata = {
      sessionID: sessionId,
      parentItemID: String(parentItemKey),
      title: headerSafe(filename),
      url: headerSafe(attachmentUrl(sourceUrl, doi)),
    };
    const response = await connectorPost('/saveAttachment', new Uint8Array(bytes), {
      'Content-Type': 'application/pdf',
      'X-Metadata': JSON.stringify(metadata),
    });
    const { text } = await readBody(response);
    if (!response.ok) {
      throw new ZoteroError(
        `Zotero 挂载 PDF 失败（HTTP ${response.status}）：${text.slice(0, 240)}`,
        'ATTACH_PDF_FAILED',
      );
    }
    return { attached: true };
  }

  /** 保存一个没有父条目的独立附件（例如只有 PDF、拿不到元数据时）。 */
  async function saveStandalonePdf({ filename, bytes, sourceUrl, target }) {
    const sessionId = newSessionId();
    const metadata = {
      sessionID: sessionId,
      title: filename,
      url: attachmentUrl(sourceUrl),
    };
    const response = await connectorPost('/saveStandaloneAttachment', new Uint8Array(bytes), {
      'Content-Type': 'application/pdf',
      'X-Metadata': JSON.stringify(metadata),
    });
    const { text } = await readBody(response);
    if (!response.ok) {
      throw new ZoteroError(
        `Zotero 保存独立附件失败（HTTP ${response.status}）：${text.slice(0, 240)}`,
        'STANDALONE_ATTACH_FAILED',
      );
    }
    if (target !== undefined && target !== null && target !== '') {
      await updateSession({ sessionId, target });
    }
    return { sessionId, itemKey: filename };
  }

  /** 问 Zotero 这个条目有没有可用的开放获取 / 自定义解析器。 */
  async function hasResolvers(sessionId, itemKey) {
    const response = await connectorPost('/hasAttachmentResolvers', { sessionID: sessionId, itemID: String(itemKey) });
    const { text } = await readBody(response);
    if (!response.ok) return { available: false, message: `HTTP ${response.status}: ${text.slice(0, 160)}` };
    return { available: text.trim() === 'true', message: 'ok' };
  }

  /** 让 Zotero 自己去找并下载开放获取 PDF。 */
  async function fetchWithResolver(sessionId, itemKey) {
    const response = await connectorPost('/saveAttachmentFromResolver', { sessionID: sessionId, itemID: String(itemKey) });
    const { text } = await readBody(response);
    if (!response.ok) {
      return { saved: false, message: `HTTP ${response.status}: ${text.slice(0, 200)}` };
    }
    return { saved: true, title: text.trim() };
  }

  return {
    origin,
    port,
    library,
    ping,
    probe,
    getTargets,
    targetsOf,
    resolveTarget,
    listCollections,
    createCollection,
    searchItems,
    saveItem,
    updateSession,
    attachPdf,
    saveStandalonePdf,
    hasResolvers,
    fetchWithResolver,
    localApiAvailable,
  };
}
