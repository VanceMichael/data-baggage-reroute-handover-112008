// HTTP collection from the synthetic upstream. Read-only: no booking, no loading commands.

import { normalizeTag } from './helpers.mjs';

const DEFAULT_TIMEOUT_MS = 5000;

export class SourceError extends Error {
  constructor(message, { path, status, cause } = {}) {
    super(message, { cause });
    this.name = 'SourceError';
    this.path = path ?? null;
    this.status = status ?? null;
  }
}

async function readJson(response, path) {
  const text = await response.text();
  if (!response.ok) {
    throw new SourceError(`来源返回 ${response.status}`, { path, status: response.status });
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new SourceError('来源回传不是 JSON', { path, status: response.status, cause });
  }
}

export function createClient(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const root = new URL(baseUrl);
  let cache = new Map();

  async function getJson(path) {
    const url = new URL(path, root);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new SourceError('来源不可达', { path, cause });
    }
    return readJson(response, path);
  }

  function clearCache() {
    cache = new Map();
  }

  async function cached(path) {
    if (!cache.has(path)) cache.set(path, getJson(path));
    return cache.get(path);
  }

  return {
    clearCache,
    async health() {
      const url = new URL('/health', root);
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      return response.ok;
    },
    async tickets() {
      const body = await cached('/tickets/transfers');
      return Array.isArray(body) ? body : [];
    },
    async sortBatches() {
      const body = await cached('/sorting/batches');
      return Array.isArray(body) ? body : [];
    },
    async sortPage(path) {
      const body = await cached(path);
      if (!body || !Array.isArray(body.entries)) {
        throw new SourceError('分拣页缺少 entries', { path });
      }
      return body;
    },
    // Receiving pages can legitimately be empty (an unopened batch). Empty and unavailable are
    // different conditions and callers must see the distinction.
    async receiving() {
      const body = await cached('/receiving/handoffs');
      return body ?? { batch: null, complete: false, rows: [] };
    },
    async shifts() {
      const body = await cached('/shifts/handover');
      return Array.isArray(body) ? body : body ? [body] : [];
    },
    async manualReports() {
      const body = await cached('/reports/manual');
      return Array.isArray(body) ? body : [];
    },
  };
}

/** Walks the independent sorting page chain, following `next` only, never inventing page numbers. */
export async function collectSorting(client) {
  const batches = await client.sortBatches();
  const pages = [];
  const entries = [];
  const problems = [];

  for (const batch of batches) {
    if (!batch || !batch.id) {
      problems.push({ kind: 'batch-missing-id', batch });
      continue;
    }
    let next = batch.page ?? `/sorting/${encodeURIComponent(batch.id)}?page=1`;
    const visited = new Set();
    let expected = 1;
    while (next) {
      if (visited.has(next)) {
        problems.push({ kind: 'sorting-loop', batch: batch.id, page: next });
        break;
      }
      if (visited.size >= 500) {
        problems.push({ kind: 'sorting-too-many-pages', batch: batch.id });
        break;
      }
      visited.add(next);
      let page;
      try {
        page = await client.sortPage(next);
      } catch (error) {
        problems.push({
          kind: 'sorting-page-error',
          batch: batch.id,
          page: next,
          message: error.message,
          partial: true,
        });
        break;
      }
      pages.push({ batch: batch.id, page: next, path: next });
      const pageEntries = Array.isArray(page.entries) ? page.entries : [];
      for (const entry of pageEntries) {
        entries.push({
          ...entry,
          batch: batch.id,
          page: next,
          tag: normalizeTag(entry.tag),
        });
      }
      // `complete: false` means the source is still writing; the chain may end early.
      if (page.complete === false && !page.next) {
        problems.push({ kind: 'sorting-incomplete', batch: batch.id, page: next });
      }
      next = page.next ?? null;
      expected += 1;
    }
  }

  return { batches, pages, entries, problems };
}

/**
 * Normalizes receiving batches; keeps batch boundaries and distinguishes a genuinely empty page
 * from an email that never arrived. Several batches may be exposed at once by the source.
 */
export async function collectReceiving(client) {
  let body;
  try {
    body = await client.receiving();
  } catch (error) {
    return {
      available: false,
      empty: null,
      batches: [],
      rows: [],
      problem: { kind: 'receiving-error', message: error.message, status: error.status ?? null },
    };
  }
  const rawBatches = Array.isArray(body) ? body : [body];
  const batches = rawBatches.filter(Boolean).map((batch) => {
    const rows = Array.isArray(batch.rows) ? batch.rows : [];
    return {
      batch: batch.batch ?? null,
      complete: batch.complete === true,
      empty: rows.length === 0,
      rows: rows.map((row) => ({
        ...row,
        batch: row.batch ?? batch.batch ?? null,
        oldTag: normalizeTag(row.oldTag),
        newTag: normalizeTag(row.newTag),
        accepted: row.accepted === true,
      })),
      problem: rows.length === 0 && batch.complete === true
        ? { kind: 'receiving-empty-batch', batch: batch.batch ?? null }
        : null,
    };
  });
  const rows = batches.flatMap((batch) => batch.rows);
  return {
    available: true,
    empty: rows.length === 0,
    batches,
    batch: batches.length === 1 ? batches[0].batch : null,
    complete: batches.length > 0 && batches.every((batch) => batch.complete),
    rows,
    problem: null,
  };
}

export async function collectTickets(client) {
  try {
    const records = await client.tickets();
    return { available: true, records, problem: null };
  } catch (error) {
    return {
      available: false,
      records: [],
      problem: { kind: 'tickets-error', message: error.message, status: error.status ?? null },
    };
  }
}

export async function collectShifts(client) {
  try {
    const shifts = await client.shifts();
    return { available: true, shifts, problem: null };
  } catch (error) {
    return { available: false, shifts: [], problem: { kind: 'shifts-error', message: error.message } };
  }
}

export async function collectManual(client) {
  try {
    const reports = await client.manualReports();
    return { available: true, reports, problem: null };
  } catch (error) {
    return { available: false, reports: [], problem: { kind: 'manual-error', message: error.message } };
  }
}

export async function collectAll(baseUrl, options = {}) {
  const client = createClient(baseUrl, options);
  const tickets = await collectTickets(client);
  const sorting = await collectSorting(client);
  const receiving = await collectReceiving(client);
  const shifts = await collectShifts(client);
  const manual = await collectManual(client);
  return { tickets, sorting, receiving, shifts, manual, sources: { tickets: '/tickets/transfers', sorting: '/sorting/batches', receiving: '/receiving/handoffs', shifts: '/shifts/handover', manual: '/reports/manual' } };
}
