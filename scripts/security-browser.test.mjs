import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSession } from '../lib/browser.js';

// No browser process, network listener or HTTP request: every CDP transport is fake.
async function fakeBrowser(mode, run) {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const calls = [];
  let targets = 0;
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
          : request.method === 'Runtime.evaluate' ? { result: { value: JSON.stringify({
            url: 'https://publisher.example/article', title: 'Offline page', contentType: 'text/html',
            loginHints: mode === 'blocked-landing' ? ['有人机校验，需要人工操作'] : [], pdfLinks: [],
          }) } }
            : request.method === 'Network.getResponseBody' ? { body: Buffer.from('%PDF-1.7\n%%EOF').toString('base64'), base64Encoded: true }
              : {};
      queueMicrotask(() => {
        this.message({ id: request.id, result });
        if (request.method === 'Fetch.enable' && mode === 'guard') {
          for (const [requestId, url] of [['private', 'http://127.0.0.1/private'], ['public', 'https://publisher.example/article']]) {
            this.message({ sessionId: request.sessionId, method: 'Fetch.requestPaused', params: { requestId, request: { url } } });
          }
        }
        if (request.method === 'Page.navigate' && mode !== 'blocked-landing') {
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

test('document interception blocks private redirects but continues public requests', async () => {
  await fakeBrowser('guard', async (browser, calls) => {
    await browser.ensure();
    await browser.createTab();
    assert.deepEqual(calls.filter((call) => call.method === 'Fetch.failRequest').map((call) => call.params), [{ requestId: 'private', errorReason: 'BlockedByClient' }]);
    assert.deepEqual(calls.filter((call) => call.method === 'Fetch.continueRequest').map((call) => call.params), [{ requestId: 'public' }]);
  });
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
