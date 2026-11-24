/**
 * 交运资料汇总模型（只读判定）。
 *
 * 本模块只阅读上游合成资料并给出核对结论，不写任何上游，
 * 也不生成装机/卸机一类的行李设备命令。
 *
 * 核心约定：
 * - 一条票据签转（transfer）只代表票务信息，不代表行李已随票移动。
 * - 一件行李的交接必须同时有“可认领的交接指令”和现场凭据；指令只对当时那段交运链生效。
 * - 不同来源的时间不是全局序列。先后只在同一 (航段, 交运链, 原条码) 里按现场动作时间解释；
 *   采集/重传时间（seen）只表示资料到达时间。分拣 seq 只在分拣点自己的批次页内递增。
 * - 同一件行李同一时刻只能有一个有效交接指令；已认领指令按原操作人跟踪到有现场凭据或经双方转交。
 */

const WITHDRAWN_STATES = new Set(['withdrawn', 'revoked', 'cancelled', 'canceled', 'cancel']);
const ACTIVE_TICKET_STATES = new Set(['confirmed', 'reissued', 'reopened', 'reinstated']);
/** 分拣点里仍表示“尚未交给新航司”的状态；收件后补传这些记录不改变实体去向。 */
const STALE_OR_QUEUED = new Set(['in-sort', 'transfer', 'awaiting-handoff']);
const REJECTED_STATES = new Set(['rejected', 'refused', 'declined']);

export const STATUS_LABELS = {
  handover: '可交接',
  hold: '待确认',
  blocked: '必须人工处理',
  rejected: '必须人工处理',
  recovery: '必须人工处理',
};

export const STATUS_DETAIL = {
  handover: '已有可核对的交接依据',
  hold: '资料未齐或现场动作未确认',
  blocked: '已装机且无法确认能否抽回',
  rejected: '新航司已明确拒收',
  recovery: '签转已撤销，需双方现场确认',
};

export const BUCKETS = {
  handover: 'handover',
  hold: 'hold',
  blocked: 'manual',
  rejected: 'manual',
  recovery: 'manual',
};

export function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** 只比较完整时间戳；仅时刻（HH:MM）不足以跨来源排列先后。 */
export function normalizeClock(value) {
  const raw = normalizeText(value);
  if (!raw) return { raw: '', ms: null, comparable: false };
  const full = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (full) {
    const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? '' : '+08:00';
    const ms = Date.parse(`${full[1]}-${full[2]}-${full[3]}T${full[4]}:${full[5]}:${full[6] ?? '00'}${zoned}`);
    return { raw, ms: Number.isNaN(ms) ? null : ms, comparable: !Number.isNaN(ms) };
  }
  const clock = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (clock) {
    const ms = ((Number(clock[1]) * 60 + Number(clock[2])) * 60 + Number(clock[3] ?? 0)) * 1000;
    return { raw, ms, comparable: false };
  }
  return { raw, ms: null, comparable: false };
}

export function compareClock(a, b) {
  if (a.comparable && b.comparable) return a.ms - b.ms;
  return 0;
}

function sortByClock(items, field = 'at') {
  return [...items].sort((a, b) => compareClock(normalizeClock(a[field]), normalizeClock(b[field])));
}

function latestByClock(items, field = 'at') {
  return sortByClock(items, field).at(-1) ?? null;
}

function asTextList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeText).filter(Boolean))];
}

/* ------------------------------------------------------------------ */
/* 票务                                                                */
/* ------------------------------------------------------------------ */

/**
 * 按交运链合并票务记录。撤销记录通常不带旧/新票号，沿用同一链上已见的字段；
 * 新票标签只用于识别旅客与新航司受理，不覆盖行李原标签。
 */
function buildTransfers(tickets) {
  const ordered = tickets
    .map((item, index) => ({
      traveller: normalizeText(item.traveller),
      segment: normalizeText(item.segment),
      transfer: normalizeText(item.transfer ?? item.id),
      old: normalizeText(item.old),
      new: normalizeText(item.new),
      oldTag: normalizeText(item.oldTag),
      state: normalizeText(item.state).toLowerCase(),
      at: normalizeText(item.at),
      seen: normalizeText(item.seen),
      order: index,
    }))
    .filter((item) => item.traveller && item.transfer)
    .sort((a, b) => {
      const delta = compareClock(normalizeClock(a.at), normalizeClock(b.at));
      return delta !== 0 ? delta : a.order - b.order;
    });

  const map = new Map();
  for (const record of ordered) {
    let current = map.get(record.transfer);
    if (!current) {
      current = {
        transfer: record.transfer,
        traveller: record.traveller,
        segment: record.segment,
        old: '',
        new: '',
        oldTag: '',
        state: 'unknown',
        at: record.at,
        seen: record.seen,
        confirmedAt: '',
        withdrawnAt: '',
        withdrawnSeen: '',
        events: [],
      };
      map.set(record.transfer, current);
    }
    if (record.segment) current.segment = record.segment;
    if (record.old) current.old = record.old;
    if (record.new) current.new = record.new;
    // 实际演练里票务以旧票号作为可关联的分拣原标签；显式 oldTag 优先。
    if (record.oldTag) current.oldTag = record.oldTag;
    if (WITHDRAWN_STATES.has(record.state)) {
      current.withdrawnAt = record.at;
      current.withdrawnSeen = record.seen || current.withdrawnSeen;
    }
    if (record.state === 'confirmed' || ACTIVE_TICKET_STATES.has(record.state)) {
      if (!ACTIVE_TICKET_STATES.has(current.state)) current.confirmedAt = record.at;
    }
    current.state = record.state || current.state;
    current.at = record.at || current.at;
    if (record.seen && !current.seen) current.seen = record.seen;
    current.events.push({ state: record.state, at: record.at, seen: record.seen, old: record.old, new: record.new });
  }

  for (const record of map.values()) {
    if (!record.oldTag) record.oldTag = record.old;
    if (WITHDRAWN_STATES.has(record.state)) record.phase = 'withdrawn';
    else if (ACTIVE_TICKET_STATES.has(record.state)) record.phase = 'confirmed';
    else record.phase = 'unknown';
    record.active = record.phase === 'confirmed';
    const lastConfirmed = [...record.events].reverse().find((event) => ACTIVE_TICKET_STATES.has(event.state));
    if (lastConfirmed && !record.confirmedAt) record.confirmedAt = lastConfirmed.at;
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* 分拣                                                                */
/* ------------------------------------------------------------------ */

/**
 * 读入分拣批次页。同一页中 tag+state+at 完全相同的条目视为重传，只计一次。
 * 不同页可以停在不同的批次；未读完的页（next 存在或 complete=false）明确保留，
 * 不能把“未出现”当作“已无此件”。
 */
function buildSorting(sortingPages) {
  const pages = (Array.isArray(sortingPages) ? sortingPages : []).map((page, index) => ({
    id: normalizeText(page.id) || `S${index + 1}`,
    entries: Array.isArray(page.entries) ? page.entries : [],
    complete: page.complete !== false,
    next: page.next ?? null,
    terminal: !page.next,
    error: page.error ? normalizeText(page.error) : '',
  }));

  const scans = new Map();
  for (const page of pages) {
    for (const entry of page.entries) {
      const tag = normalizeText(entry.tag);
      const traveller = normalizeText(entry.traveller);
      if (!tag || !traveller) continue;
      const scan = {
        page: page.id,
        pages: [page.id],
        tag,
        traveller,
        segment: normalizeText(entry.segment),
        facility: normalizeText(entry.facility),
        state: normalizeText(entry.state).toLowerCase(),
        seq: Number.isFinite(Number(entry.seq)) ? Number(entry.seq) : null,
        at: normalizeText(entry.at),
        seen: normalizeText(entry.seen),
        duplicate: false,
      };
      // 同一旅客、同一原标签、同一分拣点、同一状态、同一现场动作时间在不同批次页重复出现，
      // 是分拣点补传/重传，只算一次现场动作；`seen` 记录资料到达时间。
      // 分拣点不同则视为两个来源各自的动作，不静默合并。
      const key = [traveller, tag, scan.facility, scan.state, scan.at].join('\u0000');
      const existing = scans.get(key);
      if (!existing) {
        scans.set(key, scan);
        continue;
      }
      existing.duplicate = true;
      if (!existing.pages.includes(page.id)) existing.pages.push(page.id);
      existing.seen = scan.seen || existing.seen;
      if (scan.seq !== null && (existing.seq === null || scan.seq < existing.seq)) existing.seq = scan.seq;
    }
  }
  return { pages, scans: [...scans.values()] };
}

/** 只有“链条最后一页仍声明未完整”才是缺页；中间页带 next 是正常翻页。 */
function pageGaps(pages) {
  return pages
    .filter((page) => page.error || (page.terminal && !page.complete))
    .map((page) => ({ page: page.id, next: page.next, complete: page.complete, error: page.error }));
}

/* ------------------------------------------------------------------ */
/* 新航司受理                                                          */
/* ------------------------------------------------------------------ */

/**
 * 受理页按交运批次登记。空页、重传行和拒收要分开：
 * - rows=[] 且 complete=false：尚未到件，不当作“缺证据”。
 * - rows=[] 且 complete=true：完整但为空，需要向新航司追问。
 * - 重复的 transfer+老条码行：合并，字段取最全；accepted 冲突时标 conflict。
 */
function buildReceiving(receiving, transfers) {
  const batches = (Array.isArray(receiving) ? receiving : receiving ? [receiving] : []).map((batch, index) => {
    const id = normalizeText(batch.batch ?? batch.id) || `G${index + 1}`;
    const rows = (Array.isArray(batch.rows) ? batch.rows : []).map((row) => {
      const transfer = normalizeText(row.transfer);
      const record = transfers.get(transfer);
      const state = normalizeText(row.state).toLowerCase();
      return {
        batch: id,
        transfer,
        oldTag: normalizeText(row.oldTag ?? row.originalTag ?? row.tag),
        newTag: normalizeText(row.newTag),
        accepted: row.accepted !== false && !REJECTED_STATES.has(state),
        at: normalizeText(row.at),
        seen: normalizeText(row.seen),
        signedBy: normalizeText(row.signedBy),
        traveller: record?.traveller ?? normalizeText(row.traveller),
        segment: record?.segment ?? normalizeText(row.segment),
      };
    });
    return { id, complete: batch.complete === true, rows, sourceComplete: batch.complete };
  });

  const merged = new Map();
  for (const batch of batches) {
    for (const row of batch.rows) {
      const key = [row.transfer, row.oldTag].join('\u0000');
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...row, batches: [batch.id], duplicates: 0, conflict: false });
        continue;
      }
      existing.duplicates += 1;
      if (!existing.batches.includes(batch.id)) existing.batches.push(batch.id);
      if (existing.accepted !== row.accepted) existing.conflict = true;
      if (row.newTag && !existing.newTag) existing.newTag = row.newTag;
      if (row.accepted) existing.accepted = true;
      if (row.at && !existing.at) existing.at = row.at;
      if (row.signedBy && !existing.signedBy) existing.signedBy = row.signedBy;
      if (row.seen && !existing.seen) existing.seen = row.seen;
    }
  }
  return { batches, rows: [...merged.values()] };
}

/* ------------------------------------------------------------------ */
/* 地服双边确认                                                        */
/* ------------------------------------------------------------------ */

function buildManual(reports, transfers) {
  const facts = [];
  for (const report of Array.isArray(reports) ? reports : []) {
    const transfer = normalizeText(report.transfer ?? report.handoff);
    const record = transfers.get(transfer);
    const shared = {
      transfer,
      kind: normalizeText(report.type),
      traveller: record?.traveller ?? normalizeText(report.traveller),
      segment: record?.segment ?? normalizeText(report.segment),
      at: normalizeText(report.at),
      seen: normalizeText(report.seen),
      source: normalizeText(report.source) || 'source',
      acceptedBy: asTextList(report.acceptedBy),
    };
    if (Array.isArray(report.items) && report.items.length) {
      for (const detail of report.items) {
        facts.push({
          ...shared,
          kind: normalizeText(detail.type ?? detail.kind ?? shared.kind),
          oldTag: normalizeText(detail.originalTag ?? detail.oldTag),
          from: normalizeText(detail.from ?? report.from),
          to: normalizeText(detail.to ?? report.to),
          at: normalizeText(detail.at ?? shared.at),
          seen: normalizeText(detail.seen ?? shared.seen),
          acceptedBy: asTextList(detail.acceptedBy ?? shared.acceptedBy),
          traveller: normalizeText(detail.traveller ?? shared.traveller),
          segment: normalizeText(detail.segment ?? shared.segment),
        });
      }
      continue;
    }
    facts.push({
      ...shared,
      oldTag: normalizeText(report.originalTag ?? report.oldTag),
      from: normalizeText(report.from),
      to: normalizeText(report.to),
    });
  }
  return facts;
}

/* ------------------------------------------------------------------ */
/* 班次                                                                */
/* ------------------------------------------------------------------ */

function buildHandover(input) {
  if (!input || typeof input !== 'object') return null;
  const teams = input.teams && typeof input.teams === 'object' ? input.teams : {};
  return {
    shift: normalizeText(input.shift),
    replaces: normalizeText(input.replaces) || null,
    at: normalizeText(input.at),
    teams: Object.fromEntries(Object.entries(teams).map(([key, value]) => [normalizeText(key), normalizeText(value)])),
  };
}

function teamFor(handover, code) {
  if (!handover || !code) return '';
  return normalizeText(handover.teams?.[code]);
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {object} inputs
 * @param {Array} inputs.tickets         GET /tickets/transfers
 * @param {Array} inputs.sorting         [{ id, entries, complete, next }]
 * @param {Array|object} inputs.receiving 受理批次对象或数组
 * @param {Array} inputs.manual          GET /reports/manual（可并入工作台登记）
 * @param {object|null} inputs.handover  GET /shifts/handover
 */
export function buildModel(inputs = {}) {
  const handover = buildHandover(inputs.handover);
  const transfers = buildTransfers(Array.isArray(inputs.tickets) ? inputs.tickets : []);
  const sorting = buildSorting(inputs.sorting);
  const receiving = buildReceiving(inputs.receiving, transfers);
  const facts = buildManual(inputs.manual, transfers);

  const keys = new Map();
  const keyOf = (traveller, tag) => traveller + '\u0000' + tag;
  const touch = (traveller, tag, segment) => {
    const travellerText = normalizeText(traveller);
    const tagText = normalizeText(tag);
    if (!travellerText || !tagText) return null;
    const key = keyOf(travellerText, tagText);
    if (!keys.has(key)) keys.set(key, { traveller: travellerText, tag: tagText, segment: normalizeText(segment) });
    return keys.get(key);
  };

  for (const scan of sorting.scans) touch(scan.traveller, scan.tag, scan.segment);
  for (const row of receiving.rows) touch(row.traveller, row.oldTag, row.segment);
  for (const fact of facts) touch(fact.traveller, fact.oldTag, fact.segment);
  // 票务的 old/new 是票号，不是行李条码：不能用它生成行李件，更不能覆盖已动作的原标签。
  const unlinkedReceipts = receiving.rows.filter((row) => !row.traveller || !row.oldTag).length;

  const pieces = [...keys.values()].map((identity) => evaluatePiece(identity, {
    transfers,
    scans: sorting.scans.filter((scan) => scan.traveller === identity.traveller && scan.tag === identity.tag),
    receipt: receiving.rows.find((row) => row.traveller === identity.traveller && row.oldTag === identity.tag) ?? null,
    facts: sortByClock(facts.filter((fact) => fact.traveller === identity.traveller && fact.oldTag === identity.tag)),
    handover,
    allFacts: facts,
  }));

  pieces.sort((a, b) => a.traveller.localeCompare(b.traveller) || a.tag.localeCompare(b.tag));

  const travellerIds = [...new Set([...[...transfers.values()].map((transfer) => transfer.traveller), ...pieces.map((piece) => piece.traveller)])].sort();
  const travellers = travellerIds.map((traveller) => buildTraveller(traveller, transfers, pieces, handover));

  return {
    generatedAt: new Date().toISOString(),
    mode: 'read-only',
    handover,
    warnings: buildWarnings({ transfers, sorting, receiving, handover, facts, unlinkedReceipts }),
    pages: {
      sorting: sorting.pages.map((page) => ({ id: page.id, complete: page.complete, next: page.next, error: page.error, entries: page.entries.length })),      gaps: pageGaps(sorting.pages),
    },
    batches: receiving.batches.map((batch) => ({
      batch: batch.id,
      complete: batch.complete,
      rows: batch.rows.length,
      accepted: batch.rows.filter((row) => row.accepted).length,
      rejected: batch.rows.filter((row) => !row.accepted).length,
      awaiting: batch.rows.length === 0 && !batch.complete,
      emptyComplete: batch.rows.length === 0 && batch.complete,
    })),
    transfers: [...transfers.values()].map(transferOut),
    travellers,
    pieces,
    facts: facts.map(factOut),
  };
}

function transferOut(record) {
  return {
    transfer: record.transfer,
    traveller: record.traveller,
    segment: record.segment,
    state: record.state,
    phase: record.phase,
    active: record.active,
    old: record.old,
    new: record.new,
    oldTag: record.oldTag,
    at: record.at,
    seen: record.seen,
    confirmedAt: record.confirmedAt,
    withdrawnAt: record.withdrawnAt,
    events: record.events.map((event) => ({ ...event })),
  };
}

function factOut(fact) {
  return {
    transfer: fact.transfer,
    traveller: fact.traveller,
    segment: fact.segment,
    oldTag: fact.oldTag,
    kind: fact.kind,
    from: fact.from,
    to: fact.to,
    at: fact.at,
    seen: fact.seen,
    acceptedBy: fact.acceptedBy,
    source: fact.source,
  };
}

/* ------------------------------------------------------------------ */
/* 逐件判定                                                            */
/* ------------------------------------------------------------------ */

function resolveChain(identity, receipt, facts, transfers) {
  if (receipt?.transfer) return receipt.transfer;
  if (facts.length) {
    const linked = latestByClock(facts.filter((fact) => fact.transfer));
    if (linked) return linked.transfer;
  }
  const byTraveller = [...transfers.values()].filter((transfer) => transfer.traveller === identity.traveller && (!identity.segment || !transfer.segment || transfer.segment === identity.segment));
  if (byTraveller.length === 1) return byTraveller[0].transfer;
  // 同一旅客有多条签转时，优先取当前仍有效的那条；仍不唯一就保持未关联。
  const active = byTraveller.filter((transfer) => transfer.active);
  if (active.length === 1) return active[0].transfer;
  // 不能凭航班号/同姓合并；有多个候选时保持未关联。
  return '';
}

function lateHandoffAfterReceipt(scans, receipt) {
  if (!receipt?.accepted) return false;
  const receiptAt = normalizeClock(receipt.at);
  if (!receiptAt.comparable) return false;
  return scans.some((scan) => {
    if (!STALE_OR_QUEUED.has(scan.state)) return false;
    // 现场动作可能早于收件，但资料在收件之后才补传到旧分拣点。两种先后都要识别。
    const actionAt = normalizeClock(scan.at);
    if (actionAt.comparable && compareClock(actionAt, receiptAt) > 0) return true;
    const arrivedAt = normalizeClock(scan.seen);
    return arrivedAt.comparable && compareClock(arrivedAt, receiptAt) > 0;
  });
}

function evaluatePiece(identity, context) {
  const { transfers, scans, receipt, facts, handover } = context;
  const chain = resolveChain(identity, receipt, facts, transfers);
  const transfer = chain ? transfers.get(chain) ?? null : null;
  const latestScan = latestByClock(scans);
  const loadedScan = sortByClock(scans.filter((scan) => scan.state === 'loaded')).at(-1) ?? null;
  const duplicates = scans.filter((scan) => scan.duplicate);
  const lateHandoff = lateHandoffAfterReceipt(scans, receipt);

  const withdrawal = transfer && transfer.phase === 'withdrawn' ? transfer : null;
  const lastFact = latestByClock(facts);
  const factKind = normalizeText(lastFact?.kind).toLowerCase();
  const factResolved = Boolean(lastFact) && (factKind === 'return' || factKind === 'handover' || factKind === 'transfer');
  const factAfterWithdrawal = Boolean(withdrawal && lastFact) && (
    !normalizeClock(lastFact.at).comparable || !normalizeClock(withdrawal.withdrawnAt).comparable
      ? true
      : compareClock(normalizeClock(lastFact.at), normalizeClock(withdrawal.withdrawnAt)) >= 0
  );
  const resolvedFact = factResolved && (!withdrawal || factAfterWithdrawal) ? lastFact : null;

  let status;
  let reason;
  if (resolvedFact) {
    status = 'handover';
    reason = resolvedFact.kind === 'return'
      ? '双方已登记退接事实，行李回到原航司一侧。'
      : '双方已登记转交事实，可以按该交运链交接。';
  } else if (loadedScan) {
    // 装机扫描优先停住本件自动依据；即使票务同时撤销，也只做人工核对，不自动回推。
    status = 'blocked';
    reason = withdrawal
      ? '已收到装机扫描且没有可核对的抽回凭据；同时签转已撤销。本件自动交接依据停止，同组其他行李不受影响。'
      : '已收到装机扫描且没有可核对的抽回凭据：本件自动交接依据停止，同组其他行李不受影响。';
  } else if (withdrawal) {
    status = 'recovery';
    reason = receipt?.accepted
      ? '签转已撤销，但新航司已有收件凭据；行李不会随票自动回原航司，需登记双边确认的退接或转交。'
      : receipt && !receipt.accepted
        ? '签转已撤销，且新航司已拒收；需要双方现场确认行李实体在哪一侧。'
        : '签转已撤销；行李不会随票自动回原航司，需登记双边确认的退接或转交。';
  } else if (receipt && !receipt.accepted) {
    status = 'rejected';
    reason = '新航司受理页已明确拒收，需要人工确认后续去向。';
  } else if (receipt?.accepted && receipt.newTag) {
    status = 'handover';
    reason = '新航司受理页已按交运批次逐件签收并给出新条码。';
  } else if (receipt?.accepted && !receipt.newTag) {
    status = 'hold';
    reason = '新航司已收件但未登记本件新条码，不能据此完成交接。';
  } else if (latestScan) {
    status = 'hold';
    reason = duplicates.length && duplicates.length === scans.length
      ? '只看到重传的分拣扫描，尚未形成新的现场动作。'
      : '分拣点已记录本件，但还没有新航司逐件签收凭据。';
  } else {
    status = 'hold';
    reason = '还没有读到本件的分拣或受理凭据。';
  }

  const command = buildActiveCommand({ identity, chain, transfer, status, receipt, resolvedFact, handover, loadedScan, lastFact });
  const history = buildCommandHistory({ identity, chain, transfer, receipt, resolvedFact, loadedScan, latestScan, facts, status });
  if (lateHandoff) {
    const stale = scans.find((scan) => STALE_OR_QUEUED.has(scan.state));
    history.push({
      code: commandCode(chain, identity.tag),
      kind: 'stale-handoff',
      phase: 'reference',
      at: stale?.at ?? '',
      seen: stale?.seen ?? '',
      owner: '',
      source: 'sorting',
      reliedOn: { ...stale },
      note: '旧分拣点在收件之后补传的待交运记录；不改变已收件事实，也不把责任转回旧分拣点。',
    });
  }

  return {
    id: `${chain || identity.traveller}/${identity.tag}`,
    traveller: identity.traveller,
    tag: identity.tag,
    segment: identity.segment || transfer?.segment || '',
    chain,
    status,
    bucket: BUCKETS[status],
    statusLabel: STATUS_LABELS[status],
    statusDetail: STATUS_DETAIL[status],
    reason,
    claimable: status === 'handover',
    ticket: transfer ? { old: transfer.old, new: transfer.new, transfer: transfer.transfer } : null,
    pass: transfer ? transferOut(transfer) : null,
    withdrawn: withdrawal
      ? { at: withdrawal.withdrawnAt, seen: withdrawal.withdrawnSeen, state: withdrawal.state }
      : null,
    receipt: receipt
      ? {
          transfer: receipt.transfer,
          batch: receipt.batch,
          batches: receipt.batches,
          newTag: receipt.newTag,
          accepted: receipt.accepted,
          at: receipt.at,
          signedBy: receipt.signedBy,
          duplicates: receipt.duplicates,
          conflict: receipt.conflict,
        }
      : null,
    command,
    commands: history,
    evidence: buildEvidence({ transfer, scans, latestScan, receipt, withdrawal, resolvedFact, loadedScan, duplicates, handover }),
    contacts: buildContacts({ handover, transfer, receipt, loadedScan, withdrawal, resolvedFact }),
    actions: buildActions({ status, receipt, withdrawal, resolvedFact, loadedScan, duplicates, handover, chain }),
    scans: sortByClock(scans).map((scan) => ({
      page: scan.page,
      state: scan.state,
      at: scan.at,
      seen: scan.seen,
      duplicate: scan.duplicate,
      seq: scan.seq,
      facility: scan.facility,
    })),
    facts: sortByClock(facts).map(factOut),
    note: transfer ? '' : '未能确定交运链：分拣/受理资料不足以关联到唯一签转记录，需现场核对。',
  };
}

function commandCode(chain, tag) {
  return `${chain || '未关联'}/${tag}`;
}

function buildActiveCommand({ identity, chain, transfer, status, receipt, resolvedFact, handover, loadedScan, lastFact }) {
  if (status !== 'handover') return null;
  if (resolvedFact) {
    const kind = resolvedFact.kind === 'return' ? 'return' : 'handover';
    return {
      code: commandCode(chain, identity.tag),
      transfer: chain,
      piece: identity.tag,
      segment: identity.segment || transfer?.segment || '',
      kind,
      assignee: resolvedFact.to || (kind === 'return' ? teamFor(handover, transfer?.old) : teamFor(handover, transfer?.new)),
      from: resolvedFact.from,
      to: resolvedFact.to,
      source: 'manual-fact',
      shift: handover?.shift ?? '',
      at: resolvedFact.at,
      state: 'offered',
      reliedOn: {
        transfer: transfer ? transferOut(transfer) : null,
        fact: factOut(resolvedFact),
      },
    };
  }
  if (receipt?.accepted && receipt.newTag) {
    return {
      code: commandCode(chain, identity.tag),
      transfer: chain,
      piece: identity.tag,
      segment: identity.segment || transfer?.segment || '',
      kind: 'handover',
      assignee: receipt.signedBy || teamFor(handover, transfer?.new),
      source: 'receiving',
      shift: handover?.shift ?? '',
      at: receipt.at,
      state: 'offered',
      reliedOn: {
        transfer: transfer ? transferOut(transfer) : null,
        receipt: { ...receipt },
      },
    };
  }
  return null;
}

function buildCommandHistory({ identity, chain, transfer, receipt, resolvedFact, loadedScan, latestScan, facts, status }) {
  const code = commandCode(chain, identity.tag);
  const history = [];
  if (transfer) {
    for (const event of transfer.events) {
      history.push({
        code,
        kind: event.state === 'withdrawn' ? 'withdraw' : 'ticket',
        phase: event.state === 'withdrawn' ? 'withdrawn' : 'reference',
        at: event.at,
        seen: event.seen,
        owner: '',
        source: 'tickets',
        reliedOn: { old: event.old || transfer.old, new: event.new || transfer.new, transfer: transfer.transfer, state: event.state },
        note: event.state === 'withdrawn'
          ? '票务撤销签转；原交接指令作废，但行李实体不会随票移动。'
          : '票务签转记录，只说明票据，不等同于行李已交接。',
      });
    }
  }
  if (receipt) {
    history.push({
      code,
      kind: receipt.accepted ? 'handover' : 'reject',
      phase: !receipt.accepted ? 'rejected' : transfer?.phase === 'withdrawn' ? 'withdrawn' : 'active',
      at: receipt.at,
      owner: receipt.signedBy,
      source: 'receiving',
      reliedOn: { ...receipt },
      note: !receipt.accepted
        ? '新航司按件拒收。'
        : transfer?.phase === 'withdrawn'
          ? '签转撤销后，这条收件指令作废；收件凭据仍保留。'
          : '新航司逐件签收。',
    });
  }
  if (loadedScan) {
    history.push({
      code,
      kind: 'blocked',
      phase: status === 'handover' && !facts.length ? 'blocked' : 'blocked',
      at: loadedScan.at,
      owner: '',
      source: 'sorting',
      reliedOn: { ...loadedScan },
      note: '已装机扫描；没有人工双边凭据前不能作为自动交接依据，也不下达抽回命令。',
    });
  }
  for (const fact of sortByClock(facts)) {
    history.push({
      code,
      kind: fact.kind === 'return' ? 'return' : 'handover',
      phase: fact === resolvedFact ? 'active' : 'reference',
      at: fact.at,
      owner: fact.to,
      source: fact.source === 'workbench' ? 'workbench' : 'manual-report',
      reliedOn: factOut(fact),
      note: fact === resolvedFact ? '双边确认的现场事实，作为当前交接依据。' : '历史双边记录。',
    });
  }
  if (!history.length) {
    history.push({
      code,
      kind: 'pending',
      phase: 'pending',
      at: latestScan?.at ?? '',
      owner: '',
      source: 'none',
      reliedOn: {},
      note: '尚未取得任何可核对资料。',
    });
  }
  return history;
}

function buildEvidence({ transfer, scans, latestScan, receipt, withdrawal, resolvedFact, loadedScan, duplicates, handover }) {
  const items = [];
  items.push(transfer
    ? { key: 'ticket', label: '票务签转', ok: true, value: `${transfer.transfer} ${transfer.state}`, at: transfer.at }
    : { key: 'ticket', label: '票务签转', ok: false, value: '未找到对应签转记录', at: '' });
  items.push(latestScan
    ? { key: 'sorting', label: '分拣扫描', ok: !latestScan.duplicate, value: `${latestScan.state}${latestScan.at ? ' @ ' + latestScan.at : ''}`, at: latestScan.at, page: latestScan.page }
    : { key: 'sorting', label: '分拣扫描', ok: false, value: '尚未读到本件条目', at: '' });
  items.push(receipt
    ? {
        key: 'receiving',
        label: '新航司受理',
        ok: receipt.accepted && Boolean(receipt.newTag),
        value: receipt.accepted ? `${receipt.newTag || '未分配新条码'} 已签收` : '拒收',
        at: receipt.at,
        batch: receipt.batch,
      }
    : { key: 'receiving', label: '新航司受理', ok: false, value: '受理批次里没有本件', at: '' });
  if (withdrawal) items.push({ key: 'withdrawal', label: '签转撤销', ok: true, value: withdrawal.at || withdrawal.state, at: withdrawal.at });
  if (resolvedFact) {
    items.push({ key: 'manual', label: '地服双边确认', ok: true, value: `${resolvedFact.kind} ${resolvedFact.at || ''}`.trim(), at: resolvedFact.at });
  }
  if (loadedScan) {
    items.push({ key: 'load', label: '装机扫描', ok: Boolean(resolvedFact), value: loadedScan.at, at: loadedScan.at });
  }
  if (duplicates.length) {
    items.push({ key: 'duplicate', label: '重传扫描', ok: false, value: `${duplicates.length} 条（只计现场动作一次）`, at: duplicates.at(-1).seen || duplicates.at(-1).at });
  }
  const missing = items.filter((item) => !item.ok).map((item) => `${item.label}：${item.value || '缺'}`);
  return { items, missing, shift: handover?.shift ?? '' };
}

function buildContacts({ handover, transfer, receipt, loadedScan, withdrawal, resolvedFact }) {
  const oldAirline = teamFor(handover, transfer?.old);
  const newAirline = teamFor(handover, transfer?.new);
  const candidates = [];
  if (resolvedFact) {
    const next = resolvedFact.kind === 'return' ? oldAirline : newAirline;
    candidates.push({ role: '当前保管方', team: next || resolvedFact.to, reason: '双边现场事实已登记' });
  }
  if (loadedScan) candidates.push({ role: '装机复核', team: teamFor(handover, 'load-check'), reason: '核对能否抽回，工作台不代发设备命令' });
  if (receipt?.accepted && !receipt.newTag) candidates.push({ role: '新航司收件', team: receipt.signedBy || newAirline, reason: '补取本件新条码' });
  if (receipt && !receipt.accepted) candidates.push({ role: '原航司/新航司', team: [oldAirline, newAirline].filter(Boolean).join(' / '), reason: '拒收后的去向确认' });
  if (withdrawal && !resolvedFact) {
    candidates.push({ role: '原航司', team: oldAirline, reason: '确认行李是否已回到原航司' });
    candidates.push({ role: '新航司', team: newAirline, reason: '确认已收件是否退接' });
  }
  if (!candidates.length) {
    if (newAirline) candidates.push({ role: '新航司', team: newAirline, reason: '等待逐件签收' });
    if (oldAirline) candidates.push({ role: '原航司', team: oldAirline, reason: '确认分拣区状态' });
  }
  return {
    shift: handover?.shift ?? '',
    replaces: handover?.replaces ?? '',
    oldAirline,
    newAirline,
    loadCheck: loadedScan ? teamFor(handover, 'load-check') : '',
    receiving: receipt?.signedBy ?? '',
    candidates,
    summary: candidates.map((item) => `${item.role}:${item.team || '待班次资料'}`).join('；') || '待班次资料确认',
  };
}

function buildActions({ status, receipt, withdrawal, resolvedFact, loadedScan, duplicates, handover, chain }) {
  const actions = [];
  if (status === 'blocked') {
    actions.push({ kind: 'stop-auto', label: '停止本件自动交接依据', destructive: false });
    actions.push({ kind: 'contact', label: '联系装机复核班组', team: teamFor(handover, 'load-check') });
  }
  if (status === 'rejected') {
    actions.push({ kind: 'contact', label: '联系双方确认拒收后去向' });
    actions.push({ kind: 'register-fact', label: '登记双边确认的退接或转交', chain });
  }
  if (status === 'recovery') {
    actions.push({ kind: 'register-fact', label: '登记双边确认的退接或转交', chain });
  }
  if (receipt?.accepted && !receipt.newTag) {
    actions.push({ kind: 'contact', label: '向新航司补取本件新条码' });
  }
  if (status === 'hold' && !receipt) {
    actions.push({ kind: 'watch', label: '继续核对分拣页与新航司受理批次' });
  }
  if (duplicates.length) actions.push({ kind: 'ignore-duplicate', label: '忽略重传扫描，不重复计数' });
  if (loadedScan && resolvedFact) actions.push({ kind: 'verify-fact', label: '复核双边事实与装机时序' });
  return actions;
}

/* ------------------------------------------------------------------ */
/* 旅客视图与告警                                                      */
/* ------------------------------------------------------------------ */

function buildTraveller(traveller, transfers, pieces, handover) {
  const ownTransfers = [...transfers.values()].filter((record) => record.traveller === traveller);
  const own = pieces.filter((piece) => piece.traveller === traveller);
  const counts = { handover: 0, hold: 0, manual: 0 };
  for (const piece of own) counts[piece.bucket] += 1;
  const teams = new Set();
  for (const piece of own) {
    for (const item of piece.contacts.candidates) if (item.team) teams.add(item.team);
  }
  return {
    traveller,
    transfers: ownTransfers.map(transferOut),
    chains: ownTransfers.map((record) => record.transfer),
    counts,
    pieces: own.map((piece) => piece.tag),
    contacts: [...teams],
    shift: handover?.shift ?? '',
    summary: own.length
      ? own.map((piece) => `${piece.tag}:${piece.statusLabel}`).join('；')
      : '没有发现该旅客的可核对行李条目。',
  };
}

function buildWarnings({ transfers, sorting, receiving, handover, facts, unlinkedReceipts = 0 }) {
  const warnings = [];
  const gaps = pageGaps(sorting.pages);
  if (gaps.length) {
    warnings.push(`分拣批次页未读完：${gaps.map((gap) => `${gap.page}${gap.next ? ' (next=' + gap.next + ')' : ''}`).join('、')}；未出现不等于无此件。`);
  }
  for (const batch of receiving.batches) {
    if (batch.rows.length === 0 && !batch.complete) {
      warnings.push(`受理批 ${batch.id} 尚未到件（空页且 complete=false），不等同于缺证据。`);
    }
    if (batch.rows.length === 0 && batch.complete) {
      warnings.push(`受理批 ${batch.id} 完整但为空，需向新航司确认是否漏登记。`);
    }
  for (const row of receiving.rows.filter((item) => item.conflict)) {
    warnings.push(`受理资料里 ${row.transfer}/${row.oldTag} 既出现签收又出现拒收（重传行冲突），保持人工核对。`);
  }
  }
  for (const transfer of transfers.values()) {
    if (transfer.phase === 'withdrawn') {
      const received = receiving.rows.some((row) => row.transfer === transfer.transfer && row.accepted);
      warnings.push(`交运链 ${transfer.transfer} 的签转已撤销${received ? '，但新航司已有收件凭据；行李不会自动回到原航司。' : '。'}`);
    }
  }
  if (handover?.replaces) {
    warnings.push(`班次已由 ${handover.replaces} 交接至 ${handover.shift}（${handover.at || '时间待核'}）：待认领事项交接班人，已认领事项按原操作人跟踪。`);
  }
  const segments = new Set(sorting.scans.map((scan) => scan.segment).filter(Boolean));
  if (segments.size > 1) warnings.push('分拣页出现多个航段，不能凭航班号和同姓合并行李。');
  const unlinked = sorting.scans.filter((scan) => ![...transfers.values()].some((transfer) => transfer.traveller === scan.traveller));
  if (unlinked.length) warnings.push(`有 ${new Set(unlinked.map((scan) => scan.tag)).size} 件分拣条目找不到对应旅客的签转记录，保持未关联，不并入同航班。`);
  if (unlinkedReceipts) warnings.push(`有 ${unlinkedReceipts} 条受理行缺少旅客或原条码，未并入任何件，需核对原始登记。`);
  if (facts.some((fact) => fact.source === 'workbench')) warnings.push('当前视图包含工作台登记的双边事实，来源标为 workbench。');
  return warnings;
}
