/**
 * 班次认领与双边事实登记。
 *
 * 约定：
 * - 交接指令以“班次 + 交运链”认领；同一件行李同一时刻只保留一个有效认领。
 * - 已认领的指令跟随原操作人，直到出现现场凭据（登记双边事实）或经双方转交。
 * - 班次交接后，未认领事项明确列出，交给接班人；不自动改写已认领事项的操作人。
 * - 本模块只登记“退接/转交”这类双边确认事实，不替行李设备下达装机命令。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compareClock, normalizeClock, normalizeText } from './model.mjs';

export class WorkbenchError extends Error {
  constructor(message, status = 400, code = 'workbench_error') {
    super(message);
    this.name = 'WorkbenchError';
    this.status = status;
    this.code = code;
  }
}

const FACT_KINDS = new Set(['return', 'handover', 'transfer']);

const required = (value, label) => {
  const text = normalizeText(value);
  if (!text) throw new WorkbenchError(`${label} 不能为空`, 400, 'invalid_input');
  return text;
};

function nowIso(now) {
  return typeof now === 'function' ? now() : new Date().toISOString();
}

function factTime(fact) {
  const at = normalizeClock(fact.at);
  if (at.comparable) return at;
  // 现场动作时间缺失时，退回到资料到达时间；两者都没有就不算“认领后的凭据”。
  return normalizeClock(fact.seen);
}

function atOrAfter(fact, claim) {
  const a = factTime(fact);
  const b = normalizeClock(claim.claimedAt);
  if (!a.comparable || !b.comparable) return false;
  return compareClock(a, b) >= 0;
}

export class WorkbenchStore {
  constructor({ statePath = null, now = () => new Date().toISOString() } = {}) {
    this.statePath = statePath;
    this.now = now;
    this.claims = new Map();
    this.factList = [];
    if (statePath) this.load();
  }

  load() {
    try {
      const raw = readFileSync(this.statePath, 'utf8');
      const state = JSON.parse(raw);
      for (const claim of Array.isArray(state.claims) ? state.claims : []) {
        if (claim?.code) this.claims.set(claim.code, claim);
      }
      this.factList = Array.isArray(state.facts) ? state.facts : [];
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new WorkbenchError(`无法读取工作台状态 ${this.statePath}: ${error.message}`, 500, 'state_unreadable');
    }
  }

  persist() {
    if (!this.statePath) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, claims: [...this.claims.values()], facts: this.factList }, null, 2));
    renameSync(tmp, this.statePath);
  }

  facts() {
    return this.factList.map((fact) => ({ ...fact }));
  }

  /** 来源端 reports/manual 形状，供模型统一判定。 */
  manualReports() {
    return this.factList.map((fact) => ({
      transfer: fact.transfer,
      originalTag: fact.oldTag,
      from: fact.from,
      to: fact.to,
      type: fact.kind,
      acceptedBy: [...fact.acceptedBy],
      at: fact.at,
      seen: fact.seen,
      source: 'workbench',
    }));
  }

  findClaim(code) {
    return this.claims.get(normalizeText(code)) ?? null;
  }

  activeClaim(code) {
    const claim = this.findClaim(code);
    return claim && claim.status === 'claimed' ? claim : null;
  }

  requireClaim(code) {
    const claim = this.findClaim(code);
    if (!claim) throw new WorkbenchError('没有找到该件行李的认领记录', 404, 'claim_missing');
    if (claim.status !== 'claimed') throw new WorkbenchError(`该认领已处于 ${claim.status} 状态，不能再操作`, 409, 'claim_not_active');
    return claim;
  }

  requirePiece(model, code) {
    const piece = model.pieces.find((item) => item.id === normalizeText(code));
    if (!piece) throw new WorkbenchError('当前资料里没有这件行李', 404, 'piece_missing');
    return piece;
  }

  /** 认领：必须来自当前班次、对应交运链，且该件当前处于“可交接”。 */
  claim(input, model) {
    const code = required(input.code, '指令编号');
    const operator = required(input.operator, '经办人');
    const shift = required(input.shift, '班次');
    const chain = required(input.chain ?? input.transfer, '交运链');
    const piece = this.requirePiece(model, code);
    if (model.handover?.shift && shift !== model.handover.shift) {
      throw new WorkbenchError(`班次已交接：当前为 ${model.handover.shift}，${shift} 不能认领`, 409, 'shift_mismatch');
    }
    if (piece.chain && chain !== piece.chain) {
      throw new WorkbenchError(`交运链不匹配：该件属于 ${piece.chain}，不是 ${chain}`, 409, 'chain_mismatch');
    }
    if (piece.status !== 'handover' || !piece.command) {
      throw new WorkbenchError(`本件当前为“${piece.statusLabel}”，没有可认领的交接指令：${piece.reason}`, 409, 'not_claimable');
    }
    const current = this.activeClaim(code);
    if (current) {
      if (current.operator === operator) return { claim: current, created: false };
      throw new WorkbenchError(`该指令已由 ${current.shift}/${current.operator} 认领；请由原操作人释放或双方转交`, 409, 'already_claimed');
    }
    const at = nowIso(this.now);
    const claim = {
      code,
      chain: piece.chain,
      piece: piece.tag,
      traveller: piece.traveller,
      segment: piece.segment,
      shift,
      operator,
      claimedAt: at,
      status: 'claimed',
      command: piece.command,
      reliedOn: {
        ticket: piece.ticket,
        pass: piece.pass,
        receipt: piece.receipt,
        evidence: piece.evidence.items,
      },
      history: [{ action: 'claim', at, operator, shift, chain: piece.chain }],
    };
    this.claims.set(code, claim);
    this.persist();
    return { claim, created: true };
  }

  release(input) {
    const code = required(input.code, '指令编号');
    const operator = required(input.operator, '经办人');
    const claim = this.requireClaim(code);
    if (claim.operator !== operator) {
      throw new WorkbenchError(`只有原认领人 ${claim.operator} 可以释放，或改用双方转交`, 409, 'not_owner');
    }
    const at = nowIso(this.now);
    claim.status = 'released';
    claim.releasedAt = at;
    claim.history.push({ action: 'release', at, operator, shift: normalizeText(input.shift), note: normalizeText(input.note) });
    this.persist();
    return { claim };
  }

  /** 双方转交：需两边都在 acceptedBy 里，或显式 bilateral=true 并给出双方。 */
  reassign(input) {
    const code = required(input.code, '指令编号');
    const operator = required(input.operator, '经办人');
    const from = required(input.from, '转出人');
    const to = required(input.to, '转交人');
    const claim = this.requireClaim(code);
    if (claim.operator !== from) {
      throw new WorkbenchError(`转出人 ${from} 不是当前认领人 ${claim.operator}`, 409, 'not_owner');
    }
    if (from === to) {
      throw new WorkbenchError('转出人与转交人不能相同', 400, 'same_party');
    }
    const acceptedBy = Array.isArray(input.acceptedBy) ? input.acceptedBy.map(normalizeText).filter(Boolean) : [];
    const bilateral = input.bilateral === true && input.acceptedBy === undefined
      ? [from, to]
      : acceptedBy;
    if (!bilateral.includes(from) || !bilateral.includes(to)) {
      throw new WorkbenchError('双方转交需要 from 与 to 都在 acceptedBy 中确认', 409, 'not_bilateral');
    }
    const at = nowIso(this.now);
    claim.operator = to;
    claim.shift = normalizeText(input.shift) || claim.shift;
    claim.reassignedAt = at;
    claim.history.push({ action: 'reassign', at, operator, from, to, shift: claim.shift, note: normalizeText(input.note) });
    this.persist();
    return { claim };
  }

  /**
   * 结案：只有出现现场凭据（该件在认领之后登记的双边事实）才能结案；
   * 光有票务或电话确认不算。
   */
  resolve(input, model) {
    const code = required(input.code, '指令编号');
    const operator = required(input.operator, '经办人');
    const claim = this.requireClaim(code);
    if (claim.operator !== operator) {
      throw new WorkbenchError(`只有原认领人 ${claim.operator} 可以结案，或先双方转交`, 409, 'not_owner');
    }
    const piece = this.requirePiece(model, code);
    const evidence = (piece.facts ?? []).filter((fact) =>
      atOrAfter(fact, claim) && fact.transfer === claim.chain && fact.oldTag === claim.piece);
    if (!evidence.length) {
      throw new WorkbenchError('还没有认领之后登记、且属于同一交运链与本件的现场凭据，不能结案', 409, 'no_physical_evidence');
    }
    const at = nowIso(this.now);
    claim.status = 'resolved';
    claim.resolvedAt = at;
    claim.resolvedBy = evidence.at(-1);
    claim.history.push({ action: 'resolve', at, operator, evidence: claim.resolvedBy });
    this.persist();
    return { claim };
  }

  /**
   * 登记双边确认的退接/转交事实。它只描述现场已经发生的事实，
   * 不是装机/卸机命令；工作台据此重算可交接状态。
   */
  registerFact(input, { operator, shift } = {}) {
    const transfer = required(input.transfer ?? input.chain, '交运链');
    const oldTag = required(input.oldTag ?? input.originalTag, '原条码');
    const kind = normalizeText(input.kind ?? input.type).toLowerCase();
    if (!FACT_KINDS.has(kind)) throw new WorkbenchError('事实类型只能是 return / handover / transfer', 400, 'invalid_kind');
    const from = required(input.from, '交出方');
    const to = required(input.to, '接收方');
    if (from === to) throw new WorkbenchError('交出方与接收方不能相同', 400, 'same_party');
    const acceptedBy = Array.isArray(input.acceptedBy) ? input.acceptedBy.map(normalizeText).filter(Boolean) : [];
    if (!acceptedBy.includes(from) || !acceptedBy.includes(to)) {
      throw new WorkbenchError('地服双边事实需要交出方与接收方都在 acceptedBy 中', 409, 'not_bilateral');
    }
    const at = normalizeText(input.at) || nowIso(this.now);
    if (!normalizeClock(at).comparable) {
      throw new WorkbenchError('现场动作时间需要完整日期与时间，或留空由工作台取当前时间', 400, 'invalid_time');
    }
    const duplicate = this.factList.find((fact) => fact.transfer === transfer && fact.oldTag === oldTag && fact.kind === kind && fact.at === at);
    if (duplicate) return { fact: { ...duplicate }, created: false };
    const fact = {
      transfer,
      oldTag,
      kind,
      from,
      to,
      acceptedBy: [...new Set(acceptedBy)],
      at,
      seen: nowIso(this.now),
      operator: normalizeText(operator),
      shift: normalizeText(shift),
      source: 'workbench',
    };
    this.factList.push(fact);
    this.persist();
    return { fact: { ...fact }, created: true };
  }
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

function factForClaim(facts, claim) {
  return (facts ?? []).filter((fact) => atOrAfter(fact, claim)).at(-1) ?? null;
}

/**
 * 把模型和认领/事实合并成工作台视图：
 * - 每件行李显示状态、由谁接、缺什么证据、下一个联系谁、指令历史。
 * - 班次交替时：未认领事项列给接班人；已认领事项跟随原操作人。
 */
export function buildWorkbench(model, store) {
  const claims = new Map([...store.claims.values()].map((claim) => [claim.code, claim]));
  const currentShift = model.handover?.shift ?? '';

  const pieces = model.pieces.map((piece) => {
    const claim = claims.get(piece.id) ?? null;
    const active = claim && claim.status === 'claimed' ? claim : null;
    const physical = factForClaim(piece.facts, active ?? { claimedAt: '' });
    let claimState = 'not-claimable';
    if (piece.status === 'handover') claimState = active ? 'claimed' : 'unclaimed';
    else if (active) claimState = 'stale';
    let claimNote = '';
    if (claimState === 'stale') claimNote = '该件状态已不再是可交接，原认领指令失去依据；保留操作人和依赖资料，需现场处理。';
    const carried = Boolean(active && currentShift && active.shift !== currentShift);
    if (active && carried && currentShift) {
      claimNote = joinNotes(claimNote, `该认领属于上一班次 ${active.shift}，按原操作人 ${active.operator} 跟踪，不自动改派。`);
    }
    if (claimState === 'unclaimed' && piece.status === 'handover') {
      claimNote = currentShift ? `待 ${currentShift} 班认领。` : '待本班认领。';
    }
    if (active && physical) claimNote = joinNotes(claimNote, `认领后已有现场凭据（${physical.kind} @ ${physical.at}），可以核对结案。`);
    return {
      ...piece,
      claim: claim
        ? {
            ...claim,
            state: claim.status,
            currentShift: currentShift ? claim.shift === currentShift : null,
            carriedOver: carried,
            physicalEvidence: physical,
            note: claimNote,
          }
        : null,
      claimState,
      claimNote,
      assignee: active?.operator ?? (piece.status === 'handover' ? '' : ''),
      successor: !active && piece.status === 'handover' ? currentShift : '',
      nextContact: piece.contacts.candidates[0]?.team ?? '',
      missingEvidence: piece.evidence.missing,
    };
  });

  const byTraveller = new Map();
  for (const piece of pieces) {
    if (!byTraveller.has(piece.traveller)) byTraveller.set(piece.traveller, []);
    byTraveller.get(piece.traveller).push(piece);
  }
  const modelTravellers = new Map((model.travellers ?? []).map((item) => [item.traveller, item]));

  const counts = {
    handover: pieces.filter((piece) => piece.bucket === 'handover').length,
    hold: pieces.filter((piece) => piece.bucket === 'hold').length,
    manual: pieces.filter((piece) => piece.bucket === 'manual').length,
    claimed: pieces.filter((piece) => piece.claimState === 'claimed').length,
    unclaimed: pieces.filter((piece) => piece.claimState === 'unclaimed').length,
    carriedOver: pieces.filter((piece) => piece.claim?.carriedOver).length,
    staleClaims: pieces.filter((piece) => piece.claimState === 'stale').length,
  };

  const carried = pieces.filter((piece) => piece.claim?.carriedOver);
  const unclaimed = pieces.filter((piece) => piece.claimState === 'unclaimed');

  return {
    shift: currentShift,
    replaces: model.handover?.replaces ?? null,
    handoverAt: model.handover?.at ?? '',
    counts,
    travellers: [...new Set([...byTraveller.keys(), ...modelTravellers.keys()])].map((traveller) => {
      const own = byTraveller.get(traveller) ?? [];
      const source = modelTravellers.get(traveller);
      return {
        traveller,
        counts: {
          handover: own.filter((piece) => piece.bucket === 'handover').length,
          hold: own.filter((piece) => piece.bucket === 'hold').length,
          manual: own.filter((piece) => piece.bucket === 'manual').length,
        },
        chains: source?.chains ?? [...new Set(own.map((piece) => piece.chain).filter(Boolean))],
        contacts: source?.contacts ?? [...new Set(own.flatMap((piece) => piece.contacts.candidates.map((item) => item.team)).filter(Boolean))],
        summary: own.length ? own.map((piece) => `${piece.tag}:${piece.statusLabel}`).join('；') : '还没有逐件资料。',
        pieces: own,
      };
    }),
    pieces,
    carryOver: {
      note: model.handover?.replaces
        ? `班次 ${model.handover.replaces} → ${model.handover.shift}（${model.handover.at || '时间待核'}）。待认领事项交给接班人；已认领事项按原操作人跟踪，除非双方转交。`
        : '没有检测到班次交接记录。',
      unclaimed: unclaimed.map(slim),
      claimed: carried.map(slim),
    },
    warnings: [
      ...model.warnings,
      ...(counts.staleClaims ? [`有 ${counts.staleClaims} 条已认领指令因行李状态变化失去依据，需人工处理。`] : []),
    ],
    manualFacts: store.facts(),
    claims: [...store.claims.values()].map((claim) => ({ ...claim })),
  };
}

function joinNotes(first, second) {
  return [first, second].map((item) => normalizeText(item)).filter(Boolean).join(' ');
}

function slim(piece) {
  return {
    id: piece.id,
    traveller: piece.traveller,
    tag: piece.tag,
    segment: piece.segment,
    status: piece.status,
    statusLabel: piece.statusLabel,
    reason: piece.reason,
    claimState: piece.claimState,
    operator: piece.claim?.operator ?? '',
    shift: piece.claim?.shift ?? '',
    assignee: piece.command?.assignee ?? '',
    nextContact: piece.nextContact,
    missingEvidence: piece.missingEvidence,
  };
}
