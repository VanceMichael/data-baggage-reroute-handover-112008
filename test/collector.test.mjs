import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Collector, SourceError } from '../src/collector.mjs';
import { createSource } from '../sources/source.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/source.json', import.meta.url), 'utf8'));

async function startSource() {
  const server = createSource();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function advance(base, step) {
  const response = await fetch(`${base}/_source_clock?step=${step}`, { method: 'PUT' });
  assert.equal(response.status, 200);
}

test('采集器按 next 翻完分拣页，且保留各页的完整度', async (context) => {
  const { server, base } = await startSource();
  context.after(() => server.close());

  await advance(base, 'book');
  const book = await new Collector({ baseUrl: base }).collect();
  assert.deepEqual(book.errors, []);
  assert.equal(book.sorting.length, 2);
  assert.equal(book.sorting[0].page, '/sorting/S8?page=1');
  assert.equal(book.sorting[0].next, '/sorting/S8?page=2');
  assert.equal(book.sorting[1].complete, false);
  assert.deepEqual(book.receiving[0].rows, []);
  assert.equal(book.receiving[0].complete, false);

  await advance(base, 'dispatch');
  const dispatch = await new Collector({ baseUrl: base }).collect();
  assert.equal(dispatch.sorting[1].complete, true);
  assert.equal(dispatch.sorting[1].entries.length, 2);
  assert.ok(dispatch.sorting.some((page) => page.entries.some((entry) => entry.state === 'loaded')));
});

test('采集器原样取回受理、班次与人工报告，不做企业级合并', async (context) => {
  const { server, base } = await startSource();
  context.after(() => server.close());

  await advance(base, 'correction');
  const collected = await new Collector({ baseUrl: base }).collect();
  assert.equal(collected.receiving[0].batch, 'G6');
  assert.equal(collected.receiving[0].rows.length, 2);
  assert.equal(collected.handover.shift, 'M2');
  assert.equal(collected.handover.replaces, 'M1');
  assert.equal(collected.manual[0].type, 'return');
  assert.equal(collected.manual[0].acceptedBy.length, 2);
});

test('单个来源失败会报错而不是伪造为空', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/tickets/transfers')) return new Response('boom', { status: 500 });
    if (url.endsWith('/sorting/batches')) return new Response(JSON.stringify([]), { status: 200 });
    if (url.endsWith('/receiving/handoffs')) return new Response(JSON.stringify({ batch: 'G', complete: true, rows: [] }), { status: 200 });
    if (url.endsWith('/shifts/handover')) return new Response(JSON.stringify({ shift: 'M1', teams: {} }), { status: 200 });
    return new Response(JSON.stringify([]), { status: 200 });
  };
  const collected = await new Collector({ baseUrl: 'http://source.test', fetchImpl, retries: 0 }).collect();
  assert.equal(collected.tickets, undefined);
  assert.equal(collected.errors.length, 1);
  assert.equal(collected.errors[0].source, 'tickets');
  assert.match(collected.errors[0].message, /500/);
  assert.ok(Array.isArray(collected.sorting));
});

test('404 的单个来源返回空，但不抛错', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/reports/manual')) return new Response(null, { status: 404 });
    if (url.endsWith('/sorting/batches')) return new Response(null, { status: 404 });
    if (url.endsWith('/receiving/handoffs')) return new Response(null, { status: 404 });
    if (url.endsWith('/shifts/handover')) return new Response(null, { status: 404 });
    return new Response(JSON.stringify([]), { status: 200 });
  };
  const collected = await new Collector({ baseUrl: 'http://source.test', fetchImpl }).collect();
  assert.deepEqual(collected.manual, []);
  assert.deepEqual(collected.sorting, []);
  assert.deepEqual(collected.receiving, []);
  assert.equal(collected.handover, null);
  assert.deepEqual(collected.errors, []);
});

test('分拣页 next 循环会中止并报错', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/sorting/batches')) {
      return new Response(JSON.stringify([{ id: 'S1', page: '/sorting/S1?page=1' }]), { status: 200 });
    }
    if (url.includes('/sorting/S1')) {
      return new Response(JSON.stringify({ entries: [], next: '/sorting/S1?page=1' }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
  const collector = new Collector({ baseUrl: 'http://source.test', fetchImpl });
  await assert.rejects(() => collector.sorting(), (error) => {
    assert.ok(error instanceof SourceError);
    assert.match(error.message, /循环/);
    return true;
  });
});

test('上游返回非 JSON 时明确报错', async () => {
  const fetchImpl = async () => new Response('<html>not json</html>', { status: 200 });
  const collector = new Collector({ baseUrl: 'http://source.test', fetchImpl, retries: 0 });
  await assert.rejects(() => collector.tickets(), /不是 JSON/);
});

test('夹具步骤都能被采集器读到（与预置资料一致）', async () => {
  const { readFileSync: read } = await import('node:fs');
  assert.ok(Array.isArray(fixture.steps) && fixture.steps.length > 0);
  const { server, base } = await startSource();
  try {
    for (const step of fixture.steps) {
      await advance(base, step);
      const collected = await new Collector({ baseUrl: base }).collect();
      assert.deepEqual(collected.errors, [], step);
    }
  } finally {
    server.close();
  }
  // 保持对夹具形状的显式读取，避免测试悄悄脱离来源约定。
  assert.ok(read(new URL('../fixtures/source.json', import.meta.url)).length > 0);
});
