import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildModel, normalizeClock } from '../src/model.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const common = fixture.routes.common;

function route(step, key) {
  return (fixture.routes[step]?.[key] ?? common[key])?.body;
}

function modelAt(step, extra = {}) {
  const page1 = route(step, 'GET /sorting/S8?page=1');
  const page2 = route(step, 'GET /sorting/S8?page=2');
  return buildModel({
    tickets: route(step, 'GET /tickets/transfers'),
    sorting: [{
      id: 'S8',
      entries: [...page1.entries, ...page2.entries],
      next: page2.next,
      complete: page1.complete !== false && page2.complete !== false,
    }],
    receiving: route(step, 'GET /receiving/handoffs'),
    handover: route(step, 'GET /shifts/handover'),
    manual: route(step, 'GET /reports/manual'),
    ...extra,
  });
}

const byId = (model) => Object.fromEntries(model.pieces.map((piece) => [piece.id, piece]));

test('book 阶段：空受理页和未读完分拣页不会被当成缺件或签收', () => {
  const model = modelAt('book');
  const pieces = byId(model);
  assert.equal(pieces['T7/OA-01'].status, 'hold');
  assert.equal(pieces['T7/OA-01'].receipt, null);
  assert.ok(model.warnings.some((warning) => warning.includes('尚未到件')));
  assert.ok(model.warnings.some((warning) => warning.includes('未读完')));
});

test('receive 阶段：逐件签收可交接、拒收必须人工、已装机件单独停住', () => {
  const model = modelAt('receive');
  const pieces = byId(model);
  assert.equal(pieces['T7/OA-01'].status, 'handover');
  assert.equal(pieces['T7/OA-01'].claimable, true);
  assert.equal(pieces['T7/OA-01'].command.assignee, 'B-ground');
  assert.equal(pieces['T7/OA-01'].receipt.newTag, 'NB-19');

  assert.equal(pieces['T8/OA-03'].status, 'rejected');
  assert.equal(pieces['T8/OA-03'].bucket, 'manual');

  assert.equal(pieces['T7/OA-02'].status, 'blocked');
  assert.equal(pieces['T7/OA-02'].bucket, 'manual');
  assert.ok(pieces['T7/OA-02'].actions.some((action) => action.kind === 'stop-auto'));
  assert.equal(pieces['T7/OA-02'].contacts.loadCheck, 'ramp-east');
  // 同组其他行李仍可处理，不被 OA-02 连坐。
  assert.equal(pieces['T7/OA-01'].status, 'handover');
});

test('withdraw 阶段：撤销后不沿用原交接指令，收件凭据仍可见', () => {
  const model = modelAt('withdraw');
  const pieces = byId(model);
  assert.equal(pieces['T7/OA-01'].status, 'recovery');
  assert.equal(pieces['T7/OA-01'].claimable, false);
  assert.equal(pieces['T7/OA-01'].command, null);
  assert.equal(pieces['T7/OA-01'].receipt.newTag, 'NB-19');
  assert.ok(pieces['T7/OA-01'].commands.some((entry) => entry.kind === 'withdraw'));
  assert.ok(model.warnings.some((warning) => warning.includes('不会自动回到原航司')));

  // 补传的待交运记录（09:24 seen）不会把已收件的责任转回旧分拣点。
  const oa01 = pieces['T7/OA-01'];
  assert.equal(oa01.receipt.signedBy, 'B-ground');
  assert.equal(oa01.command, null);
});

test('correction 阶段：双边登记的退接事实恢复交接，并标记班次交接', () => {
  const model = modelAt('correction');
  const pieces = byId(model);
  assert.equal(pieces['T7/OA-01'].status, 'handover');
  assert.equal(pieces['T7/OA-01'].command.kind, 'return');
  assert.equal(pieces['T7/OA-01'].command.assignee, 'A-ground');
  assert.ok(pieces['T7/OA-01'].commands.some((entry) => entry.kind === 'return'));
  assert.equal(model.handover.shift, 'M2');
  assert.ok(model.warnings.some((warning) => warning.includes('M1 交接至 M2')));
  assert.equal(pieces['T7/OA-02'].status, 'blocked');
});

test('旧分拣点补传先前的待交运记录不会把已收件责任转回', () => {
  const model = buildModel({
    tickets: [{ traveller: 'P1', segment: 'S', old: 'A', new: 'B', transfer: 'T1', state: 'confirmed', at: '2026-12-04T09:00:00+08:00' }],
    sorting: [{
      id: 'S1',
      entries: [
        { tag: 'OA-1', traveller: 'P1', segment: 'S', state: 'awaiting-handoff', seq: 1, at: '2026-12-04T09:12:00+08:00', seen: '2026-12-04T09:24:00+08:00' },
      ],
      complete: true,
    }],
    receiving: [{ batch: 'G1', complete: true, rows: [{ transfer: 'T1', oldTag: 'OA-1', newTag: 'NB-1', accepted: true, at: '2026-12-04T09:14:00+08:00', signedBy: 'B-ground' }] }],
    handover: { shift: 'M1', teams: {} },
    manual: [],
  });
  const piece = model.pieces[0];
  // 收件已发生，旧分拣点的补传只是资料；可交接的接手指向新航司，而不是旧分拣点。
  assert.equal(piece.status, 'handover');
  assert.equal(piece.command.assignee, 'B-ground');
  assert.ok(piece.commands.some((entry) => entry.kind === 'stale-handoff'));
});

test('新票标签不会覆盖已动作的行李原标签', () => {
  const model = buildModel({
    tickets: [{
      traveller: 'P17',
      segment: 'A911-1204',
      old: 'XA911',
      new: 'XB303',
      transfer: 'T7',
      state: 'confirmed',
      at: '2026-12-04T09:04:00+08:00',
    }],
    sorting: [{
      id: 'S8',
      entries: [
        { tag: 'OA-01', traveller: 'P17', segment: 'A911-1204', state: 'in-sort', seq: 1, at: '2026-12-04T09:06:00+08:00' },
      ],
      complete: true,
    }],
    receiving: [],
    handover: null,
    manual: [],
  });
  assert.deepEqual(model.pieces.map((piece) => piece.tag), ['OA-01']);
  assert.equal(model.pieces[0].ticket.new, 'XB303');
});

test('跨页重传扫描只计一次现场动作，seen 只表示资料到达', () => {
  const model = buildModel({
    tickets: [],
    sorting: [
      {
        id: 'S8',
        entries: [{ tag: 'OA-09', traveller: 'P20', segment: 'A1', state: 'in-sort', seq: 2, at: '2026-12-04T09:06:00+08:00' }],
        complete: true,
      },
      {
        id: 'S8',
        entries: [{ tag: 'OA-09', traveller: 'P20', segment: 'A1', state: 'in-sort', seq: 2, at: '2026-12-04T09:06:00+08:00', seen: '2026-12-04T09:24:00+08:00' }],
        complete: true,
      },
    ],
    receiving: [],
    handover: null,
    manual: [],
  });
  const piece = model.pieces.find((item) => item.tag === 'OA-09');
  assert.equal(piece.scans.length, 1);
  assert.equal(piece.scans[0].duplicate, true);
  assert.equal(piece.scans[0].seen, '2026-12-04T09:24:00+08:00');
  assert.equal(piece.status, 'hold');
  assert.match(piece.reason, /重传/);
});

test('同一受理页重复行合并，签收与拒收冲突会被标出', () => {
  const model = buildModel({
    tickets: [{ traveller: 'P1', segment: 'S', old: 'A', new: 'B', transfer: 'T1', state: 'confirmed', at: '2026-12-04T08:00:00+08:00' }],
    sorting: [{ id: 'S1', entries: [{ tag: 'OA-1', traveller: 'P1', segment: 'S', state: 'transfer', seq: 1, at: '2026-12-04T08:10:00+08:00' }], complete: true }],
    receiving: [{
      batch: 'G1',
      complete: true,
      rows: [
        { transfer: 'T1', oldTag: 'OA-1', newTag: 'NB-1', accepted: true, at: '2026-12-04T08:20:00+08:00', signedBy: 'B' },
        { transfer: 'T1', oldTag: 'OA-1', newTag: null, accepted: false, at: '2026-12-04T08:21:00+08:00', signedBy: 'B' },
      ],
    }],
    handover: null,
    manual: [],
  });
  const piece = model.pieces[0];
  assert.equal(piece.receipt.duplicates, 1);
  assert.equal(piece.receipt.conflict, true);
  assert.equal(piece.receipt.newTag, 'NB-1');
  assert.ok(model.warnings.some((warning) => warning.includes('冲突')));
});

test('空而完整的受理页与未到件空页给出不同提示', () => {
  const model = buildModel({
    tickets: [],
    sorting: [],
    receiving: [
      { batch: 'G1', complete: true, rows: [] },
      { batch: 'G2', complete: false, rows: [] },
    ],
    handover: null,
    manual: [],
  });
  const batch1 = model.batches.find((batch) => batch.batch === 'G1');
  const batch2 = model.batches.find((batch) => batch.batch === 'G2');
  assert.equal(batch1.emptyComplete, true);
  assert.equal(batch2.awaiting, true);
  assert.ok(model.warnings.some((warning) => warning.includes('完整但为空')));
  assert.ok(model.warnings.some((warning) => warning.includes('尚未到件')));
});

test('不能凭航班号或同姓合并：航段不同的同旅客资料保持未关联', () => {
  const model = buildModel({
    tickets: [{ traveller: 'P9', segment: 'SEG-B', old: 'A', new: 'B', transfer: 'T9', state: 'confirmed', at: '2026-12-04T08:00:00+08:00' }],
    sorting: [
      { id: 'S1', entries: [{ tag: 'OA-9', traveller: 'P9', segment: 'SEG-A', state: 'in-sort', seq: 1, at: '2026-12-04T08:05:00+08:00' }], complete: true },
      { id: 'S2', entries: [{ tag: 'OA-9', traveller: 'P9', segment: 'SEG-B', state: 'in-sort', seq: 1, at: '2026-12-04T08:06:00+08:00' }], complete: true },
    ],
    receiving: [],
    handover: null,
    manual: [],
  });
  // 同一原标签被两个航段引用，不能靠航班号自动归并，保持未关联并提示。
  assert.equal(model.pieces.length, 1);
  assert.equal(model.pieces[0].chain, '');
  assert.ok(model.warnings.some((warning) => warning.includes('多个航段')));
});

test('时间语义：不同来源的采集时间不做全局排序，仅时刻不足以判定先后', () => {
  assert.equal(normalizeClock('09:14').comparable, false);
  assert.equal(normalizeClock('2026-12-04T09:14:00+08:00').comparable, true);
  const model = buildModel({
    tickets: [{ traveller: 'P1', segment: 'S', transfer: 'T1', state: 'confirmed', old: 'A', new: 'B', at: '2026-12-04T09:04:00+08:00', seen: '2026-12-04T12:00:00+08:00' }],
    sorting: [{ id: 'S1', entries: [{ tag: 'OA-1', traveller: 'P1', segment: 'S', state: 'transfer', seq: 1, at: '2026-12-04T09:12:00+08:00', seen: '2026-12-04T09:24:00+08:00' }], complete: true }],
    receiving: [{ batch: 'G1', complete: true, rows: [{ transfer: 'T1', oldTag: 'OA-1', newTag: 'NB-1', accepted: true, at: '2026-12-04T09:14:00+08:00', signedBy: 'B' }] }],
    handover: null,
    manual: [],
  });
  const piece = model.pieces[0];
  assert.equal(piece.status, 'handover');
  // 扫描按现场动作时间，而不是较晚的采集时间。
  assert.deepEqual(piece.scans.map((scan) => scan.at), ['2026-12-04T09:12:00+08:00']);
});
