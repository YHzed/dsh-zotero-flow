import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createBrowserSession } from '../lib/browser.js';

// No browser process, network listener or HTTP request: every CDP transport is fake.
async function fakeBrowser(mode, run) {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const calls = [];
  let targets = 0;
  const options = typeof mode === 'object' ? mode : { mode };
  mode = options.mode;
  const landingUrl = 'https://publisher.example/article';
  const pdfUrl = 'https://publisher.example/article.pdf';
  const evaluate = (expression) => mode === 'fallback' && expression.includes('await fetch(')
    ? JSON.stringify({ ok: false, status: options.status })
    : mode === 'fallback' ? JSON.stringify({ url: pdfUrl, contentType: 'application/pdf', loginHints: [], pdfLinks: [] })
    : options.document
    ? vm.runInNewContext(expression, { document: options.document, location: new URL(options.url ?? landingUrl), URL }, { timeout: 1000 })
    : JSON.stringify({ url: landingUrl, title: 'Offline page', contentType: 'text/html',
      citationPdfUrl: pdfUrl, loginHints: mode === 'blocked-landing' ? ['有人机校验，需要人工操作'] : [], pdfLinks: [] });
  class FakeSocket {
    constructor(url) {
      assert.equal(url, 'ws://127.0.0.1:9333/devtools/browser/offline');
      this.handlers = new Map();
      queueMicrotask(() => this.emit('open', {}));
    }
    addEventListener(name, callback) {
      const list = this.handlers.get(name) ?? [];
      list.push(callback);
      this.handlers.set(name, list);
    }
    emit(name, event) { for (const callback of this.handlers.get(name) ?? []) callback(event); }
    message(payload) { this.emit('message', { data: JSON.stringify(payload) }); }
    send(raw) {
      const request = JSON.parse(raw);
      calls.push(request);
      const result = request.method === 'Target.createTarget' ? { targetId: `owned-${++targets}` }
        : request.method === 'Target.attachToTarget' ? { sessionId: `session-${request.params.targetId}` }
          : request.method === 'Target.getTargetInfo' ? { targetInfo: { targetId: request.params.targetId, url: options.currentLandingUrl ?? landingUrl } }
          : request.method === 'Runtime.evaluate' ? { result: { value: evaluate(request.params.expression) } }
            : request.method === 'Network.getResponseBody' ? { body: Buffer.from('%PDF-1.7\n%%EOF').toString('base64'), base64Encoded: true }
              : {};
      queueMicrotask(() => {
        this.message({ id: request.id, result });
        if (request.method === 'Fetch.enable' && mode === 'guard') {
          for (const [requestId, url] of [['private', 'http://127.0.0.1/private'], ['public', 'https://publisher.example/article']]) {
            this.message({ sessionId: request.sessionId, method: 'Fetch.requestPaused', params: { requestId, request: { url } } });
          }
        }
        if (request.method === 'Page.navigate' && mode !== 'blocked-landing' && mode !== 'fallback') {
          const status = mode === 'blocked-response' ? 429 : 200;
          this.message({ sessionId: request.sessionId, method: 'Network.responseReceived', params: {
            type: 'Document', requestId: 'pdf-request', response: { status, mimeType: 'application/pdf', url: 'https://publisher.example/article.pdf' },
          } });
          if (status === 200) this.message({ sessionId: request.sessionId, method: 'Network.loadingFinished', params: { requestId: 'pdf-request', encodedDataLength: 20 } });
        }
      });
    }
    close() { this.emit('close', {}); }
  }
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = async (url, init) => {
    assert.equal(init.redirect, 'error');
    assert.equal(url, 'http://127.0.0.1:9333/json/version');
    return new Response(JSON.stringify({ Browser: 'Offline fake', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/offline' }));
  };
  const browser = createBrowserSession({ downloadDir: `${process.cwd()}/__offline_missing_download_dir__` });
  try { await run(browser, calls); }
  finally {
    await browser.close();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
}

test('capture refuses invalid destinations before starting any transport', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected fetch'); };
  try {
    const browser = createBrowserSession();
    for (const url of ['file:///private.pdf', 'http://127.0.0.1/x.pdf', 'https://user:password@publisher.example/x.pdf']) {
      await assert.rejects(browser.capturePdf(url, { timeoutMs: 10 }));
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('network PDF succeeds and closes only controller-owned capture tab', async () => {
  await fakeBrowser('pdf', async (browser, calls) => {
    const result = await browser.capturePdf('https://publisher.example/article.pdf', { timeoutMs: 30 });
    assert.equal(result.via, 'network');
    assert.equal(result.bytes.subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(calls.filter((call) => call.method === 'Target.closeTarget').map((call) => call.params.targetId), ['owned-1']);
    assert.equal(calls.filter((call) => call.method === 'Page.navigate').length, 1);
  });
});

test('HTTP 429 stops capture, retains tab and never fetches response body', async () => {
  await fakeBrowser('blocked-response', async (browser, calls) => {
    const result = await browser.capturePdf('https://publisher.example/article.pdf', { timeoutMs: 30 });
    assert.equal(result.requiresUserAction, true);
    assert.equal(calls.some((call) => call.method === 'Target.closeTarget'), false);
    assert.equal(calls.some((call) => call.method === 'Network.getResponseBody'), false);
  });
});

test('in-page PDF fetch 403 and 429 stop automation and keep the challenged tab', async () => {
  for (const status of [403, 429]) {
    await fakeBrowser({ mode: 'fallback', status }, async (browser, calls) => {
      const result = await browser.capturePdf('https://publisher.example/article.pdf', { timeoutMs: 5 });
      assert.equal(result.requiresUserAction, true);
      assert.equal(calls.some((call) => call.method === 'Target.closeTarget'), false);
      assert.equal(calls.filter((call) => call.method === 'Runtime.evaluate' && call.params.expression.includes('await fetch(')).length, 1);
      assert.equal(calls.filter((call) => call.method === 'Page.navigate').length, 1);
    });
  }
});

test('document interception blocks private redirects but continues public requests', async () => {
  await fakeBrowser('guard', async (browser, calls) => {
    await browser.ensure();
    await browser.createTab();
    assert.deepEqual(calls.filter((call) => call.method === 'Fetch.failRequest').map((call) => call.params), [{ requestId: 'private', errorReason: 'BlockedByClient' }]);
    assert.deepEqual(calls.filter((call) => call.method === 'Fetch.continueRequest').map((call) => call.params), [{ requestId: 'public' }]);
  });
});

test('associated landing closes only while it remains on the original URL', async () => {
  for (const currentLandingUrl of ['https://publisher.example/article', 'https://sso.example/login', 'https://publisher.example/user-navigation']) {
    await fakeBrowser({ mode: 'pdf', currentLandingUrl }, async (browser, calls) => {
      await browser.open('https://publisher.example/article', { waitMs: 0, loadTimeoutMs: 1 });
      const result = await browser.capturePdf('https://publisher.example/article.pdf', { timeoutMs: 30 });
      assert.equal(result.via, 'network');
      assert.deepEqual(calls.filter((call) => call.method === 'Target.closeTarget').map((call) => call.params.targetId),
        currentLandingUrl === 'https://publisher.example/article' ? ['owned-2', 'owned-1'] : ['owned-2']);
      assert.equal(calls.filter((call) => call.method === 'Target.getTargetInfo').length, 1);
    });
  }
});

test('goto on blocked landing never creates or navigates another target', async () => {
  await fakeBrowser('blocked-landing', async (browser, calls) => {
    await browser.open('https://publisher.example/article', { waitMs: 0, loadTimeoutMs: 1 });
    const before = calls.filter((call) => call.method === 'Page.navigate').length;
    const result = await browser.open('https://publisher.example/alternate', { waitMs: 0, loadTimeoutMs: 1 });
    assert.ok(result.requiresUserAction || result.loginHints.some((hint) => /人机|校验/.test(hint)));
    assert.equal(calls.filter((call) => call.method === 'Page.navigate').length, before);
    assert.equal(calls.filter((call) => call.method === 'Target.createTarget').length, 1);
  });
});

function minimalDocument({ title = '', text = '', html = '' } = {}) {
  return { title, contentType: 'text/html', body: { innerText: text }, documentElement: { outerHTML: html },
    querySelector: () => null, querySelectorAll: () => [] };
}

test('actual analysis expression detects Cloudflare challenge in body text', async () => {
  await fakeBrowser({ document: minimalDocument({ text: 'Checking your browser. Cloudflare Turnstile' }) }, async (browser, calls) => {
    await browser.ensure();
    const { sessionId } = await browser.createTab();
    const info = await browser.analyze(sessionId);
    assert.ok(info.loginHints.some((hint) => /人机|校验/.test(hint)));
    assert.ok(calls.some((call) => call.method === 'Runtime.evaluate' && call.params.expression.includes('document.title')));
  });
});

test('actual analysis expression detects Cloudflare title-only challenge', async () => {
  await fakeBrowser({ document: minimalDocument({ title: 'Just a moment...', text: 'Please wait' }) }, async (browser) => {
    await browser.ensure();
    const { sessionId } = await browser.createTab();
    const info = await browser.analyze(sessionId);
    assert.ok(info.loginHints.some((hint) => /人机|校验/.test(hint)), 'title-only Cloudflare challenge must require manual action');
  });
});

test('actual analysis expression selects expected PII not reference PII', async () => {
  const pii = 'S1234567890123456';
  const reference = '1-s2.0-S9999999999999999-main.pdf';
  for (const withExpected of [false, true]) {
    const html = `{"md5":"0123456789abcdef0123456789abcdef","reference":"${reference}"${withExpected ? `,"pid":"1-s2.0-${pii}-main.pdf"` : ''}}`;
    await fakeBrowser({ url: `https://www.sciencedirect.com/science/article/pii/${pii}`, document: minimalDocument({ html }) }, async (browser) => {
      await browser.ensure();
      const { sessionId } = await browser.createTab();
      const info = await browser.analyze(sessionId);
      if (withExpected) {
        const url = new URL(info.scienceDirectPdfPath);
        assert.equal(url.searchParams.get('pid'), `1-s2.0-${pii}-main.pdf`);
        assert.equal(url.origin, 'https://www.sciencedirect.com');
      } else assert.equal(info.scienceDirectPdfPath, undefined);
    });
  }
});

test('blocked landing recheck prevents another target or navigation', async () => {
  await fakeBrowser('blocked-landing', async (browser, calls) => {
    await browser.open('https://publisher.example/article', { waitMs: 0, loadTimeoutMs: 1 });
    const before = calls.filter((call) => call.method === 'Page.navigate').length;
    const result = await browser.capturePdf('https://publisher.example/article.pdf', { timeoutMs: 30 });
    assert.equal(result.requiresUserAction, true);
    assert.equal(calls.filter((call) => call.method === 'Page.navigate').length, before);
    assert.equal(calls.filter((call) => call.method === 'Target.createTarget').length, 1);
    assert.equal(calls.some((call) => call.method === 'Target.closeTarget'), false);
  });
});
