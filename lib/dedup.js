import { normalizeDoi } from './catalog.js';
import { ZoteroError } from './zotero.js';

export function normalizedDoi(value) {
  return (normalizeDoi(String(value ?? '').trim()) ?? '').toLowerCase();
}
export function normalizedTitle(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, ' ').trim();
}
function candidate(item) {
  return { key: item.key, title: item.title ?? '', DOI: item.DOI ?? '', date: item.date ?? '' };
}
function ambiguous(items, reason) {
  throw new ZoteroError(`${reason} No library changes were made. Confirm the correct item using zotero_search, then use zotero_attach_pdf with its real itemKey. Candidates: ${JSON.stringify(items.map(candidate))}`, 'IMPORT_IDENTITY_AMBIGUOUS', { candidates: items.map(candidate) });
}
/** Exact DOI dominates title; title-only identity must be unique and descriptive. */
export function selectImportParent(items, { doi, title } = {}) {
  const wantedDoi = normalizedDoi(doi);
  const wantedTitle = normalizedTitle(title);
  const regular = items.filter(item => !item.deleted && item.itemType && !['attachment', 'note', 'annotation'].includes(item.itemType));
  if (wantedDoi) {
    const exact = regular.filter(item => normalizedDoi(item.DOI) === wantedDoi);
    if (exact.length > 1) ambiguous(exact, 'Multiple existing items have this exact DOI.');
    if (exact.length === 1) return { item: exact[0], matchedBy: 'doi' };
  }
  if (!wantedTitle) return undefined;
  const exact = regular.filter(item => normalizedTitle(item.title) === wantedTitle
    && !(wantedDoi && normalizedDoi(item.DOI) && normalizedDoi(item.DOI) !== wantedDoi));
  if (exact.length > 1) ambiguous(exact, 'Multiple existing items have this exact title.');
  if (!exact.length) {
    const conflicting = regular.filter(item => normalizedTitle(item.title) === wantedTitle
      && wantedDoi && normalizedDoi(item.DOI) && normalizedDoi(item.DOI) !== wantedDoi);
    if (conflicting.length) ambiguous(conflicting, 'An exact-title item has a conflicting DOI. Confirm identity before creating another parent.');
    return undefined;
  }
  const meaningful = wantedTitle.replace(/[^\p{L}\p{N}]/gu, '');
  if (meaningful.length < 20 && (meaningful.match(/\p{Script=Han}/gu)?.length ?? 0) < 8) {
    ambiguous(exact, 'The title alone is too short to safely confirm identity. Supply a DOI or confirm the item explicitly.');
  }
  return { item: exact[0], matchedBy: 'title' };
}
const queues = new WeakMap();
/** Serialize check-and-write across automated imports using the same runtime. */
export async function withImportGuard(runtime, operation) {
  const previous = queues.get(runtime) ?? Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  queues.set(runtime, tail);
  await previous.catch(() => {});
  try { return await operation(); }
  finally { release(); if (queues.get(runtime) === tail) queues.delete(runtime); }
}
export function requirePdf(bytes) {
  if (!(bytes instanceof Uint8Array) || Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    throw new ZoteroError('Invalid PDF: missing %PDF- signature. No Zotero writes were made.', 'INVALID_PDF');
  }
}
export function assertCompleteSearch(result) {
  if (result?.complete !== true || !Array.isArray(result.items) || !Array.isArray(result.attachments) || result.error) {
    throw new ZoteroError(`Cannot establish absence of existing items/attachments; import stopped without writing. Enable the Zotero local API and retry. ${result?.error ?? ''}`, 'IMPORT_SEARCH_INCOMPLETE');
  }
}
