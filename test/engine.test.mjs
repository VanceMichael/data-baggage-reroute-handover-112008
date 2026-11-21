import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEvidence } from '../app/evidence.mjs';
import { evaluateEvidence } from '../app/evaluate.mjs';
import { createLedger, LedgerError } from '../app/ledger.mjs';
import { createConfirmations, ConfirmationError, asManualRows } from '../app/confirmations.mjs';

function collect({ tickets = [], sorting = [], receiving = [], manual = [], shifts = [] }) {
  const ticketsSource = { available: true, records: tickets, problem: null };
  const sortingSource = {
    entries: sorting.map((entry, index) => ({ batch: 'S8', seq: entry.seq ?? index, ...entry })),
    problems: [],
  };
  const receivingRows = receiving.map((row) => ({ batch: 'G6', ...row }));
  const receivingSource = {
    available: true,
    empty: receivingRows.length === 0,
    batches: [{ batch: 'G6', complete: receivingRows.length > 0, empty: receivingRows.length === 0, rows: receivingRows }],
    rows: receivingRows,
    batch: 'G6',
    complete: receivingRows.length > 0,
    problem: null,
  };
  const shiftsSource = { available: true, shifts: shifts.length ? shifts : [{ shift: 'M1', teams: { XA1: 'A-ground', XB2: 'B-ground', 'load-check': 'ramp-east' } }] };
  const manualSource = { available: true, reports: manual };
  const evidence = buildEvidence({ tickets: ticketsSource, sorting: sortingSource, receiving: receivingSource, manual: manualSource, shifts: shiftsSource });
  return evaluateEvidence({
    evidence,
    receiving: receivingSource,
    tickets: ticketsSource,
    sortingProblems: sortingSource.problems,
  });
}

const baseTicket = {
  traveller: 'P1',
  segment: 'A1-1',
  old: 'XA1',
  new: 'XB2',
  transfer: 'T1',
  state: 'confirmed',
  at: '2026-12-04T08:00:00+08:00',
};

const bagOf = (result, tag) => result.bags.find((bag) => bag.originalTag === tag);

test('a loaded bag is held alone and does not block its siblings', () => {
  const result = collect({
    tickets: [baseTicket],
    sorting: [
      { tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'in-sort', at: '2026-12-04T08:05:00+08:00' },
      { tag: 'B2', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'loaded', at: '2026-12-04T08:20:00+08:00' },
      { tag: 'B3', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T08:15:00+08:00' },
    ],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T08:10:00+08:00', signedBy: 'B-ground' }],
  });

  assert.equal(bagOf(result, 'B1').status, '可交接');
  const held = bagOf(result, 'B2');
  assert.equal(held.status, '必须人工处理');
  assert.equal(held.hold, true);
  assert.ok(held.reasons.some((entry) => entry.code === 'loaded-without-acceptance'));
  assert.ok(held.nextContacts.some((contact) => contact.role === '停机坪/装载核对'));
  assert.equal(bagOf(result, 'B3').hold, false);
});

test('late awaiting-handoff backfill cannot move custody back after acceptance', () => {
  const result = collect({
    tickets: [baseTicket],
    sorting: [
      { tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T10:00:00+08:00', seen: '2026-12-04T10:30:00+08:00' },
      { tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00', seen: '2026-12-04T10:30:00+08:00', seq: 1 },
    ],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T10:00:00+08:00', signedBy: 'B-ground' }],
  });
  const bag = bagOf(result, 'B1');
  assert.equal(bag.status, '可交接');
  assert.equal(bag.newTag, 'N1');
  assert.ok(bag.observations.some((entry) => entry.code === 'late-backfill-ignored'));
});

test('a withdrawal after acceptance keeps custody with the new carrier until a bilateral report', () => {
  const result = collect({
    tickets: [
      baseTicket,
      { transfer: 'T1', traveller: 'P1', segment: 'A1-1', state: 'withdrawn', at: '2026-12-04T11:00:00+08:00' },
    ],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:30:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T10:00:00+08:00', signedBy: 'B-ground' }],
  });
  const bag = bagOf(result, 'B1');
  assert.equal(bag.status, '必须人工处理');
  assert.equal(bag.holder.side, 'new');
  assert.ok(bag.reasons.some((entry) => entry.code === 'withdrawn-after-acceptance'));
  assert.ok(bag.nextContacts.some((contact) => contact.team === 'B-ground'));
  assert.ok(bag.nextContacts.some((contact) => contact.team === 'A-ground'));
});

test('bilateral return report closes the withdrawal without discarding the new tag', () => {
  const result = collect({
    tickets: [
      baseTicket,
      { transfer: 'T1', traveller: 'P1', segment: 'A1-1', state: 'withdrawn', at: '2026-12-04T11:00:00+08:00' },
    ],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:30:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T10:00:00+08:00', signedBy: 'B-ground' }],
    manual: [{ transfer: 'T1', originalTag: 'B1', from: 'B-ground', to: 'A-ground', type: 'return', acceptedBy: ['B-ground', 'A-ground'], at: '2026-12-04T11:10:00+08:00' }],
  });
  const bag = bagOf(result, 'B1');
  assert.equal(bag.status, '可交接');
  assert.equal(bag.closed, true);
  assert.equal(bag.holder.side, 'old');
  assert.equal(bag.holder.team, 'A-ground');
  assert.equal(bag.newTag, 'N1');
});

test('rejection, empty receiving batch and omitted row are distinct', () => {
  const rejected = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: null, accepted: false, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' }],
  });
  assert.equal(bagOf(rejected, 'B1').status, '待确认');
  assert.ok(bagOf(rejected, 'B1').reasons.some((entry) => entry.code === 'receiving-rejected'));
  assert.equal(bagOf(rejected, 'B1').holder.side, 'old');

  const omitted = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'OTHER', newTag: 'N9', accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' }],
  });
  assert.ok(bagOf(omitted, 'B1').reasons.some((entry) => entry.code === 'receiving-omitted'));

  const empty = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [],
  });
  assert.ok(bagOf(empty, 'B1').reasons.some((entry) => entry.code === 'receiving-not-started'));
});

test('new tags never overwrite the original tag used to find a bag', () => {
  const result = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' }],
  });
  assert.equal(result.bags.length, 1);
  assert.equal(result.bags[0].originalTag, 'B1');
  assert.equal(result.bags[0].newTag, 'N1');
});

test('travellers on one segment are not merged by flight alone', () => {
  const result = collect({
    tickets: [
      baseTicket,
      { ...baseTicket, traveller: 'P2', transfer: 'T2', new: 'XB9', at: '2026-12-04T08:01:00+08:00' },
    ],
    sorting: [
      { tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' },
      { tag: 'B2', traveller: 'P2', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:01:00+08:00' },
    ],
  });
  assert.equal(result.travellers.length, 2);
  assert.equal(bagOf(result, 'B1').transfer, 'T1');
  assert.equal(bagOf(result, 'B2').transfer, 'T2');
});

test('a repeated scan is recorded as a re-scan, not as a second physical action', () => {
  const scan = { tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'in-sort', at: '2026-12-04T08:05:00+08:00', seq: 2 };
  const result = collect({
    tickets: [baseTicket],
    sorting: [scan, { ...scan, seen: '2026-12-04T08:06:00+08:00' }],
  });
  const bag = bagOf(result, 'B1');
  assert.equal(bag.sortingRows.length, 1);
  assert.equal(bag.rescans.length, 1);
});

test('ledger enforces one active instruction per bag and bilateral handover for claimed work', () => {
  const result = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' }],
  });
  const bag = bagOf(result, 'B1');
  let tick = 0;
  const ledger = createLedger({ now: () => `2026-12-04T12:00:0${tick++}Z` });
  const instruction = ledger.create({ bag, shift: 'M1', operator: 'alice' });
  assert.equal(instruction.status, 'pending');

  assert.throws(
    () => ledger.create({ bag, shift: 'M1', operator: 'alice' }),
    (error) => error instanceof LedgerError && error.code === 'active-instruction-exists',
  );

  ledger.claim(instruction.id, { shift: 'M1', operator: 'alice' });
  assert.throws(
    () => ledger.handOver(instruction.id, { toShift: 'M2', toOperator: 'bob' }),
    (error) => error.code === 'bilateral-handover-required',
  );
  const handed = ledger.handOver(instruction.id, { toShift: 'M2', toOperator: 'bob', acceptedBy: ['alice', 'bob'] });
  assert.deepEqual(handed.assignee, { shift: 'M2', operator: 'bob' });

  const closed = ledger.close(instruction.id, { basis: { kind: 'receiving', bag }, operator: 'bob', shift: 'M2' });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closure.source, 'receiving');
});

test('pending instructions move to the successor shift without needing bilateral signatures', () => {
  const result = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' }],
  });
  const ledger = createLedger();
  const instruction = ledger.create({ bag: bagOf(result, 'B1'), shift: 'M1', operator: 'alice' });
  const handed = ledger.handOver(instruction.id, { toShift: 'M2', toOperator: 'bob' });
  assert.equal(handed.status, 'pending');
  assert.deepEqual(handed.pendingFor, { shift: 'M2', operator: 'bob' });
});

test('reconcile invalidates an instruction when its bag is later held', () => {
  const ready = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' }],
  });
  const ledger = createLedger();
  const instruction = ledger.create({ bag: bagOf(ready, 'B1'), shift: 'M1', operator: 'alice' });

  const held = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'loaded', at: '2026-12-04T11:00:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' }],
  });
  ledger.reconcile(held.bags);
  const after = ledger.get(instruction.id);
  assert.equal(after.status, 'invalidated');
  assert.ok(after.invalidation.reasons.includes('loaded-after-acceptance'));
  // The evidence snapshot survives the change.
  assert.equal(after.evidence.newTag, 'N1');
});

test('ledger refuses to create instructions for held or non-ready bags', () => {
  const result = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'loaded', at: '2026-12-04T11:00:00+08:00' }],
  });
  const ledger = createLedger();
  assert.throws(
    () => ledger.create({ bag: bagOf(result, 'B1'), shift: 'M1', operator: 'alice' }),
    (error) => error.code === 'bag-on-hold',
  );
});

test('only one live instruction may exist per original tag even across transfers', () => {
  const result = collect({
    tickets: [
      baseTicket,
      { ...baseTicket, traveller: 'P2', transfer: 'T2', new: 'XB9', at: '2026-12-04T08:01:00+08:00' },
    ],
    sorting: [
      { tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' },
      { tag: 'B1', traveller: 'P2', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:01:00+08:00', seq: 2 },
    ],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' }],
  });
  // Ambiguous tag attribution means no bag is invented; nothing can be claimed.
  const ledger = createLedger();
  const bag = result.bags.find((item) => item.originalTag === 'B1' && item.transfer === 'T1');
  assert.ok(bag);
  ledger.create({ bag, shift: 'M1', operator: 'alice' });
  assert.throws(
    () => ledger.create({ bag: { ...bag, transfer: 'T2' }, shift: 'M1', operator: 'alice' }),
    (error) => error.code === 'active-instruction-exists',
  );
});

test('a pending instruction from an earlier shift is flagged for successor handling', () => {
  const result = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' }],
    shifts: [
      { shift: 'M1', teams: { XA1: 'A-ground', XB2: 'B-ground' } },
      { shift: 'M2', replaces: 'M1', at: '2026-12-04T09:40:00+08:00', teams: { XA1: 'A-ground-2', XB2: 'B-ground-2' } },
    ],
  });
  const ledger = createLedger();
  const instruction = ledger.create({ bag: bagOf(result, 'B1'), shift: 'M1', operator: 'alice' });
  ledger.reconcile(result.bags, { shift: 'M2' });
  const after = ledger.get(instruction.id);
  assert.equal(after.status, 'pending');
  assert.equal(after.successor.shift, 'M2');
});

test('locally registered bilateral facts require both sides and resolve the withdrawal', () => {
  const confirmations = createConfirmations();
  const result = collect({
    tickets: [
      baseTicket,
      { transfer: 'T1', traveller: 'P1', segment: 'A1-1', state: 'withdrawn', at: '2026-12-04T11:00:00+08:00' },
    ],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:30:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T10:00:00+08:00', signedBy: 'B-ground' }],
  });
  const bag = bagOf(result, 'B1');
  assert.throws(
    () => confirmations.register(
      { type: 'return', from: 'B-ground', to: 'A-ground', acceptedBy: ['B-ground'], operator: 'wing' },
      { bag },
    ),
    (error) => error instanceof ConfirmationError && error.code === 'bilateral-required',
  );
  confirmations.register(
    { type: 'return', from: 'B-ground', to: 'A-ground', acceptedBy: ['B-ground', 'A-ground'], operator: 'wing' },
    { bag },
  );
  const rows = asManualRows(confirmations.list());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].local, true);
});

test('closing a returned bag with the earlier receiving row is rejected', () => {
  const result = collect({
    tickets: [
      baseTicket,
      { transfer: 'T1', traveller: 'P1', segment: 'A1-1', state: 'withdrawn', at: '2026-12-04T11:00:00+08:00' },
    ],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:30:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T10:00:00+08:00', signedBy: 'B-ground' }],
    manual: [{ transfer: 'T1', originalTag: 'B1', from: 'B-ground', to: 'A-ground', type: 'return', acceptedBy: ['B-ground', 'A-ground'], at: '2026-12-04T11:10:00+08:00' }],
  });
  const ledger = createLedger();
  const instruction = ledger.create({ bag: bagOf(result, 'B1'), shift: 'M1', operator: 'alice' });
  assert.throws(
    () => ledger.close(instruction.id, { basis: { kind: 'receiving', bag: bagOf(result, 'B1') }, operator: 'alice', shift: 'M1' }),
    (error) => error.code === 'credential-mismatch',
  );
  const closed = ledger.close(instruction.id, { basis: { kind: 'manual', bag: bagOf(result, 'B1') }, operator: 'alice', shift: 'M1' });
  assert.equal(closed.closure.source, 'manual');
});

test('an instruction cannot bind to a different acceptance batch', () => {
  const result = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' }],
  });
  const ledger = createLedger();
  assert.throws(
    () => ledger.create({ bag: bagOf(result, 'B1'), shift: 'M1', operator: 'alice', chain: { batch: 'GX' } }),
    (error) => error.code === 'chain-mismatch',
  );
});

test('a later rejection supersedes an earlier receipt and acceptance without new tag still counts', () => {
  const receiptNoTag = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: null, accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' }],
  });
  assert.equal(bagOf(receiptNoTag, 'B1').status, '可交接');
  assert.equal(bagOf(receiptNoTag, 'B1').holder.side, 'new');
  assert.ok(bagOf(receiptNoTag, 'B1').gaps.some((entry) => entry.code === 'new-tag-missing'));

  const laterRejection = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [
      { transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' },
      { transfer: 'T1', oldTag: 'B1', newTag: null, accepted: false, at: '2026-12-04T09:40:00+08:00', signedBy: 'B-ground' },
    ],
  });
  const bag = bagOf(laterRejection, 'B1');
  assert.equal(bag.status, '待确认');
  assert.equal(bag.holder.side, 'old');
  assert.ok(bag.reasons.some((entry) => entry.code === 'rejected-after-acceptance'));
});

test('a receiving page sitting on another batch is not treated as an empty batch', () => {
  const ticketsSource = { available: true, records: [baseTicket], problem: null };
  const evidence = buildEvidence({
    tickets: ticketsSource,
    sorting: { entries: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00', batch: 'S8' }], problems: [] },
    receiving: {
      available: true,
      empty: false,
      batches: [{
        batch: 'G6',
        complete: false,
        empty: false,
        rows: [{ transfer: 'T1', oldTag: 'B1', newTag: null, accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground', batch: 'G6' }],
      }],
      rows: [{ transfer: 'T1', oldTag: 'B1', newTag: null, accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground', batch: 'G6' }],
      batch: 'G6',
      complete: false,
    },
    manual: { available: true, reports: [] },
    shifts: { available: true, shifts: [{ shift: 'M1', teams: { XA1: 'A-ground', XB2: 'B-ground' } }] },
  });
  // The bag belongs to G6, but the page now shows only G7. That is a batch mismatch.
  const receiving = {
    available: true,
    empty: false,
    batches: [{ batch: 'G7', complete: true, empty: false, rows: [{ transfer: 'TZ', oldTag: 'BZ', newTag: 'NZ', accepted: true, at: '2026-12-04T09:00:00+08:00', batch: 'G7' }] }],
    rows: [],
    batch: 'G7',
    complete: true,
  };
  const result = evaluateEvidence({ evidence, receiving, tickets: ticketsSource, sortingProblems: [] });
  const bag = bagOf(result, 'B1');
  assert.equal(bag.batch, 'G6');
  // The earlier receipt still stands; the missing page is a gap, not a status change.
  assert.equal(bag.holder.side, 'new');
  assert.ok(!bag.reasons.some((entry) => entry.code === 'receiving-empty-complete'));
});

test('a receiving page that omits the bag from a completed batch is待确认', () => {
  const result = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'OTHER', newTag: 'N9', accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' }],
  });
  const bag = bagOf(result, 'B1');
  assert.equal(bag.status, '待确认');
  assert.ok(bag.reasons.some((entry) => entry.code === 'receiving-omitted'));
  assert.ok(!bag.reasons.some((entry) => entry.code === 'receiving-empty-complete'));
});

test('an unrecognized ticket state with a receipt is待确认, not ready', () => {
  const result = collect({
    tickets: [{ ...baseTicket, state: 'pending-review' }],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'B-ground' }],
  });
  const bag = bagOf(result, 'B1');
  assert.equal(bag.status, '待确认');
  assert.ok(bag.reasons.some((entry) => entry.code === 'ticket-state-unrecognized'));
});

test('a bag rejected in one batch and received in a later batch keeps both chains', () => {
  const ticketsSource = { available: true, records: [baseTicket], problem: null };
  const rows = [
    { batch: 'G6', transfer: 'T1', oldTag: 'B1', newTag: null, accepted: false, at: '2026-12-04T09:20:00+08:00', signedBy: 'B-ground' },
    { batch: 'G7', transfer: 'T1', oldTag: 'B1', newTag: 'N2', accepted: true, at: '2026-12-04T10:00:00+08:00', signedBy: 'B-ground' },
  ];
  const evidence = buildEvidence({
    tickets: ticketsSource,
    sorting: { entries: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00', batch: 'S8' }], problems: [] },
    receiving: { available: true, empty: false, batches: [{ batch: 'G7', complete: true, empty: false, rows }], rows, batch: 'G7', complete: true },
    manual: { available: true, reports: [] },
    shifts: { available: true, shifts: [{ shift: 'M1', teams: { XA1: 'A-ground', XB2: 'B-ground' } }] },
  });
  const result = evaluateEvidence({ evidence, receiving: { available: true, empty: false, batches: [], rows, complete: true }, tickets: ticketsSource });
  const bag = bagOf(result, 'B1');
  assert.equal(bag.status, '可交接');
  assert.equal(bag.chain.batch, 'G7');
  assert.deepEqual(bag.chains.map((chain) => [chain.batch, chain.status]), [['G6', 'rejected'], ['G7', 'accepted']]);
});

test('a READY bag with a signer that does not match any shift team reopens as待确认', () => {
  const result = collect({
    tickets: [baseTicket],
    sorting: [{ tag: 'B1', traveller: 'P1', segment: 'A1-1', facility: 'east', state: 'awaiting-handoff', at: '2026-12-04T09:00:00+08:00' }],
    receiving: [{ transfer: 'T1', oldTag: 'B1', newTag: 'N1', accepted: true, at: '2026-12-04T09:30:00+08:00', signedBy: 'someone-else' }],
  });
  const bag = bagOf(result, 'B1');
  assert.equal(bag.status, '待确认');
  assert.equal(bag.closed, false);
  assert.ok(bag.reasons.some((entry) => entry.code === 'signer-team-mismatch'));
  assert.ok(bag.nextContacts.some((contact) => contact.role === '新航司受理台'));
});
