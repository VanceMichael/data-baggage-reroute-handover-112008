/**
 * 上游资料采集。
 *
 * - 分拣批次页按 next 逐页读取，直到 next 为空且 complete=true；不同分拣点/批次页分别保留。
 * - 受理页按交运批次取回；空页、未完整页、重传行都原样交给模型判定。
 * - 票务、受理、分拣、班次、双边报告的时间戳来自不同来源，这里只负责原样取回，
 *   不做全局排序，也不凭航班号/同姓做合并。
 */

import { setTimeout as delay } from 'node:timers/promises';

export class SourceError extends Error {
  constructor(message, { path, status, cause } = {}) {
    super(message);
    this.name = 'SourceError';
    this.path = path;
    this.status = status;
    this.cause = cause;
  }
}

const ABSOLUTE = /^https?:\/\//i;

export class Collector {
  constructor({ baseUrl = 'http://127.0.0.1:4173', timeoutMs = 5000, maxPages = 200, retries = 1, fetchImpl = globalThis.fetch, signal } = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.maxPages = maxPages;
    this.retries = retries;
    this.fetch = fetchImpl;
    this.signal = signal;
  }

  resolve(path) {
    if (ABSOLUTE.test(path)) return path;
    return new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/').toString();
  }

  async request(path) {
    let attempt = 0;
    let lastError = null;
    while (attempt <= this.retries) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
      try {
        const response = await this.fetch(this.resolve(path), {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal,
          redirect: 'manual',
        });
        if (response.status === 404) return { status: 404, body: null };
        if (!response.ok) {
          // 5xx 可重试一次；4xx 直接报，避免把资料缺失当成“没有资料”。
          if (response.status >= 500 && attempt < this.retries) {
            lastError = new SourceError(`上游 ${response.status} ${path}`, { path, status: response.status });
            attempt += 1;
            await delay(Math.min(150 * attempt, 600), undefined, { signal: this.signal }).catch(() => {});
            continue;
          }
          throw new SourceError(`上游返回 ${response.status} ${path}`, { path, status: response.status });
        }
        const text = await response.text();
        let parsed = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch (error) {
            throw new SourceError(`上游返回的不是 JSON：${path}`, { path, status: response.status, cause: error });
          }
        }
        return { status: response.status, body: parsed };
      } catch (error) {
        if (error instanceof SourceError) throw error;
        lastError = error;
        if (attempt >= this.retries) break;
        attempt += 1;
        await delay(Math.min(150 * attempt, 600), undefined, { signal: this.signal }).catch(() => {});
      }
    }
    throw new SourceError(`无法读取上游 ${path}: ${lastError?.message ?? '未知错误'}`, { path, cause: lastError });
  }

  async health() {
    const result = await this.request('/health');
    return result.status === 200 && result.body?.status === 'ok';
  }

  async tickets() {
    const result = await this.request('/tickets/transfers');
    if (result.status === 404 || !result.body) return [];
    if (!Array.isArray(result.body)) throw new SourceError('票务资料不是数组：/tickets/transfers', { path: '/tickets/transfers' });
    return result.body;
  }

  /** 从 /sorting/batches 的入口页开始，按 next 读完每个分拣点/批次的页面。 */
  async sorting() {
    const index = await this.request('/sorting/batches');
    if (index.status === 404 || !index.body) return [];
    const listed = Array.isArray(index.body) ? index.body : [index.body];
    const pages = [];
    for (const item of listed) {
      const entry = item.page ?? `/sorting/${item.id}?page=1`;
      const id = item.id ?? entry;
      pages.push(...(await this.readSortingPages(entry, id)));
    }
    return pages;
  }

  async readSortingPages(firstPath, id) {
    const pages = [];
    const visited = new Set();
    let path = firstPath;
    while (path) {
      if (visited.has(path)) throw new SourceError(`分拣页出现循环 next：${path}`, { path });
      if (visited.size >= this.maxPages) throw new SourceError(`分拣页超过 ${this.maxPages} 页，停止读取`, { path });
      visited.add(path);
      const result = await this.request(path);
      if (result.status === 404 || !result.body || typeof result.body !== 'object') {
        pages.push({ id, page: path, entries: [], complete: false, next: null, error: 'not-found' });
        break;
      }
      const entries = Array.isArray(result.body.entries) ? result.body.entries : [];
      const next = typeof result.body.next === 'string' && result.body.next ? result.body.next : null;
      const published = result.body.complete;
      // 有 next 就继续翻页；complete 未给出时按“next 为空”判断。
      pages.push({
        id,
        page: path,
        entries,
        complete: next === null && (published === undefined ? true : published === true),
        next,
        publishedComplete: published,
      });
      path = next;
    }
    return pages;
  }

  /** 受理页可按批次逐个读取，也支持返回批次列表。 */
  async receiving() {
    const result = await this.request('/receiving/handoffs');
    if (result.status === 404 || !result.body) return [];
    const batches = Array.isArray(result.body) ? result.body : [result.body];
    const collected = [];
    for (const batch of batches) {
      if (batch && typeof batch === 'object' && typeof batch.page === 'string') {
        const page = await this.request(batch.page);
        collected.push({ ...(page.body ?? {}), batch: page.body?.batch ?? batch.batch ?? batch.id });
      } else {
        collected.push(batch);
      }
    }
    return collected.filter(Boolean);
  }

  async handover() {
    const result = await this.request('/shifts/handover');
    if (result.status === 404) return null;
    return result.body ?? null;
  }

  async manual() {
    const result = await this.request('/reports/manual');
    if (result.status === 404 || !result.body) return [];
    if (!Array.isArray(result.body)) throw new SourceError('人工报告不是数组：/reports/manual', { path: '/reports/manual' });
    return result.body;
  }

  /** 一次采集全部资料；单个来源失败不伪造空资料，而是带错误返回，让工作台显示“缺证据”。 */
  async collect() {
    const startedAt = new Date().toISOString();
    const errors = [];
    const settle = async (name, run) => {
      try {
        return await run();
      } catch (error) {
        errors.push({ source: name, message: error.message, path: error.path ?? null });
        return undefined;
      }
    };
    const [tickets, sorting, receiving, handover, manual] = await Promise.all([
      settle('tickets', () => this.tickets()),
      settle('sorting', () => this.sorting()),
      settle('receiving', () => this.receiving()),
      settle('handover', () => this.handover()),
      settle('manual', () => this.manual()),
    ]);
    return {
      collectedAt: startedAt,
      finishedAt: new Date().toISOString(),
      tickets,
      sorting,
      receiving,
      handover,
      manual,
      errors,
    };
  }
}
