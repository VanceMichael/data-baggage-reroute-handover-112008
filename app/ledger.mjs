// Handover instruction ledger. This is ground-staff decision bookkeeping, not a loading order.
// An instruction is bound to one physical bag (original tag) in one acceptance chain.

import { randomUUID } from 'node:crypto';
import { normalizeTag, stableKey } from './helpers.mjs';

export const INSTRUCTION_STATE = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  CLOSED: 'closed',
  REVOKED: 'revoked',
  INVALIDATED: 'invalidated',
});

const ACTIVE_STATES = new Set([INSTRUCTION_STATE.PENDING, INSTRUCTION_STATE.CLAIMED]);
const TERMINAL_STATES = new Set([INSTRUCTION_STATE.CLOSED, INSTRUCTION_STATE.REVOKED, INSTRUCTION_STATE.INVALIDATED]);

export class LedgerError extends Error {
  constructor(message, { status = 400, code = 'ledger-error', details } = {}) {
    super(message);
    this.name = 'LedgerError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}

/**
 * A ledger is intentionally small and in-process. Every mutation is appended to `events`, so the
 * workbench can show who created, claimed, transferred or closed an instruction and on what
 * evidence it relied at that moment.
 */
export function createLedger({ now = () => new Date().toISOString() } = {}) {
  const instructions = new Map();
  const events = [];

  function record(event) {
    const entry = { id: randomUUID(), at: now(), ...event };
    events.push(entry);
    return entry;
  }

  // The physical identity of a bag is its original tag. Even if two transfer records mention
  // the same tag, only one handover instruction may be live at a time.
  function findActiveForBag(originalTag) {
    for (const instruction of instructions.values()) {
      if (!ACTIVE_STATES.has(instruction.status)) continue;
      if (instruction.originalTag === originalTag) return instruction;
    }
    return null;
  }

  function requireInstruction(id) {
    const instruction = instructions.get(id);
    if (!instruction) throw new LedgerError('找不到该交接指令', { status: 404, code: 'instruction-not-found' });
    return instruction;
  }

  function snapshotOf(bag) {
    return {
      status: bag.status,
      chain: { ...bag.chain },
      batch: bag.batch,
      newTag: bag.newTag,
      ticketState: bag.ticket?.state ?? null,
      ticketActive: bag.ticket?.active === true,
      withdrawn: bag.ticket?.withdrawn === true,
      holder: bag.holder ? { ...bag.holder } : null,
      dependsOn: bag.dependsOn.map((entry) => ({ ...entry })),
      reasons: bag.reasons.map((entry) => ({ ...entry })),
      capturedAt: now(),
    };
  }

  return {
    list() {
      return [...instructions.values()].sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return stableKey([a.transfer, a.originalTag]) < stableKey([b.transfer, b.originalTag]) ? -1 : 1;
      });
    },
    get(id) {
      return instructions.get(id) ?? null;
    },
    events() {
      return [...events];
    },
    findByBag(transfer, originalTag) {
      return this.list().filter((item) => item.transfer === transfer && item.originalTag === originalTag);
    },

    /**
     * Creates one instruction for one bag in one chain. Rejected unless the bag is currently
     * 可交接 with no hold and no other active instruction.
     */
    create({ bag, shift, operator, note, chain }) {
      if (!bag) throw new LedgerError('找不到对应行李', { status: 404, code: 'bag-not-found' });
      if (!operator || !shift) throw new LedgerError('需要班次和经办人', { code: 'operator-required' });
      if (bag.hold) {
        throw new LedgerError('该件行李的自动交接依据已暂停，不能创建交接指令', { status: 409, code: 'bag-on-hold' });
      }
      if (bag.status !== '可交接') {
        throw new LedgerError(`该件当前状态为“${bag.status}”，不能创建交接指令`, { status: 409, code: 'bag-not-ready' });
      }
      const active = findActiveForBag(bag.originalTag);
      if (active) {
        throw new LedgerError('同一件行李已有有效交接指令', {
          status: 409,
          code: 'active-instruction-exists',
          details: { instructionId: active.id },
        });
      }
      const effectiveChain = chain ?? bag.chain;
      if (chain && chain.batch && bag.chain?.batch && chain.batch !== bag.chain.batch) {
        throw new LedgerError('交接指令只能绑定本件当前的受理批次', {
          status: 409,
          code: 'chain-mismatch',
          details: { bagBatch: bag.chain.batch, requestedBatch: chain.batch },
        });
      }
      const instruction = {
        id: randomUUID(),
        transfer: bag.transfer,
        traveller: bag.traveller,
        segment: bag.segment,
        originalTag: bag.originalTag,
        newTag: bag.newTag,
        chain: { id: effectiveChain?.id ?? stableKey([bag.transfer, bag.originalTag]), batch: effectiveChain?.batch ?? bag.batch },
        status: INSTRUCTION_STATE.PENDING,
        assignee: null,
        createdBy: { shift, operator },
        note: note ?? null,
        evidence: snapshotOf(bag),
        handovers: [],
        createdAt: now(),
        updatedAt: now(),
      };
      instructions.set(instruction.id, instruction);
      record({ action: 'created', instructionId: instruction.id, by: { shift, operator }, evidence: instruction.evidence });
      return instruction;
    },

    /** Claims a pending instruction for the operator's shift. */
    claim(id, { shift, operator }) {
      const instruction = requireInstruction(id);
      if (!shift || !operator) throw new LedgerError('需要班次和经办人', { code: 'operator-required' });
      if (instruction.status !== INSTRUCTION_STATE.PENDING) {
        throw new LedgerError(`只有待认领指令可以认领，当前为 ${instruction.status}`, { status: 409, code: 'not-pending' });
      }
      instruction.status = INSTRUCTION_STATE.CLAIMED;
      instruction.assignee = { shift, operator };
      instruction.updatedAt = now();
      record({ action: 'claimed', instructionId: id, by: { shift, operator } });
      return instruction;
    },

    /**
     * Shift handover. Pending instructions move to the successor with one-sided acceptance.
     * Claimed instructions require explicit bilateral confirmation (`acceptedBy` includes both
     * the previous operator and the successor); otherwise responsibility stays with the operator.
     */
    handOver(id, { fromShift, fromOperator, toShift, toOperator, acceptedBy, note }) {
      const instruction = requireInstruction(id);
      if (!toShift || !toOperator) throw new LedgerError('需要接班班次和接班人', { code: 'successor-required' });
      if (TERMINAL_STATES.has(instruction.status)) {
        throw new LedgerError('已结束的指令不能再交接', { status: 409, code: 'instruction-terminal' });
      }
      const current = instruction.assignee ?? instruction.createdBy;
      if (instruction.status === INSTRUCTION_STATE.CLAIMED || instruction.assignee) {
        const signers = new Set(Array.isArray(acceptedBy) ? acceptedBy : []);
        const both = signers.has(current.operator) && signers.has(toOperator);
        if (!both) {
          throw new LedgerError('已认领指令的交接需要原操作人与接班人双方确认', {
            status: 409,
            code: 'bilateral-handover-required',
            details: { required: [current.operator, toOperator] },
          });
        }
      }
      const handover = {
        at: now(),
        from: { shift: current.shift ?? instruction.createdBy.shift, operator: current.operator ?? instruction.createdBy.operator },
        to: { shift: toShift, operator: toOperator },
        bilateral: Array.isArray(acceptedBy) && acceptedBy.length > 0,
        acceptedBy: Array.isArray(acceptedBy) ? [...acceptedBy] : [],
        note: note ?? null,
      };
      instruction.handovers.push(handover);
      instruction.assignee = { shift: toShift, operator: toOperator };
      if (instruction.status === INSTRUCTION_STATE.PENDING) {
        // Pending work must reach the successor but is still unclaimed until they claim it.
        instruction.pendingFor = { shift: toShift, operator: toOperator };
      }
      instruction.updatedAt = now();
      record({ action: 'handed-over', instructionId: id, handover });
      return instruction;
    },

    /** Closes an instruction only against a physical credential that exists in the evidence. */
    close(id, { basis, operator, shift, note }) {
      const instruction = requireInstruction(id);
      if (instruction.status === INSTRUCTION_STATE.CLOSED) return instruction;
      if (TERMINAL_STATES.has(instruction.status)) {
        throw new LedgerError('该指令已结束', { status: 409, code: 'instruction-terminal' });
      }
      const bag = basis?.bag;
      if (!bag) throw new LedgerError('关闭指令需要核对当前行李证据', { code: 'basis-required' });
      if (bag.hold) {
        throw new LedgerError('该件已因装机/收件冲突暂停，不能按自动依据关闭', { status: 409, code: 'bag-on-hold' });
      }
      const credential = findCredential(bag, instruction, basis);
      if (credential && credential.source === 'receiving' && bag.resolution?.type === 'return') {
        throw new LedgerError('本件已由双方确认退回原航司，不能用之前的收件记录关闭指令', {
          status: 409,
          code: 'credential-mismatch',
        });
      }
      if (!credential) {
        throw new LedgerError('没有找到与本次交运链匹配的现场凭据，不能关闭指令', {
          status: 409,
          code: 'credential-missing',
        });
      }
      instruction.status = INSTRUCTION_STATE.CLOSED;
      instruction.closedBy = { shift: shift ?? null, operator: operator ?? null, note: note ?? null };
      instruction.closedAt = now();
      instruction.closure = credential;
      instruction.updatedAt = now();
      record({ action: 'closed', instructionId: id, by: { shift, operator }, credential, note: note ?? null });
      return instruction;
    },

    revoke(id, { operator, shift, reason }) {
      const instruction = requireInstruction(id);
      if (instruction.status === INSTRUCTION_STATE.REVOKED) return instruction;
      if (instruction.status === INSTRUCTION_STATE.CLOSED) {
        throw new LedgerError('已凭现场凭据关闭的指令不能被撤销', { status: 409, code: 'instruction-closed' });
      }
      instruction.status = INSTRUCTION_STATE.REVOKED;
      instruction.revokedBy = { shift: shift ?? null, operator: operator ?? null, reason: reason ?? null };
      instruction.revokedAt = now();
      instruction.updatedAt = now();
      record({ action: 'revoked', instructionId: id, by: { shift, operator }, reason: reason ?? null });
      return instruction;
    },

    /**
     * Reconciles live evaluation against open instructions. If a bag is no longer 可交接 (for
     * example the ticket was withdrawn after the instruction was claimed), the instruction is
     * invalidated and keeps the evidence snapshot it originally relied on. It also marks pending
     * instructions created in an earlier shift so the workbench can prompt for successor handover.
     */
    reconcile(bags, { shift } = {}) {
      const byBag = new Map();
      for (const bag of bags) byBag.set(stableKey([bag.transfer, bag.originalTag]), bag);
      for (const instruction of instructions.values()) {
        if (!ACTIVE_STATES.has(instruction.status)) continue;
        if (shift && instruction.status === INSTRUCTION_STATE.PENDING) {
          const ownerShift = instruction.pendingFor?.shift ?? instruction.assignee?.shift ?? instruction.createdBy.shift;
          if (ownerShift && ownerShift !== shift && instruction.pendingFor?.shift !== shift) {
            instruction.successor = { shift, reason: '班次已交替，待认领事项须交给接班人' };
          } else if (ownerShift === shift) {
            delete instruction.successor;
          }
        }
        const bag = byBag.get(stableKey([instruction.transfer, instruction.originalTag]));
        if (!bag) continue;
        if (bag.status === '可交接' && !bag.hold) continue;
        if (bag.hold || bag.status === '必须人工处理') {
          instruction.status = INSTRUCTION_STATE.INVALIDATED;
          instruction.invalidatedAt = now();
          instruction.invalidation = {
            liveStatus: bag.status,
            hold: bag.hold,
            reasons: bag.reasons.map((entry) => entry.code),
            liveEvidence: snapshotOf(bag),
          };
          instruction.updatedAt = now();
          record({
            action: 'invalidated',
            instructionId: instruction.id,
            detail: `行李状态变为 ${bag.status}${bag.hold ? '（自动依据暂停）' : ''}`,
            evidence: instruction.invalidation.liveEvidence,
          });
        }
      }
      return instructions;
    },

    /** Retained snapshot for display even after evidence changed. */
    describe(id) {
      const instruction = instructions.get(id);
      if (!instruction) return null;
      return { ...instruction, evidence: { ...instruction.evidence, dependsOn: [...instruction.evidence.dependsOn] } };
    },
  };
}

function findCredential(bag, instruction, basis) {
  const chainBatch = instruction.chain?.batch ?? null;

  if (basis.kind === 'receiving' || basis.source === 'receiving' || (!basis.kind && basis.newTag)) {
    const rows = bag.receivingRows ?? [];
    const match = rows.find((row) => {
      if (!row.accepted) return false;
      if (basis.newTag && row.newTag !== normalizeTag(basis.newTag)) return false;
      if (basis.batch && chainBatch && row.batch !== chainBatch) return false;
      if (basis.at && row.at !== basis.at) return false;
      if (basis.signedBy && row.signedBy !== basis.signedBy) return false;
      return true;
    });
    if (!match) return null;
    return { source: 'receiving', batch: match.batch, at: match.at, signedBy: match.signedBy, newTag: match.newTag };
  }

  if (basis.kind === 'manual' || basis.source === 'manual') {
    const reports = bag.manualRows ?? [];
    const match = reports.find((report) => {
      if (basis.at && report.at !== basis.at) return false;
      const signers = new Set(report.acceptedBy ?? []);
      return signers.size >= 2;
    });
    if (!match) return null;
    return { source: 'manual', at: match.at, from: match.from, to: match.to, acceptedBy: [...match.acceptedBy] };
  }

  // Default: the latest physical credential that belongs to this acceptance chain.
  const rows = (bag.receivingRows ?? []).filter((row) => row.accepted);
  const inChain = chainBatch ? rows.filter((row) => !row.batch || row.batch === chainBatch) : rows;
  const accepted = inChain.at(-1);
  if (accepted) {
    return { source: 'receiving', batch: accepted.batch, at: accepted.at, signedBy: accepted.signedBy, newTag: accepted.newTag };
  }
  const bilateral = (bag.manualRows ?? []).filter((report) => (report.acceptedBy ?? []).length >= 2).at(-1);
  if (bilateral) return { source: 'manual', at: bilateral.at, from: bilateral.from, to: bilateral.to, acceptedBy: [...bilateral.acceptedBy] };
  return null;
}
