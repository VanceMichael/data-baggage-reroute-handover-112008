/**
 * 地服工作台 HTTP 服务（只读采集 + 本地认领/双边事实登记）。
 *
 * 不代理订票，也不向行李设备发送装机/卸机命令。
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Collector } from './collector.mjs';
import { buildModel } from './model.mjs';
import { WorkbenchError, WorkbenchStore, buildWorkbench } from './workbench.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new WorkbenchError('请求体过大', 413, 'body_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value;
  } catch {
    throw new WorkbenchError('请求体需要是 JSON 对象', 400, 'invalid_json');
  }
}

function safePublicPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const candidate = normalize(join(PUBLIC_DIR, decoded === '/' ? 'index.html' : decoded));
  if (candidate !== PUBLIC_DIR.replace(/[\\/]$/, '') && !candidate.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    return null;
  }
  return candidate;
}

async function serveStatic(request, response, pathname) {
  const file = safePublicPath(pathname);
  if (!file) {
    json(response, 403, { error: '路径不合法' });
    return true;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    response.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {string} options.sourceBase    上游合成来源地址
 * @param {string|null} options.statePath 工作台认领/事实持久化文件；null 表示仅内存
 * @param {Function} [options.now]       可注入时钟，便于测试
 * @param {Function} [options.fetchImpl] 便于测试替换
 */
export function createWorkbenchServer({ sourceBase = 'http://127.0.0.1:4173', statePath = null, now, fetchImpl } = {}) {
  const store = new WorkbenchStore({ statePath, now });
  const collector = new Collector({ baseUrl: sourceBase, fetchImpl });

  async function snapshot() {
    const collected = await collector.collect();
    if (!collected.tickets) collected.tickets = [];
    if (!collected.sorting) collected.sorting = [];
    if (!collected.receiving) collected.receiving = [];
    if (!collected.manual) collected.manual = [];
    const manual = [...collected.manual, ...store.manualReports()];
    const model = buildModel({
      tickets: collected.tickets,
      sorting: collected.sorting,
      receiving: collected.receiving,
      handover: collected.handover,
      manual,
    });
    if (collected.errors.length) {
      model.warnings.unshift(...collected.errors.map((error) => `来源 ${error.source} 读取失败：${error.message}。相关证据按缺失处理，不当作“没有资料”。`));
    }
    model.collection = {
      collectedAt: collected.collectedAt,
      finishedAt: collected.finishedAt,
      errors: collected.errors,
      sourceBase,
    };
    return { model, workbench: buildWorkbench(model, store) };
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    try {
      if (path === '/api/view' && request.method === 'GET') {
        json(response, 200, await snapshot());
        return;
      }
      if (path === '/api/facts' && request.method === 'GET') {
        json(response, 200, { facts: store.facts() });
        return;
      }
      if (path === '/api/health' && request.method === 'GET') {
        let reachable = false;
        try {
          reachable = await collector.health();
        } catch {
          reachable = false;
        }
        json(response, 200, { status: 'ok', source: reachable ? 'ok' : 'unreachable' });
        return;
      }
      if (path === '/api/claims' && request.method === 'POST') {
        const body = await readJson(request);
        const { model } = await snapshot();
        const result = store.claim(body, model);
        json(response, result.created ? 201 : 200, result);
        return;
      }
      if (path === '/api/claims/release' && request.method === 'POST') {
        const body = await readJson(request);
        json(response, 200, store.release(body));
        return;
      }
      if (path === '/api/claims/reassign' && request.method === 'POST') {
        const body = await readJson(request);
        json(response, 200, store.reassign(body));
        return;
      }
      if (path === '/api/claims/resolve' && request.method === 'POST') {
        const body = await readJson(request);
        const { model } = await snapshot();
        json(response, 200, store.resolve(body, model));
        return;
      }
      if (path === '/api/facts' && request.method === 'POST') {
        const body = await readJson(request);
        const result = store.registerFact(body, { operator: body.operator, shift: body.shift });
        json(response, result.created ? 201 : 200, result);
        return;
      }
      if (request.method === 'GET' && (await serveStatic(request, response, path))) return;
      json(response, 404, { error: '没有这个接口或页面' });
    } catch (error) {
      if (error instanceof WorkbenchError) {
        json(response, error.status, { error: error.message, code: error.code });
      } else {
        json(response, 500, { error: `工作台出错：${error.message}` });
      }
    }
  });

  server.store = store;
  server.snapshot = snapshot;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.WORKBENCH_PORT ?? process.env.PORT ?? 4180);
  const sourceBase = process.env.SOURCE_URL ?? `http://127.0.0.1:${process.env.SOURCE_PORT ?? 4173}`;
  const server = createWorkbenchServer({
    sourceBase,
    statePath: process.env.WORKBENCH_STATE ?? null,
  });
  server.listen(port, '127.0.0.1', function () {
    process.stdout.write(`地服工作台 http://127.0.0.1:${this.address().port}（来源 ${sourceBase}）\n`);
  });
}
