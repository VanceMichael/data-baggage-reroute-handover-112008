// Small read-only HTTP surface. It serves the ground-staff workbench and instruction ledger.
// It does not call any booking or aircraft-loading API.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { collectAll, SourceError } from './collect.mjs';
import { buildEvidence } from './evidence.mjs';
import { evaluateEvidence } from './evaluate.mjs';
import { createLedger, LedgerError, INSTRUCTION_STATE } from './ledger.mjs';
import { createConfirmations, ConfirmationError, asManualRows } from './confirmations.mjs';
import { renderWorkbench } from './view.mjs';

const MAX_BODY = 1 << 20;

function json(response, status, body) {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function html(response, status, body) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function redirect(response, location) {
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
}

async function readForm(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new LedgerError('请求体过大', { status: 413, code: 'body-too-large' });
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new LedgerError('请求体过大', { status: 413, code: 'body-too-large' });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new LedgerError('请求体不是合法 JSON', { status: 400, code: 'invalid-json' });
  }
}

export function createApp({ sourceBaseUrl, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  if (!sourceBaseUrl) throw new Error('缺少来源地址');
  const ledger = createLedger({ now });
  const confirmations = createConfirmations({ now });
  let latest = null;
  let lastError = null;
  let refreshedAt = null;
  // Identities (traveller/segment/carriers) are stable across source snapshots. Keeping them lets a
  // later withdrawal notice without flight numbers still resolve the right teams.
  const knownIdentities = new Map();

  async function refresh() {
    try {
      const collected = await collectAll(sourceBaseUrl, { fetchImpl });
      const sortingProblems = collected.sorting.problems ?? [];
      // Locally registered bilateral facts are merged with the late-arriving source reports.
      const manualReports = [...(collected.manual.reports ?? []), ...asManualRows(confirmations.list())];
      const evidence = buildEvidence({
        tickets: collected.tickets,
        sorting: collected.sorting,
        receiving: collected.receiving,
        manual: { ...collected.manual, reports: manualReports },
        shifts: collected.shifts,
        knownIdentities,
      });
      for (const transfer of evidence.transfers.values()) {
        const existing = knownIdentities.get(transfer.transfer) ?? {};
        knownIdentities.set(transfer.transfer, {
          traveller: transfer.traveller ?? existing.traveller ?? null,
          segment: transfer.segment ?? existing.segment ?? null,
          oldCarrier: transfer.oldCarrier ?? existing.oldCarrier ?? null,
          newCarrier: transfer.newCarrier ?? existing.newCarrier ?? null,
        });
      }
      if (collected.receiving.problem) evidence.problems ??= [], evidence.problems.push(collected.receiving.problem);
      if (collected.tickets.problem) evidence.problems ??= [], evidence.problems.push(collected.tickets.problem);
      if (collected.manual.problem) evidence.problems ??= [], evidence.problems.push(collected.manual.problem);

      const bags = [];
      const evaluated = evaluateEvidence({
        evidence,
        receiving: collected.receiving,
        tickets: collected.tickets,
        sortingProblems,
      });
      bags.push(...evaluated.bags);
      ledger.reconcile(bags, { shift: evaluated.shift?.shift ?? null });
      latest = {
        ...evaluated,
        source: {
          base: sourceBaseUrl,
          receiving: {
            available: collected.receiving.available,
            empty: collected.receiving.empty,
            batches: collected.receiving.batches,
            complete: collected.receiving.complete,
          },
          sorting: {
            batches: collected.sorting.batches,
            pages: collected.sorting.pages,
            problems: sortingProblems,
          },
          tickets: { available: collected.tickets.available, problem: collected.tickets.problem },
          manual: { available: collected.manual.available, problem: collected.manual.problem },
          shifts: { available: collected.shifts.available, problem: collected.shifts.problem },
        },
        instructions: ledger.list(),
        confirmations: confirmations.list(),
        refreshedAt: now(),
      };
      lastError = null;
      refreshedAt = latest.refreshedAt;
      return latest;
    } catch (error) {
      lastError = { message: error.message, at: now(), code: error instanceof SourceError ? 'source-error' : 'refresh-error' };
      throw error;
    }
  }

  function requireSnapshot() {
    if (!latest) {
      throw new LedgerError('尚未采集来源，请先刷新', { status: 503, code: 'not-refreshed' });
    }
    return latest;
  }

  function findBag(snapshot, transfer, tag) {
    return snapshot.bags.find((bag) => bag.transfer === transfer && bag.originalTag === tag) ?? null;
  }

  function decorate(snapshot) {
    const instructions = ledger.list().map((instruction) => {
      const live = findBag(snapshot, instruction.transfer, instruction.originalTag);
      return {
        ...instruction,
        live: live ? { status: live.status, hold: live.hold, holder: live.holder, newTag: live.newTag } : null,
      };
    });
    const activeByBag = new Map();
    const historyByBag = new Map();
    for (const instruction of instructions) {
      const key = `${instruction.transfer}\u001f${instruction.originalTag}`;
      if (instruction.status === INSTRUCTION_STATE.PENDING || instruction.status === INSTRUCTION_STATE.CLAIMED) {
        activeByBag.set(key, instruction);
      }
      if (!historyByBag.has(key)) historyByBag.set(key, []);
      historyByBag.get(key).push(instruction);
    }
    const bags = snapshot.bags.map((bag) => {
      const key = `${bag.transfer}\u001f${bag.originalTag}`;
      return {
        ...bag,
        instruction: activeByBag.get(key) ?? null,
        instructionHistory: historyByBag.get(key) ?? [],
      };
    });
    const byKey = new Map(bags.map((bag) => [`${bag.transfer}\u001f${bag.originalTag}`, bag]));
    // Traveller groups hold their own bag references; rebuild them so the HTML view sees the
    // decorated bags (including instruction history) rather than the pre-decorate objects.
    const travellers = (snapshot.travellers ?? []).map((group) => ({
      ...group,
      bags: group.bags
        .map((bag) => byKey.get(`${bag.transfer}\u001f${bag.originalTag}`) ?? bag)
        .sort((a, b) => String(a.originalTag ?? '').localeCompare(String(b.originalTag ?? ''))),
    }));
    return { ...snapshot, bags, travellers, instructions };
  }

  const routes = [
    ['GET', '/health', async (request, response) => {
      json(response, 200, { status: 'ok', refreshedAt, error: lastError });
    }],
    ['GET', '/', async (request, response) => {
      let snapshot;
      try {
        snapshot = await refresh();
      } catch (error) {
        html(response, 502, renderWorkbench({
          source: { base: sourceBaseUrl },
          travellers: [],
          bags: [],
          instructions: [],
          problems: [{ kind: 'refresh-error', message: error.message }],
          shift: { shift: null, teams: {} },
          refreshedAt: null,
          fetchError: error.message,
        }));
        return;
      }
      html(response, 200, renderWorkbench(decorate(snapshot)));
    }],
    ['GET', '/api/snapshot', async (request, response) => {
      if (!latest && !request.query.has('refresh')) {
        json(response, 503, { error: '尚未采集来源，请先刷新', code: 'not-refreshed' });
        return;
      }
      await refresh();
      json(response, 200, decorate(requireSnapshot()));
    }],
    ['POST', '/api/refresh', async (request, response) => {
      json(response, 200, decorate(await refresh()));
    }],
    ['GET', '/api/instructions', async (request, response) => {
      json(response, 200, { instructions: decorate(requireSnapshot()).instructions, events: ledger.events() });
    }],
    // Form-encoded fallback for the workbench when JavaScript is unavailable.
    ['POST', '/instructions', async (request, response) => {
      const snapshot = requireSnapshot();
      const form = await readForm(request);
      const bag = findBag(snapshot, form.transfer, form.originalTag);
      if (!bag) throw new LedgerError('该件行李不在当前采集结果中', { status: 404, code: 'bag-not-found' });
      ledger.create({
        bag,
        shift: form.shift ?? snapshot.shift?.shift,
        operator: form.operator,
        note: form.note || null,
      });
      redirect(response, '/');
    }],
    ['POST', '/refresh', async (request, response) => {
      // A failed collection must not replace the page with raw JSON in a plain browser.
      try {
        await refresh();
      } catch {
        // The next GET / renders the failure explicitly.
      }
      redirect(response, '/');
    }],
    ['POST', '/instructions/:id/claim', async (request, response) => {
      const snapshot = requireSnapshot();
      const form = await readForm(request);
      ledger.claim(request.params.id, { shift: form.shift ?? snapshot.shift?.shift, operator: form.operator });
      redirect(response, '/');
    }],
    ['POST', '/instructions/:id/handover', async (request, response) => {
      const form = await readForm(request);
      const acceptedBy = (form.acceptedBy ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      ledger.handOver(request.params.id, {
        toShift: form.toShift,
        toOperator: form.toOperator,
        acceptedBy,
        note: form.note || null,
      });
      redirect(response, '/');
    }],
    ['POST', '/instructions/:id/close', async (request, response) => {
      const snapshot = requireSnapshot();
      const form = await readForm(request);
      const instruction = ledger.get(request.params.id);
      if (!instruction) throw new LedgerError('找不到该交接指令', { status: 404, code: 'instruction-not-found' });
      const bag = findBag(snapshot, instruction.transfer, instruction.originalTag);
      ledger.close(request.params.id, {
        basis: { kind: form.kind, newTag: form.newTag || null, bag },
        operator: form.operator || null,
        shift: form.shift || snapshot.shift?.shift,
        note: form.note || null,
      });
      redirect(response, '/');
    }],
    ['POST', '/instructions/:id/revoke', async (request, response) => {
      const form = await readForm(request);
      ledger.revoke(request.params.id, { operator: form.operator || null, shift: form.shift || null, reason: form.reason || null });
      redirect(response, '/');
    }],
    ['POST', '/api/instructions', async (request, response) => {
      const snapshot = requireSnapshot();
      const body = await readBody(request);
      const bag = findBag(snapshot, body.transfer, body.originalTag ?? body.tag);
      if (!bag) throw new LedgerError('该件行李不在当前采集结果中', { status: 404, code: 'bag-not-found' });
      const instruction = ledger.create({
        bag,
        shift: body.shift ?? snapshot.shift?.shift,
        operator: body.operator,
        note: body.note,
        chain: body.chain ? { id: body.chain.id, batch: body.chain.batch } : bag.chain,
      });
      json(response, 201, { instruction });
    }],
    ['POST', '/api/confirmations', async (request, response) => {
      const snapshot = requireSnapshot();
      const body = await readBody(request);
      const bag = findBag(snapshot, body.transfer, body.originalTag ?? body.tag);
      let record;
      try {
        record = confirmations.register(body, { bag, shift: body.shift ?? snapshot.shift?.shift });
      } catch (error) {
        if (error instanceof ConfirmationError) throw new LedgerError(error.message, { status: error.status, code: error.code });
        throw error;
      }
      await refresh();
      json(response, 201, { confirmation: record, snapshot: decorate(requireSnapshot()) });
    }],
    ['POST', '/confirmations', async (request, response) => {
      const snapshot = requireSnapshot();
      const form = await readForm(request);
      const bag = findBag(snapshot, form.transfer, form.originalTag);
      try {
        confirmations.register(
          { ...form, acceptedBy: (form.acceptedBy ?? '').split(',').map((value) => value.trim()).filter(Boolean) },
          { bag, shift: form.shift ?? snapshot.shift?.shift },
        );
      } catch (error) {
        if (error instanceof ConfirmationError) throw new LedgerError(error.message, { status: error.status, code: error.code });
        throw error;
      }
      await refresh();
      redirect(response, '/');
    }],
    ['GET', '/api/confirmations', async (request, response) => {
      json(response, 200, { confirmations: confirmations.list() });
    }],
    ['POST', '/api/instructions/:id/claim', async (request, response) => {
      const snapshot = requireSnapshot();
      const body = await readBody(request);
      const instruction = ledger.claim(request.params.id, {
        shift: body.shift ?? snapshot.shift?.shift,
        operator: body.operator,
      });
      json(response, 200, { instruction });
    }],
    ['POST', '/api/instructions/:id/handover', async (request, response) => {
      const body = await readBody(request);
      const instruction = ledger.handOver(request.params.id, body);
      json(response, 200, { instruction });
    }],
    ['POST', '/api/instructions/:id/close', async (request, response) => {
      const snapshot = requireSnapshot();
      const body = await readBody(request);
      const instruction = ledger.get(request.params.id);
      if (!instruction) throw new LedgerError('找不到该交接指令', { status: 404, code: 'instruction-not-found' });
      const bag = findBag(snapshot, instruction.transfer, instruction.originalTag);
      const closed = ledger.close(request.params.id, {
        basis: { ...body, bag },
        operator: body.operator,
        shift: body.shift ?? snapshot.shift?.shift,
        note: body.note,
      });
      json(response, 200, { instruction: closed });
    }],
    ['POST', '/api/instructions/:id/revoke', async (request, response) => {
      const body = await readBody(request);
      const instruction = ledger.revoke(request.params.id, {
        operator: body.operator,
        shift: body.shift,
        reason: body.reason,
      });
      json(response, 200, { instruction });
    }],
    ['GET', '/api/bags/:transfer/:tag', async (request, response) => {
      const snapshot = requireSnapshot();
      let tag;
      try {
        tag = decodeURIComponent(request.params.tag);
      } catch {
        throw new LedgerError('条码编码无效', { status: 400, code: 'invalid-tag' });
      }
      const bag = findBag(snapshot, request.params.transfer, tag);
      if (!bag) throw new LedgerError('找不到该件行李', { status: 404, code: 'bag-not-found' });
      json(response, 200, { bag, instructions: ledger.findByBag(bag.transfer, bag.originalTag) });
    }],
  ];

  const compiled = routes.map(([method, pattern, handler]) => ({ method, pattern, handler, ...compile(pattern) }));

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      request.query = url.searchParams;
      for (const route of compiled) {
        if (route.method !== request.method) continue;
        const params = route.match(url.pathname);
        if (!params) continue;
        request.params = params;
        await route.handler(request, response, url);
        return;
      }
      json(response, 404, { error: '没有这条路径' });
    } catch (error) {
      if (error instanceof LedgerError) {
        json(response, error.status, { error: error.message, code: error.code, details: error.details });
        return;
      }
      if (error instanceof SourceError) {
        json(response, 502, { error: error.message, code: 'source-error', path: error.path });
        return;
      }
      if (!response.headersSent) json(response, 500, { error: '内部错误', detail: error.message });
      else response.end();
    }
  });
}

function compile(pattern) {
  if (!pattern.includes(':')) {
    return { match: (pathname) => (pathname === pattern ? {} : null) };
  }
  const segments = pattern.split('/');
  return {
    match(pathname) {
      const actual = pathname.split('/');
      if (actual.length !== segments.length) return null;
      const params = {};
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment.startsWith(':')) {
          if (actual[index] === '') return null;
          params[segment.slice(1)] = actual[index];
        } else if (segment !== actual[index]) {
          return null;
        }
      }
      return params;
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.APP_PORT ?? process.env.PORT ?? 4180);
  const source = process.env.SOURCE_URL ?? `http://127.0.0.1:${process.env.SOURCE_PORT ?? 4173}`;
  const server = createApp({ sourceBaseUrl: source });
  server.listen(port, '127.0.0.1', function () {
    process.stdout.write(`地服工作台 http://127.0.0.1:${this.address().port}（来源 ${source}）\n`);
  });
}

export { INSTRUCTION_STATE };
