import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

export const MAX_PDF_BYTES = 128 * 1024 * 1024;
export const MAX_WAIT_MS = 180000;

export function boundedMs(value, fallback, maximum = MAX_WAIT_MS) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`Timeout must be a finite number between 0 and ${maximum} ms`);
  }
  return Math.trunc(value);
}

// This is a scheme/literal-host boundary, not a DNS-rebinding firewall. Browser
// subresources and institution VPN routing remain governed by Chromium/the OS.
export function webUrl(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('Expected a bounded absolute HTTP(S) URL');
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('Expected an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) URLs without embedded credentials are allowed');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || host === '::' || host === '::1' || host.startsWith('::ffff:')
      || /^(fc|fd|fe[89ab])/i.test(host) && host.includes(':')
      || ipv4 && (+ipv4[1] === 0 || +ipv4[1] === 10 || +ipv4[1] === 127
        || +ipv4[1] === 169 && +ipv4[2] === 254
        || +ipv4[1] === 172 && +ipv4[2] >= 16 && +ipv4[2] <= 31
        || +ipv4[1] === 192 && +ipv4[2] === 168
        || +ipv4[1] === 100 && +ipv4[2] >= 64 && +ipv4[2] <= 127
        || +ipv4[1] >= 224)) {
    throw new Error('Local/private literal browser destinations are not allowed');
  }
  return url.href;
}

export function assertPdf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.length > MAX_PDF_BYTES
      || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('Expected a PDF with %PDF- signature, at most 128 MiB');
  }
  return bytes;
}

// Local PDFs are an explicit user-facing import feature, so do not silently
// restrict them to the plugin's download directory. Reject devices/directories,
// alternate data streams and oversized files before reading; bound growth too.
export async function readPdfFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0')
      || process.platform === 'win32' && /:/.test(filename.slice(2))) {
    throw new Error('PDF path must be an absolute regular-file path');
  }
  const resolved = await realpath(filename);
  const handle = await open(resolved, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 5 || info.size > MAX_PDF_BYTES) {
      throw new Error('PDF must be a regular file, at most 128 MiB');
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, MAX_PDF_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_PDF_BYTES) throw new Error('PDF exceeds 128 MiB');
      chunks.push(chunk.subarray(0, bytesRead));
      if (total === bytesRead && chunk.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error('File is not a PDF (%PDF- signature missing)');
      }
    }
    return assertPdf(Buffer.concat(chunks, total));
  } finally { await handle.close(); }
}

export function interventionHints(page) {
  return (page?.loginHints ?? []).filter((hint) => /人机|校验|拒绝|限流|429/.test(hint));
}
export function interventionResult(page) {
  return { error: '站点要求人工处理，已停止自动取全文；请在机构浏览器中通过验证后继续',
    page, requiresUserAction: true };
}

export function cdpSocketUrl(value, port) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port
      || url.username || url.password || !url.pathname.startsWith('/devtools/browser/')) {
    throw new Error('CDP advertised a non-local or unexpected WebSocket endpoint');
  }
  return url.href;
}
export function validPort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid local port');
  return value;
}