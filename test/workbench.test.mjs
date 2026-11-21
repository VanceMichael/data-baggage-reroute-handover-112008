import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import { createApp } from '../app/server.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(context) {
  const source = createSource();
  context.after(() => source.close());
  const sourceUrl = await listen(source);

  const app = createApp({ sourceBaseUrl: sourceUrl, now: monotonic() });
  context.after(() => app.close());
  const appUrl = await listen(app);
  return { sourceUrl, appUrl };
}

function monotonic() {
  let tick = 0;
  return () => {
    tick += 1;
    return `2026-12-04T12:00:${String(tick % 60).padStart(2, '0')}.${String(tick).padStart(3, '0')}Z`;
  };
}

async function clock(sourceUrl, step) {
  const response = await fetch(`${sourceUrl}/_source_clock?step=${step}`, { method: 'PUT' });
  assert.equal(response.status, 200);
}

async function snapshot(appUrl) {
  const response = await fetch(`${appUrl}/api/snapshot?refresh`);
  assert.equal(response.status, 200);
  return response.json();
}

const bagOf = (state, transfer, tag) => state.bags.find((bag) => bag.transfer === transfer && bag.originalTag === tag);

test('workbench follows the staged synthetic source end to end', async (context) => {
  const { sourceUrl, appUrl } = await setup(context);

  await clock(sourceUrl, 'book');
  let state = await snapshot(appUrl);
  assert.equal(state.shift.shift, 'M1');
  assert.equal(bagOf(state, 'T7', 'OA-01').status, '待确认');
  assert.equal(bagOf(state, 'T7', 'OA-02').status, '待确认');
  // T8 has no sorting or receiving row yet and sorting page 2 is still incomplete, so the
  // workbench must wait for confirmation rather than declaring the bag missing.
  const t8 = state.bags.find((bag) => bag.transfer === 'T8');
  assert.equal(t8.status, '待确认');
  assert.equal(t8.originalTag, null);
  assert.ok(t8.reasons.some((entry) => entry.code === 'transfer-without-bag-yet'));

  await clock(sourceUrl, 'dispatch');
  state = await snapshot(appUrl);
  const held = bagOf(state, 'T7', 'OA-02');
  assert.equal(held.status, '必须人工处理');
  assert.equal(held.hold, true);
  assert.equal(bagOf(state, 'T7', 'OA-01').status, '待确认');

  await clock(sourceUrl, 'receive');
  state = await snapshot(appUrl);
  assert.equal(bagOf(state, 'T7', 'OA-01').status, '可交接');
  assert.equal(bagOf(state, 'T7', 'OA-01').newTag, 'NB-19');
  assert.equal(bagOf(state, 'T8', 'OA-03').status, '待确认');
  assert.ok(bagOf(state, 'T8', 'OA-03').reasons.some((entry) => entry.code === 'receiving-rejected'));

  await clock(sourceUrl, 'withdraw');
  state = await snapshot(appUrl);
  const withdrawnBag = bagOf(state, 'T7', 'OA-01');
  assert.equal(withdrawnBag.status, '必须人工处理');
  assert.equal(withdrawnBag.holder.side, 'new');
  assert.ok(withdrawnBag.observations.some((entry) => entry.code === 'late-backfill-ignored'));

  await clock(sourceUrl, 'correction');
  state = await snapshot(appUrl);
  assert.equal(state.shift.shift, 'M2');
  const resolved = bagOf(state, 'T7', 'OA-01');
  assert.equal(resolved.status, '可交接');
  assert.equal(resolved.holder.side, 'old');
  assert.equal(resolved.holder.team, 'A-ground');
  assert.ok(resolved.observations.some((entry) => entry.code === 'new-tag-retained'));
});

test('instruction lifecycle over HTTP respects claims and credentials', async (context) => {
  const { sourceUrl, appUrl } = await setup(context);
  await clock(sourceUrl, 'receive');
  let state = await snapshot(appUrl);

  const create = await fetch(`${appUrl}/api/instructions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transfer: 'T7', originalTag: 'OA-01', operator: 'alice', shift: 'M1' }),
  });
  assert.equal(create.status, 201);
  const { instruction } = await create.json();
  assert.equal(instruction.status, 'pending');
  assert.equal(instruction.chain.batch, 'G6');
  assert.equal(instruction.evidence.newTag, 'NB-19');

  const duplicate = await fetch(`${appUrl}/api/instructions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transfer: 'T7', originalTag: 'OA-01', operator: 'alice', shift: 'M1' }),
  });
  assert.equal(duplicate.status, 409);

  const held = await fetch(`${appUrl}/api/instructions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transfer: 'T7', originalTag: 'OA-02', operator: 'alice', shift: 'M1' }),
  });
  assert.equal(held.status, 409);
  assert.equal((await held.json()).code, 'bag-on-hold');

  const claim = await fetch(`${appUrl}/api/instructions/${instruction.id}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operator: 'alice', shift: 'M1' }),
  });
  assert.equal(claim.status, 200);

  const bareHandover = await fetch(`${appUrl}/api/instructions/${instruction.id}/handover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toOperator: 'bob', toShift: 'M2' }),
  });
  assert.equal(bareHandover.status, 409);

  const bilateral = await fetch(`${appUrl}/api/instructions/${instruction.id}/handover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toOperator: 'bob', toShift: 'M2', acceptedBy: ['alice', 'bob'] }),
  });
  assert.equal(bilateral.status, 200);

  const close = await fetch(`${appUrl}/api/instructions/${instruction.id}/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'receiving', newTag: 'NB-19', operator: 'bob', shift: 'M2' }),
  });
  assert.equal(close.status, 200);
  const closed = (await close.json()).instruction;
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closure.source, 'receiving');

  const ledgerState = await (await fetch(`${appUrl}/api/instructions`)).json();
  assert.deepEqual(ledgerState.events.map((event) => event.action), ['created', 'claimed', 'handed-over', 'closed']);

  // The snapshot now carries the active instruction reference on the bag, and closed ones do not.
  state = await snapshot(appUrl);
  assert.equal(bagOf(state, 'T7', 'OA-01').instruction, null);
});

test('a withdrawn transfer invalidates an open instruction and keeps its original evidence', async (context) => {
  const { sourceUrl, appUrl } = await setup(context);
  await clock(sourceUrl, 'receive');
  await snapshot(appUrl);

  const create = await fetch(`${appUrl}/api/instructions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transfer: 'T7', originalTag: 'OA-01', operator: 'alice', shift: 'M1' }),
  });
  const { instruction } = await create.json();

  await clock(sourceUrl, 'withdraw');
  const state = await snapshot(appUrl);
  const live = state.instructions.find((item) => item.id === instruction.id);
  assert.equal(live.status, 'invalidated');
  assert.equal(live.evidence.newTag, 'NB-19');
  assert.equal(live.live.status, '必须人工处理');

  const closeAttempt = await fetch(`${appUrl}/api/instructions/${instruction.id}/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'receiving', operator: 'bob', shift: 'M2' }),
  });
  assert.equal(closeAttempt.status, 409);
});

test('the rendered workbench shows status, gaps and contacts without leaking raw HTML', async (context) => {
  const { sourceUrl, appUrl } = await setup(context);
  await clock(sourceUrl, 'dispatch');
  const response = await fetch(`${appUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const page = await response.text();
  assert.match(page, /跨航司签转行李交运工作台/);
  assert.match(page, /必须人工处理/);
  assert.match(page, /原条码 OA-02/);
  assert.match(page, /证据缺在哪/);
  assert.match(page, /下一步联系谁/);
  assert.doesNotMatch(page, /<script>alert/);
});

test('unreachable source degrades to an explicit error page', async (context) => {
  const app = createApp({ sourceBaseUrl: 'http://127.0.0.1:9', now: monotonic() });
  context.after(() => app.close());
  const appUrl = await listen(app);

  const response = await fetch(`${appUrl}/`);
  assert.equal(response.status, 502);
  const page = await response.text();
  assert.match(page, /采集失败/);

  const health = await (await fetch(`${appUrl}/health`)).json();
  assert.equal(health.status, 'ok');
  assert.ok(health.error);

  const api = await fetch(`${appUrl}/api/snapshot`);
  assert.equal(api.status, 503);
});

test('the withdrawal snapshot still resolves teams even though it omits flight numbers', async (context) => {
  const { sourceUrl, appUrl } = await setup(context);
  await clock(sourceUrl, 'receive');
  await snapshot(appUrl);
  await clock(sourceUrl, 'withdraw');
  const state = await snapshot(appUrl);
  const bag = bagOf(state, 'T7', 'OA-01');
  assert.equal(bag.status, '必须人工处理');
  assert.equal(bag.newCarrier, 'XB303');
  assert.equal(bag.holder.side, 'new');
  assert.equal(bag.holder.team, 'B-ground');
  assert.ok(bag.nextContacts.some((contact) => contact.team === 'A-ground'));
});
