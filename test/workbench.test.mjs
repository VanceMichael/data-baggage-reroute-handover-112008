import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { WorkbenchError, WorkbenchStore, buildWorkbench } from '../src/workbench.mjs';
import { buildModel } from '../src/model.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function startPair(context) {
  const source = createSource();
  const sourceBase = await listen(source);
  const workbench = createWorkbenchServer({
    sourceBase,
    now: () => '2026-12-04T09:20:00+08:00',
  });
  const base = await listen(workbench);
  context.after(() => {
    workbench.close();
    source.close();
  });
  return {
    source,
    workbench,
    sourceBase,
    base,
    async clock(step) {
      await fetch(`${sourceBase}/_source_clock?step=${step}`, { method: 'PUT' });
    },
    async view() {
      const response = await fetch(`${base}/api/view`);
      assert.equal(response.status, 200);
      return response.json();
    },
    async post(path, body) {
      return fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    },
  };
}

const sampleModel = () => buildModel({
  tickets: [{ traveller: 'P1', segment: 'S', old: 'XA', new: 'XB', transfer: 'T1', state: 'confirmed', at: '2026-12-04T09:00:00+08:00' }],
  sorting: [{ id: 'S1', entries: [{ tag: 'OA-1', traveller: 'P1', segment: 'S', state: 'transfer', seq: 1, at: '2026-12-04T09:05:00+08:00' }], complete: true }],
  receiving: [{ batch: 'G1', complete: true, rows: [{ transfer: 'T1', oldTag: 'OA-1', newTag: 'NB-1', accepted: true, at: '2026-12-04T09:10:00+08:00', signedBy: 'B-ground' }] }],
  handover: { shift: 'M1', teams: { XA: 'A-ground', XB: 'B-ground' } },
  manual: [],
});

test('工作台采集返回可衔接的模型与认领视图', async (context) => {
  const app = await startPair(context);
  await app.clock('receive');
  const view = await app.view();
  assert.equal(view.model.pieces.find((piece) => piece.id === 'T7/OA-01').status, 'handover');
  assert.equal(view.workbench.counts.handover, 1);
  assert.equal(view.workbench.shift, 'M1');
  assert.equal(view.workbench.travellers.length, 2);
});

test('认领必须来自当前班次与正确交运链，同一件只能有一个有效认领', async (context) => {
  const app = await startPair(context);
  await app.clock('receive');

  const wrongShift = await app.post('/api/claims', { code: 'T7/OA-01', chain: 'T7', shift: 'M0', operator: 'op-1' });
  assert.equal(wrongShift.status, 409);
  assert.equal((await wrongShift.json()).code, 'shift_mismatch');

  const wrongChain = await app.post('/api/claims', { code: 'T7/OA-01', chain: 'T8', shift: 'M1', operator: 'op-1' });
  assert.equal(wrongChain.status, 409);
  assert.equal((await wrongChain.json()).code, 'chain_mismatch');

  const ok = await app.post('/api/claims', { code: 'T7/OA-01', chain: 'T7', shift: 'M1', operator: 'op-1' });
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.equal(body.claim.operator, 'op-1');
  assert.equal(body.claim.status, 'claimed');
  assert.ok(body.claim.reliedOn.receipt);

  const duplicate = await app.post('/api/claims', { code: 'T7/OA-01', chain: 'T7', shift: 'M1', operator: 'op-2' });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'already_claimed');

  const sameOwner = await app.post('/api/claims', { code: 'T7/OA-01', chain: 'T7', shift: 'M1', operator: 'op-1' });
  assert.equal(sameOwner.status, 200);
  assert.equal((await sameOwner.json()).created, false);
});

test('不可交接的行李不能认领（已装机/拒收）', async (context) => {
  const app = await startPair(context);
  await app.clock('receive');
  for (const code of ['T7/OA-02', 'T8/OA-03']) {
    const response = await app.post('/api/claims', { code, chain: code.startsWith('T7') ? 'T7' : 'T8', shift: 'M1', operator: 'op-1' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'not_claimable');
  }
});

test('只有现场凭据才允许结案；票务或电话确认不算', async (context) => {
  const app = await startPair(context);
  await app.clock('receive');
  await app.post('/api/claims', { code: 'T7/OA-01', chain: 'T7', shift: 'M1', operator: 'op-1' });

  const premature = await app.post('/api/claims/resolve', { code: 'T7/OA-01', operator: 'op-1' });
  assert.equal(premature.status, 409);
  assert.equal((await premature.json()).code, 'no_physical_evidence');

  const fact = await app.post('/api/facts', {
    transfer: 'T7',
    oldTag: 'OA-01',
    kind: 'return',
    from: 'B-ground',
    to: 'A-ground',
    acceptedBy: ['B-ground', 'A-ground'],
    at: '2026-12-04T09:30:00+08:00',
    operator: 'op-1',
    shift: 'M1',
  });
  assert.equal(fact.status, 201);

  const resolved = await app.post('/api/claims/resolve', { code: 'T7/OA-01', operator: 'op-1' });
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).claim.status, 'resolved');
});

test('双边事实登记要求双方确认和完整现场时间，重复登记幂等', async (context) => {
  const app = await startPair(context);
  await app.clock('receive');

  const notBilateral = await app.post('/api/facts', {
    transfer: 'T7', oldTag: 'OA-01', kind: 'return', from: 'B-ground', to: 'A-ground', acceptedBy: ['B-ground'],
  });
  assert.equal(notBilateral.status, 409);
  assert.equal((await notBilateral.json()).code, 'not_bilateral');

  const same = await app.post('/api/facts', {
    transfer: 'T7', oldTag: 'OA-01', kind: 'return', from: 'B-ground', to: 'B-ground', acceptedBy: ['B-ground', 'B-ground'],
  });
  assert.equal(same.status, 400);

  const badKind = await app.post('/api/facts', {
    transfer: 'T7', oldTag: 'OA-01', kind: 'load', from: 'B-ground', to: 'A-ground', acceptedBy: ['B-ground', 'A-ground'],
  });
  assert.equal(badKind.status, 400);

  const badTime = await app.post('/api/facts', {
    transfer: 'T7', oldTag: 'OA-01', kind: 'return', from: 'B-ground', to: 'A-ground', acceptedBy: ['B-ground', 'A-ground'], at: '09:30',
  });
  assert.equal(badTime.status, 400);

  const payload = {
    transfer: 'T7', oldTag: 'OA-01', kind: 'return', from: 'B-ground', to: 'A-ground',
    acceptedBy: ['B-ground', 'A-ground'], at: '2026-12-04T09:30:00+08:00', operator: 'op-1', shift: 'M1',
  };
  assert.equal((await app.post('/api/facts', payload)).status, 201);
  const again = await app.post('/api/facts', payload);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).created, false);
});

test('班次交替：已认领按原操作人跟踪，待认领交给接班人', async (context) => {
  const app = await startPair(context);
  // 先推进到 receive 班次 M1 认领，再切换到 M2 的 correction 班次。
  await app.clock('receive');
  await app.post('/api/claims', { code: 'T7/OA-01', chain: 'T7', shift: 'M1', operator: 'op-1' });
  await app.clock('correction');

  const view = await app.view();
  assert.equal(view.workbench.shift, 'M2');
  const piece = view.workbench.pieces.find((item) => item.id === 'T7/OA-01');
  assert.equal(piece.claim.carriedOver, true);
  assert.equal(piece.claim.operator, 'op-1');
  assert.match(piece.claimNote, /原操作人/);
  assert.ok(view.workbench.carryOver.claimed.some((item) => item.id === 'T7/OA-01'));
  assert.match(view.workbench.carryOver.note, /M1.*M2/);
});

test('双方转交后操作人更新，释放只能由原认领人执行', async (context) => {
  const app = await startPair(context);
  await app.clock('receive');
  await app.post('/api/claims', { code: 'T7/OA-01', chain: 'T7', shift: 'M1', operator: 'op-1' });

  const notOwner = await app.post('/api/claims/release', { code: 'T7/OA-01', operator: 'op-2' });
  assert.equal(notOwner.status, 409);

  const notBilateral = await app.post('/api/claims/reassign', { code: 'T7/OA-01', operator: 'op-1', from: 'op-1', to: 'op-2', acceptedBy: ['op-1'] });
  assert.equal(notBilateral.status, 409);

  const moved = await app.post('/api/claims/reassign', { code: 'T7/OA-01', operator: 'op-1', from: 'op-1', to: 'op-2', acceptedBy: ['op-1', 'op-2'] });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).claim.operator, 'op-2');

  const released = await app.post('/api/claims/release', { code: 'T7/OA-01', operator: 'op-2' });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).claim.status, 'released');
});

test('撤销后原认领失去依据，工作台标 stale 且不自动改派', async (context) => {
  const app = await startPair(context);
  await app.clock('receive');
  await app.post('/api/claims', { code: 'T7/OA-01', chain: 'T7', shift: 'M1', operator: 'op-1' });
  await app.clock('withdraw');
  const view = await app.view();
  const piece = view.workbench.pieces.find((item) => item.id === 'T7/OA-01');
  assert.equal(piece.status, 'recovery');
  assert.equal(piece.claimState, 'stale');
  assert.equal(piece.claim.operator, 'op-1');
  assert.ok(view.workbench.warnings.some((warning) => warning.includes('失去依据')));
});

test('认领状态可持久化，重启后仍由原操作人跟踪', async (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'handover-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'state.json');
  const source = createSource();
  const sourceBase = await listen(source);
  context.after(() => source.close());
  await fetch(`${sourceBase}/_source_clock?step=receive`, { method: 'PUT' });

  const first = createWorkbenchServer({ sourceBase, statePath });
  const firstBase = await listen(first);
  const response = await fetch(`${firstBase}/api/claims`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'T7/OA-01', chain: 'T7', shift: 'M1', operator: 'op-1' }),
  });
  assert.equal(response.status, 201);
  first.close();

  const second = createWorkbenchServer({ sourceBase, statePath });
  const secondBase = await listen(second);
  context.after(() => second.close());
  const view = await (await fetch(`${secondBase}/api/view`)).json();
  const piece = view.workbench.pieces.find((item) => item.id === 'T7/OA-01');
  assert.equal(piece.claim.operator, 'op-1');
  assert.equal(piece.claimState, 'claimed');
});

test('工作台不提供写上游或设备命令的接口', async (context) => {
  const app = await startPair(context);
  await app.clock('receive');
  for (const path of ['/api/dispatch', '/api/load', '/api/sort', '/api/tickets']) {
    const response = await app.post(path, { code: 'T7/OA-01' });
    assert.equal(response.status, 404, path);
  }
  // 上游只读：工作台登记事实不会调用票务或分拣写接口。
  await app.post('/api/facts', {
    transfer: 'T7', oldTag: 'OA-01', kind: 'return', from: 'B-ground', to: 'A-ground',
    acceptedBy: ['B-ground', 'A-ground'], at: '2026-12-04T09:30:00+08:00',
  });
  const calls = await (await fetch(`${app.sourceBase}/_source_calls`)).json();
  assert.ok(calls.every((call) => call.method === 'GET'), JSON.stringify(calls));
});

test('非法请求体返回 400 而不是崩溃', async (context) => {
  const app = await startPair(context);
  const response = await fetch(`${app.base}/api/claims`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad json',
  });
  assert.equal(response.status, 400);
  const arrayBody = await fetch(`${app.base}/api/claims`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '[]',
  });
  assert.equal(arrayBody.status, 400);
});

test('静态页面可访问，越界路径被拒绝', async (context) => {
  const app = await startPair(context);
  const page = await fetch(`${app.base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /签转行李交运核对台/);
  const css = await fetch(`${app.base}/style.css`);
  assert.equal(css.status, 200);
  const traversal = await fetch(`${app.base}/..%2Fpackage.json`);
  assert.ok([403, 404].includes(traversal.status));
});

test('结案只认可认领之后、同一交运链与本件的现场凭据', async (context) => {
  const app = await startPair(context);
  await app.clock('receive');
  // 认领时间被固定在 09:20；09:12 的双边事实早于认领，不能用于结案。
  await app.post('/api/facts', {
    transfer: 'T7', oldTag: 'OA-01', kind: 'return', from: 'B-ground', to: 'A-ground',
    acceptedBy: ['B-ground', 'A-ground'], at: '2026-12-04T09:12:00+08:00',
  });
  await app.post('/api/claims', { code: 'T7/OA-01', chain: 'T7', shift: 'M1', operator: 'op-1' });
  const stale = await app.post('/api/claims/resolve', { code: 'T7/OA-01', operator: 'op-1' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'no_physical_evidence');

  // 同一旅客但不同交运链/条码的事实也不能拿来给本件结案。
  await app.post('/api/facts', {
    transfer: 'T8', oldTag: 'OA-01', kind: 'return', from: 'B-ground', to: 'A-ground',
    acceptedBy: ['B-ground', 'A-ground'], at: '2026-12-04T09:30:00+08:00',
  });
  const wrongChain = await app.post('/api/claims/resolve', { code: 'T7/OA-01', operator: 'op-1' });
  assert.equal(wrongChain.status, 409);
  assert.equal((await wrongChain.json()).code, 'no_physical_evidence');

  await app.post('/api/facts', {
    transfer: 'T7', oldTag: 'OA-01', kind: 'return', from: 'B-ground', to: 'A-ground',
    acceptedBy: ['B-ground', 'A-ground'], at: '2026-12-04T09:32:00+08:00',
  });
  const resolved = await app.post('/api/claims/resolve', { code: 'T7/OA-01', operator: 'op-1' });
  assert.equal(resolved.status, 200);
});

test('双方转交要求 from 与 to 不同', async (context) => {
  const app = await startPair(context);
  await app.clock('receive');
  await app.post('/api/claims', { code: 'T7/OA-01', chain: 'T7', shift: 'M1', operator: 'op-1' });
  const same = await app.post('/api/claims/reassign', {
    code: 'T7/OA-01', operator: 'op-1', from: 'op-1', to: 'op-1', bilateral: true,
  });
  assert.equal(same.status, 400);
  assert.equal((await same.json()).code, 'same_party');
});

test('WorkbenchStore 直接调用：未注册指令报 404，模型缺失件报 404', () => {
  const store = new WorkbenchStore({});
  const model = sampleModel();
  assert.throws(() => store.claim({ code: 'T1/OA-9', chain: 'T1', shift: 'M1', operator: 'op' }, model), (error) => {
    assert.ok(error instanceof WorkbenchError);
    assert.equal(error.status, 404);
    return true;
  });
  assert.throws(() => store.release({ code: 'T1/OA-1', operator: 'op' }), (error) => {
    assert.equal(error.status, 404);
    return true;
  });
});

test('buildWorkbench 在无班次资料时不伪造班次', () => {
  const model = buildModel({ tickets: [], sorting: [], receiving: [], handover: null, manual: [] });
  const view = buildWorkbench(model, new WorkbenchStore({}));
  assert.equal(view.shift, '');
  assert.equal(view.counts.handover, 0);
  assert.match(view.carryOver.note, /没有检测到班次交接/);
});
