// Evaluates evidence per original bag tag. Statuses are always per bag: one loaded bag never
// blocks the rest of the traveller's group, and one late backfill never reopens an accepted leg.

import { STATUS, actionMs, carrierFromFlight, normalizeTime, severityRank, sortByAction, stableKey } from './helpers.mjs';

const LOADED_STATES = new Set(['loaded', 'onboard', 'loaded-on-aircraft']);
const HANDOFF_STATES = new Set(['awaiting-handoff', 'transfer', 'handoff', 'pending-handoff']);
const REJECT_TYPES = new Set(['return', 'transfer', 'handoff', 'hand-over']);

export function evaluateEvidence({ evidence, receiving, tickets, sortingProblems = [], instructionLookup } = {}) {
  const shiftState = resolveShifts(evidence.shifts);
  const bags = [];
  const groupProblems = [...sortingProblems, ...(evidence.problems ?? [])];

  const sourceIncomplete = groupProblems.some((problem) => [
    'sorting-incomplete',
    'sorting-page-error',
    'sorting-loop',
    'sorting-too-many-pages',
    'receiving-error',
    'tickets-error',
    'receiving-empty-batch',
  ].includes(problem?.kind)) || receiving?.complete === false;

  for (const transfer of evidence.transfers.values()) {
    for (const bag of transfer.bags.values()) {
      bags.push(evaluateBag({ transfer, bag, receiving, tickets, shiftState, instructionLookup, sourceIncomplete }));
    }
  }

  for (const transfer of evidence.transfers.values()) {
    if (transfer.bags.size === 0) {
      bags.push(evaluateEmptyTransfer({ transfer, receiving, tickets, shiftState, sourceIncomplete }));
    }
  }

  const travellers = groupTravellers(bags);
  return {
    shift: shiftState.public,
    shifts: shiftState.all,
    bags,
    travellers,
    problems: groupProblems,
    generatedAt: new Date().toISOString(),
  };
}

function evaluateEmptyTransfer({ transfer, receiving, tickets, shiftState, sourceIncomplete }) {
  const base = baseBag({ transfer, bag: { originalTag: null, sorting: [], receiving: [], manual: [], rescans: [] }, receiving, tickets, shiftState });
  // An unfinished source page is not proof that no bag exists. Only call it manual when every
  // source that could publish a bag has finished and still has nothing.
  const severity = sourceIncomplete ? STATUS.CHECK : STATUS.MANUAL;
  base.reasons.push({
    code: sourceIncomplete ? 'transfer-without-bag-yet' : 'transfer-without-bag',
    severity,
    text: sourceIncomplete
      ? '票务已有签转，但分拣或受理来源尚未完整发布，暂不能断言行李不存在。'
      : '票务存在签转记录，但分拣与受理都没有任何原始条码，无法定位行李。',
  });
  base.gaps.push({
    code: 'bag-not-located',
    source: 'sorting+receiving',
    text: sourceIncomplete ? '来源仍在更新，缺少可核对的原始条码。' : '缺少原条码或分拣扫描。',
  });
  base.status = severity;
  base.nextContacts = buildContacts({
    shiftState,
    transfer,
    base,
    lastAccepted: null,
    lastRejected: null,
    loaded: null,
    ticket: transfer.ticket,
  });
  if (base.nextContacts.length === 0) {
    base.nextContacts = [{ role: '票务', team: null, shift: null, reason: '核实签转旅客是否实际托运' }];
  }
  base.closed = false;
  base.chain = { id: `${transfer.transfer}/-/unassigned`, batch: null, status: 'unassigned' };
  base.holder = { side: 'unknown', carrier: null, team: null, shift: null, since: null, basis: '没有可定位的原始条码' };
  return base;
}

function evaluateBag({ transfer, bag, receiving, tickets, shiftState, instructionLookup, sourceIncomplete }) {
  const base = baseBag({ transfer, bag, receiving, tickets, shiftState });
  const ticket = transfer.ticket;
  const ticketKnown = ticket.notices.length > 0;

  const sorting = sortByAction(bag.sorting);
  const receivingRows = sortByAction(bag.receiving);
  const manual = sortByAction(bag.manual);

  // Physical acceptance exists even when the new carrier has not assigned a new tag yet; the
  // missing tag is a gap, not an absence of receipt.
  const receipts = receivingRows.filter((row) => row.accepted);
  const rejected = receivingRows.filter((row) => !row.accepted);
  // A later explicit rejection supersedes an earlier receipt for the *current* custody question.
  const lastAccepted = receipts.at(-1) ?? null;
  const lastRejected = rejected.at(-1) ?? null;
  const rejectedAfterAcceptance = Boolean(
    lastRejected
      && lastAccepted
      && (actionMs(lastRejected) ?? -Infinity) > (actionMs(lastAccepted) ?? -Infinity),
  );
  const effectiveAccepted = rejectedAfterAcceptance ? null : lastAccepted;
  const loaded = sorting.filter((event) => LOADED_STATES.has(String(event.state))).at(-1) ?? null;
  const handoffs = sorting.filter(
    (event) => HANDOFF_STATES.has(String(event.state)) || event.facility === 'transfer',
  );

  base.newTag = lastAccepted?.newTag ?? null;
  if (lastAccepted && !lastAccepted.newTag) {
    base.gaps.push({ code: 'new-tag-missing', source: 'receiving', text: '新航司已收件但未登记新条码。' });
  }
  base.physical = {
    lastSortingState: sorting.at(-1)?.state ?? null,
    lastSortingAt: sorting.at(-1)?.at ?? null,
    lastSortingFacility: sorting.at(-1)?.facility ?? null,
    acceptance: lastAccepted
      ? { batch: lastAccepted.batch, at: lastAccepted.at, signedBy: lastAccepted.signedBy, newTag: lastAccepted.newTag }
      : null,
    rejectedAt: lastRejected?.at ?? null,
    loadedAt: loaded?.at ?? null,
    awaitingHandoffAt: handoffs.at(-1)?.at ?? null,
  };
  // Only a row that actually names this bag defines its acceptance batch. The page's current
  // batch is deliberately not borrowed, because the page may be sitting on another batch.
  base.batch = lastAccepted?.batch ?? lastRejected?.batch ?? null;
  // A bag can pass through more than one acceptance batch (rejected in one, received in another).
  // Keep each chain visible so an instruction can be read against the chain it actually closed.
  base.chains = summarizeChains(receivingRows, sorting, bag.originalTag);
  base.chain = {
    id: stableKey([transfer.transfer, bag.originalTag, base.batch ?? 'unassigned']),
    batch: base.batch,
    status: lastAccepted ? 'accepted' : lastRejected ? 'rejected' : 'pending',
  };

  const reason = (code, severity, text) => base.reasons.push({ code, severity, text });
  const gap = (code, source, text) => base.gaps.push({ code, source, text });

  // ---- Ticket authority ---------------------------------------------------
  if (!ticketKnown) {
    if (tickets?.available === false) {
      reason('ticket-source-unavailable', STATUS.CHECK, '票务来源暂不可读，不能确认本次签转是否仍有效。');
      gap('ticket-source-unavailable', 'tickets', '签转、重开与撤销依据缺失。');
    } else {
      reason('ticket-notice-missing', STATUS.MANUAL, '受理或分拣指向一个票务从未发布的签转号，缺少可引用的签转依据。');
      gap('ticket-notice-missing', 'tickets', '需要票务补发或现场核对。');
    }
  } else {
    if (ticket.conflicts.length > 0) {
      reason('ticket-same-time-conflict', STATUS.MANUAL, '同一时刻出现互相矛盾的签转状态，不能判定有效指令。');
      gap('ticket-same-time-conflict', 'tickets', '需要票务明确先后。');
    }
    if (ticket.withdrawn) {
      base.observations.push({
        code: 'ticket-withdrawn',
        text: `票务已于 ${ticket.withdrawnNotice?.at ?? '未知时间'} 撤销签转 ${transfer.transfer}。`,
      });
    }
  }

  // ---- Manual bilateral reports ------------------------------------------
  const completeReports = manual.filter((report) => {
    if (!REJECT_TYPES.has(String(report.type))) return false;
    const signers = new Set(report.acceptedBy);
    return signers.size >= 2 && (!report.from || signers.has(report.from)) && (!report.to || signers.has(report.to));
  });
  const partialReports = manual.filter((report) => REJECT_TYPES.has(String(report.type)) && !completeReports.includes(report));
  const manualResolved = completeReports.at(-1) ?? null;

  // ---- Acceptance / rejection ordering -----------------------------------
  const acceptanceAfterWithdrawal = Boolean(
    effectiveAccepted
      && ticket.withdrawn
      && (actionMs(ticket.withdrawnNotice) != null)
      && (actionMs(effectiveAccepted) != null)
      && actionMs(effectiveAccepted) >= actionMs(ticket.withdrawnNotice),
  );
  const withdrawalAfterAcceptance = Boolean(
    effectiveAccepted
      && ticket.withdrawn
      && (actionMs(ticket.withdrawnNotice) != null)
      && (actionMs(effectiveAccepted) != null)
      && actionMs(ticket.withdrawnNotice) > actionMs(effectiveAccepted),
  );
  const loadedAfterAcceptance = Boolean(
    effectiveAccepted
      && loaded
      && actionMs(loaded) != null
      && actionMs(effectiveAccepted) != null
      && actionMs(loaded) > actionMs(effectiveAccepted),
  );

  // A late awaiting-handoff re-transmission whose *action* happened before acceptance must not
  // move custody back. A later one is treated as a genuine physical ambiguity.
  const lateBackfills = handoffs.filter((event) => effectiveAccepted
    && actionMs(event) != null
    && actionMs(effectiveAccepted) != null
    && actionMs(event) <= actionMs(effectiveAccepted)
    && (normalizeTime(event.seen).ms ?? 0) > (actionMs(effectiveAccepted) ?? 0));
  const conflictingHandoffs = handoffs.filter((event) => effectiveAccepted
    && actionMs(event) != null
    && actionMs(effectiveAccepted) != null
    && actionMs(event) > actionMs(effectiveAccepted));
  for (const event of lateBackfills) {
    base.observations.push({
      code: 'late-backfill-ignored',
      text: `原分拣点于 ${event.seen} 补传 ${event.at} 的“待交运”记录；该动作早于 ${lastAccepted.at} 的新航司收件，不改变已收件责任。`,
      ref: { tag: event.tag, facility: event.facility, actionAt: event.at, seen: event.seen },
    });
  }
  for (const event of conflictingHandoffs) {
    reason('handoff-after-acceptance', STATUS.MANUAL, `新航司已收件后又出现 ${event.at} 的待交运扫描，实体位置需人工核实。`);
    gap('handoff-after-acceptance', 'sorting', '签收后原分拣点再次报告待交运。');
  }

  // ---- Sorting quality observations --------------------------------------
  checkFacilitySequences(base, sorting);
  if ((bag.rescans?.length ?? 0) > 0) {
    base.observations.push({
      code: 'sorting-rescan-merged',
      text: `分拣来源重传了 ${bag.rescans.length} 条相同扫描，已按一次现场动作处理，不叠加次数。`,
    });
  }
  if ((bag.manualRescans?.length ?? 0) > 0) {
    base.observations.push({
      code: 'manual-report-rescan-merged',
      text: `现场报表重传了 ${bag.manualRescans.length} 条相同双边确认，按一次事实处理。`,
    });
  }
  if ((bag.receivingRescans?.length ?? 0) > 0) {
    base.observations.push({
      code: 'receiving-rescan-merged',
      text: `受理来源重传了 ${bag.receivingRescans.length} 条相同收件记录，签收时间未改变。`,
    });
  }

  // ---- Decide status ------------------------------------------------------
  let closed = false;
  let resolution = null;

  if (loaded && !effectiveAccepted && manualResolved && actionMs(manualResolved) >= (actionMs(loaded) ?? -Infinity)) {
    resolution = describeResolution(manualResolved);
    closed = true;
    base.observations.push({
      code: 'loaded-resolved-by-manual',
      text: `装机后由 ${manualResolved.acceptedBy.join(' / ')} 于 ${manualResolved.at} 双边确认“${manualResolved.type}”。`,
    });
  }

  if (!closed && manualResolved && effectiveAccepted && ticket.withdrawn) {
    resolution = describeResolution(manualResolved);
    closed = true;
  }

  if (closed) {
    base.status = STATUS.READY;
    base.closed = true;
    base.resolution = resolution;
    base.holder = holderFromResolution(shiftState, transfer, resolution);
    if (effectiveAccepted) {
      base.newTag = effectiveAccepted.newTag;
      base.observations.push({
        code: 'new-tag-retained',
        text: `新条码 ${effectiveAccepted.newTag ?? '未分配'} 仅作收件记录，原条码 ${bag.originalTag} 仍是本次交运的追踪键。`,
      });
    }
    base.reasonSummary = `${resolution.bilateral ? '双边确认' : '人工'}${resolution.typeLabel}：${resolution.from ?? '?'} → ${resolution.to ?? '?'}`;
    base.nextContacts = [];
    base.dependsOn = collectDependsOn({ transfer, ticket, lastAccepted: effectiveAccepted, lastRejected, loaded, manualResolved, lateBackfills });
    return finish(base, instructionLookup);
  }

  if (loaded && !effectiveAccepted) {
    reason('loaded-without-acceptance', STATUS.MANUAL, `行李已于 ${loaded.at ?? '未知时间'} 装机，但没有新航司收件记录，无法确认能否抽回。`);
    gap('loaded-without-acceptance', 'sorting+receiving', '缺少下机/抽回或新航司收件凭据。');
    base.hold = true;
    base.status = STATUS.MANUAL;
    base.holder = holderFor(shiftState, transfer, 'unknown', loaded.at, '装机后未收件');
    base.observations.push({
      code: 'hold-only-this-bag',
      text: '仅暂停本件条码的自动交接依据，同组其他行李不受影响。',
    });
  } else if (loadedAfterAcceptance) {
    reason('loaded-after-acceptance', STATUS.MANUAL, `新航司于 ${effectiveAccepted.at} 已收件，但 ${loaded.at} 又出现装机扫描，实体状态冲突。`);
    gap('loaded-after-acceptance', 'sorting+receiving', '收件后仍有装机动作。');
    base.hold = true;
    base.status = STATUS.MANUAL;
    base.holder = holderFor(shiftState, transfer, 'unknown', loaded.at, '收件后仍出现装机扫描');
  } else if (effectiveAccepted && ticketKnown && ticket.withdrawn) {
    reason(
      acceptanceAfterWithdrawal ? 'accepted-after-withdrawal' : 'withdrawn-after-acceptance',
      STATUS.MANUAL,
      acceptanceAfterWithdrawal
        ? `签转已于 ${ticket.withdrawnNotice?.at ?? '未知时间'} 撤销，新航司却在 ${effectiveAccepted.at} 收件；撤销不会让已收行李自动回到原航司。`
        : `新航司于 ${effectiveAccepted.at} 已收件，票务随后于 ${ticket.withdrawnNotice?.at ?? '未知时间'} 撤销签转；已收行李不会随票自动回到原航司。`,
    );
    gap('withdrawal-custody-unresolved', 'receiving+manual', '需要两边确认的退接或转交事实。');
    base.status = STATUS.MANUAL;
    base.holder = holderFor(shiftState, transfer, 'new', effectiveAccepted.at, `签收人 ${effectiveAccepted.signedBy ?? '未署名'}`);
    base.observations.push({
      code: 'withdrawal-does-not-return-bag',
      text: `实体凭据停留在 ${effectiveAccepted.signedBy ?? '新航司'}（新条码 ${effectiveAccepted.newTag ?? '未分配'}），撤销本身不构成退回。`,
    });
  } else if (rejectedAfterAcceptance) {
    reason('rejected-after-acceptance', STATUS.CHECK, `本件先由 ${lastAccepted.at} 收件，后于 ${lastRejected.at} 被登记为拒收，以较晚动作为准，待重新交运。`);
    gap('rejected-after-acceptance', 'receiving', '需要拒收原因与重新交运安排。');
    base.status = STATUS.CHECK;
    base.holder = holderFor(shiftState, transfer, 'old', lastRejected.at, '拒收后仍由原航司保管');
  } else if (effectiveAccepted && ticketKnown && ticket.active) {
    base.status = STATUS.READY;
    base.closed = true;
    base.resolution = {
      type: 'accepted',
      typeLabel: '逐件收件',
      custodySide: 'new',
      from: transfer.oldCarrier,
      to: transfer.newCarrier,
      at: effectiveAccepted.at,
      signers: effectiveAccepted.signedBy ? [effectiveAccepted.signedBy] : [],
      bilateral: false,
      newTag: effectiveAccepted.newTag,
    };
    base.reasonSummary = `${transfer.oldCarrier ?? '原航司'} → ${transfer.newCarrier ?? '新航司'}，${effectiveAccepted.at} 由 ${effectiveAccepted.signedBy ?? '新航司'} 收件`;
    base.holder = holderFor(shiftState, transfer, 'new', effectiveAccepted.at, `签收人 ${effectiveAccepted.signedBy ?? '未署名'}`);
    base.nextContacts = [];
    base.observations.push({
      code: 'original-tag-is-key',
      text: effectiveAccepted.newTag
        ? `新条码 ${effectiveAccepted.newTag} 只写入本件收件记录，不覆盖原条码 ${bag.originalTag}。`
        : `本件已收件但未分配新条码，继续以原条码 ${bag.originalTag} 追踪。`,
    });
  } else if (effectiveAccepted && ticketKnown && !ticket.active && !ticket.withdrawn) {
    reason('ticket-state-unrecognized', STATUS.CHECK, `新航司已收件，但票务状态“${ticket.state ?? '未知'}”不能确认签转仍有效。`);
    gap('ticket-state-unrecognized', 'tickets', '需要票务确认当前签转状态。');
    base.status = STATUS.CHECK;
    base.holder = holderFor(shiftState, transfer, 'new', effectiveAccepted.at, `签收人 ${effectiveAccepted.signedBy ?? '未署名'}`);
  } else if (effectiveAccepted && !ticketKnown) {
    // Ticket source unavailable: cannot call it ready even though receiving exists.
    reason('ticket-source-unavailable', STATUS.CHECK, '有收件凭据，但票务依据当前不可读。');
    gap('ticket-source-unavailable', 'tickets', '需要票务确认签转仍有效。');
    base.status = STATUS.CHECK;
    base.holder = holderFor(shiftState, transfer, 'new', effectiveAccepted.at, `签收人 ${effectiveAccepted.signedBy ?? '未署名'}`);
  } else if (!effectiveAccepted && lastRejected) {
    reason('receiving-rejected', STATUS.CHECK, `新航司于 ${lastRejected.at} 明确拒收本件${lastRejected.newTag ? '' : '（未分配新条码）'}。`);
    gap('receiving-rejected', 'receiving', lastRejected.newTag ? '拒收原因未提供。' : '拒收原因与新条码分配情况未提供。');
    base.status = STATUS.CHECK;
    base.holder = holderFor(shiftState, transfer, 'old', lastRejected.at, '拒收后仍由原航司保管');
    if (lastRejected.signedBy) checkSigner(base, shiftState, transfer, lastRejected);
  } else if (ticketKnown && ticket.withdrawn && !effectiveAccepted) {
    if (manualResolved) {
      base.status = STATUS.READY;
      base.closed = true;
      base.resolution = describeResolution(manualResolved);
      base.holder = holderFor(shiftState, transfer, base.resolution.custodySide, manualResolved.at, '双边确认');
      base.reasonSummary = `${base.resolution.typeLabel}：${manualResolved.from} → ${manualResolved.to}`;
      base.nextContacts = [];
    } else {
      reason('withdrawn-before-acceptance', STATUS.CHECK, '签转已撤销且新航司尚未收件，需确认行李留运/改配，不能继续按原签转交接。');
      gap('withdrawn-before-acceptance', 'tickets+sorting', '缺少撤销后的留运或改配指令。');
      base.status = STATUS.CHECK;
      base.holder = holderFor(shiftState, transfer, 'old', ticket.withdrawnNotice?.at, '撤销后仍在原航司');
      if (partialReports.length > 0) {
        reason('manual-confirmation-incomplete', STATUS.CHECK, '现场退接/转交记录缺少双方签署。');
        gap('manual-confirmation-incomplete', 'manual', '需要补齐双边确认。');
      }
    }
  } else if (handoffs.length > 0) {
    const receiveState = receivingState(receiving, base.batch);
    if (receiveState === 'unavailable') {
      reason('receiving-unavailable', STATUS.CHECK, '新航司受理页当前不可读。');
      gap('receiving-unavailable', 'receiving', '无法核对逐件收件。');
    } else if (receiveState === 'not-started') {
      reason('receiving-not-started', STATUS.CHECK, '新航司受理批次尚未完成登记（空页且未完成）。');
      gap('receiving-not-started', 'receiving', '需要新航司受理台开批。');
    } else if (receiveState === 'batch-missing') {
      reason('receiving-batch-missing', STATUS.CHECK, `受理页当前停在其它批次，看不到本件所在的 ${base.batch ?? '受理批'}。`);
      gap('receiving-batch-missing', 'receiving', '需要新航司切回对应交运批次。');
    } else if (receiveState === 'empty-complete') {
      reason('receiving-empty-complete', STATUS.CHECK, '新航司受理页标记完成但没有任何行，需要核实是否漏登记。');
      gap('receiving-empty-complete', 'receiving', '空白受理页不能等同于收件。');
    } else {
      reason('receiving-omitted', STATUS.CHECK, `${base.batch ?? '受理批次'} 已完成但未列出本件，收件凭据缺失。`);
      gap('receiving-omitted', 'receiving', '本件未出现在逐件受理表中。');
    }
    base.status = STATUS.CHECK;
    base.holder = holderFor(shiftState, transfer, 'old', handoffs.at(-1)?.at, '待交运扫描仍在原航司');
    base.observations.push({
      code: 'awaiting-handoff',
      text: `原航司 ${handoffs.at(-1)?.facility ?? '分拣区'} 于 ${handoffs.at(-1)?.at ?? '未知时间'} 报待交运。`,
    });
  } else if (sorting.length > 0) {
    // Bag is known physically but never reported awaiting handoff and no acceptance exists.
    reason('handoff-not-recorded', STATUS.CHECK, '行李仍在原航司分拣区，尚未出现待交运或收件记录。');
    gap('handoff-not-recorded', 'sorting', '缺少待交运扫描。');
    base.status = STATUS.CHECK;
    base.holder = holderFor(shiftState, transfer, 'old', sorting.at(-1)?.at, '仍在原分拣区');
  } else if (sourceIncomplete) {
    reason('no-physical-evidence-yet', STATUS.CHECK, '除票务签转外暂无分拣或受理记录，来源仍在更新，不能断言行李不存在。');
    gap('no-physical-evidence-yet', 'sorting+receiving', '等待分拣/受理来源补全。');
    base.holder = { side: 'unknown', carrier: null, team: null, shift: null, since: null, basis: '来源未读完' };
  } else {
    reason('no-physical-evidence', STATUS.MANUAL, '除票务签转外没有任何分拣或受理记录，无法确认行李位置。');
    gap('no-physical-evidence', 'sorting+receiving', '缺少原始条码的现场动作。');
    base.holder = { side: 'unknown', carrier: null, team: null, shift: null, since: null, basis: '无实体凭据' };
  }

  if (partialReports.length > 0 && !base.closed) {
    reason('manual-confirmation-incomplete', STATUS.CHECK, '现场退接/转交记录缺少双方签署，暂不能作为责任凭据。');
    gap('manual-confirmation-incomplete', 'manual', '需要补齐双边确认。');
  }

  if (effectiveAccepted) checkSigner(base, shiftState, transfer, effectiveAccepted);
  if (base.newTag && base.newTag === bag.originalTag) {
    reason('new-tag-equals-old', STATUS.CHECK, '新条码与原条码相同，可能是来源映射错误。');
  }

  // A signer or tag issue discovered after a READY decision reopens the item: it is no longer
  // safe to treat the handover as settled, and ground staff need the listed contacts.
  if (base.closed && base.status !== STATUS.READY) {
    base.closed = false;
    base.needsReconfirmation = true;
  }

  for (const entry of base.reasons) {
    if (severityRank(entry.severity) > severityRank(base.status)) base.status = entry.severity;
  }
  base.dependsOn = collectDependsOn({ transfer, ticket, lastAccepted: effectiveAccepted, lastRejected, loaded, manualResolved, lateBackfills });
  base.nextContacts = buildContacts({ shiftState, transfer, base, lastAccepted: effectiveAccepted, lastRejected, loaded, ticket });
  return finish(base, instructionLookup);
}

function finish(base, instructionLookup) {
  base.statusRank = severityRank(base.status);
  base.instruction = typeof instructionLookup === 'function' ? instructionLookup(base) : null;
  return base;
}

function baseBag({ transfer, bag, receiving, tickets, shiftState }) {
  return {
    transfer: transfer.transfer,
    traveller: transfer.traveller,
    segment: transfer.segment,
    originalTag: bag.originalTag,
    newTag: null,
    oldCarrier: transfer.oldCarrier,
    newCarrier: transfer.newCarrier,
    ticket: {
      available: tickets?.available !== false,
      state: transfer.ticket.state,
      active: transfer.ticket.active,
      withdrawn: transfer.ticket.withdrawn,
      notices: transfer.ticket.notices,
      withdrawnNotice: transfer.ticket.withdrawnNotice,
    },
    status: STATUS.READY,
    statusRank: 1,
    reasons: [],
    gaps: [],
    observations: [],
    dependsOn: [],
    nextContacts: [],
    holder: null,
    batch: null,
    chain: null,
    receivingRows: bag.receiving.map((row) => ({ ...row })),
    manualRows: bag.manual.map((row) => ({ ...row })),
    sortingRows: bag.sorting.map((row) => ({ ...row })),
    rescans: (bag.rescans ?? []).map((row) => ({ ...row })),
    receivingRescans: (bag.receivingRescans ?? []).map((row) => ({ ...row })),
    manualRescans: (bag.manualRescans ?? []).map((row) => ({ ...row })),
    hold: false,
    closed: false,
    resolution: null,
    shift: shiftState.public,
  };
}

function summarizeChains(receivingRows, sorting, originalTag) {
  const chains = new Map();
  function ensure(batch) {
    const key = batch ?? 'unassigned';
    if (!chains.has(key)) {
      chains.set(key, {
        id: stableKey([originalTag, batch ?? 'unassigned']),
        batch: batch ?? null,
        received: null,
        rejected: null,
        awaitingAt: null,
        status: 'unassigned',
      });
    }
    return chains.get(key);
  }
  for (const row of receivingRows) {
    const chain = ensure(row.batch ?? null);
    if (row.accepted) {
      if (!chain.received || (actionMs(row) ?? -Infinity) >= (actionMs(chain.received) ?? -Infinity)) chain.received = row;
    } else if (!chain.rejected || (actionMs(row) ?? -Infinity) >= (actionMs(chain.rejected) ?? -Infinity)) {
      chain.rejected = row;
    }
  }
  // Sorting does not name an acceptance batch; attach the latest awaiting scan to the latest chain
  // only, so it is not copied across chains.
  const latest = [...chains.values()].sort((a, b) => {
    const at = actionMs(a.received ?? a.rejected) ?? -Infinity;
    const bt = actionMs(b.received ?? b.rejected) ?? -Infinity;
    return at - bt;
  }).at(-1);
  if (latest) {
    const awaiting = sorting.filter((event) => HANDOFF_STATES.has(String(event.state)) || event.facility === 'transfer').at(-1);
    latest.awaitingAt = awaiting?.at ?? null;
  }
  for (const chain of chains.values()) {
    const receivedAt = actionMs(chain.received);
    const rejectedAt = actionMs(chain.rejected);
    if (chain.received && (!chain.rejected || (receivedAt ?? -Infinity) >= (rejectedAt ?? -Infinity))) chain.status = 'accepted';
    else if (chain.rejected) chain.status = 'rejected';
  }
  return [...chains.values()].sort((a, b) => {
    const at = actionMs(a.received ?? a.rejected) ?? -Infinity;
    const bt = actionMs(b.received ?? b.rejected) ?? -Infinity;
    return at - bt;
  });
}

function receivingState(receiving, batchId) {
  if (!receiving) return 'unavailable';
  if (receiving.available === false) return 'unavailable';
  const batches = receiving.batches ?? [];
  const relevant = batchId ? batches.filter((batch) => batch.batch === batchId) : batches;
  if (relevant.length === 0) {
    // The receiving page may be sitting on a different batch. That is not an empty batch.
    if (batchId && batches.length > 0) return 'batch-missing';
    if (receiving.empty === true) return receiving.complete === true ? 'empty-complete' : 'not-started';
    return relevant.length === 0 && receiving.empty === null ? 'unavailable' : 'empty-complete';
  }
  if (relevant.every((batch) => batch.empty)) {
    return relevant.every((batch) => batch.complete) ? 'empty-complete' : 'not-started';
  }
  if (relevant.every((batch) => batch.complete)) return 'omitted';
  return 'not-started';
}

function describeResolution(report) {
  return {
    type: report.type,
    typeLabel: report.type === 'return' ? '退接' : '转交',
    custodySide: report.type === 'return' ? 'old' : 'new',
    from: report.from,
    to: report.to,
    at: report.at,
    signers: [...report.acceptedBy],
    bilateral: true,
  };
}

function collectDependsOn({ transfer, ticket, lastAccepted, lastRejected, loaded, manualResolved, lateBackfills }) {
  const depends = [];
  for (const notice of ticket.notices) {
    depends.push({
      source: 'tickets',
      ref: `${transfer.transfer}@${notice.at ?? 'unknown'}`,
      summary: `票务 ${notice.state ?? 'unknown'}`,
      at: notice.at,
    });
  }
  if (lastAccepted) {
    depends.push({
      source: 'receiving',
      ref: `${lastAccepted.batch ?? '?'}/${lastAccepted.oldTag}`,
      summary: `受理收件，新条码 ${lastAccepted.newTag}，${lastAccepted.signedBy ?? '未署名'}`,
      at: lastAccepted.at,
    });
  }
  if (lastRejected) {
    depends.push({
      source: 'receiving',
      ref: `${lastRejected.batch ?? '?'}/${lastRejected.oldTag}`,
      summary: '受理拒收',
      at: lastRejected.at,
    });
  }
  if (loaded) {
    depends.push({
      source: 'sorting',
      ref: `${loaded.batch ?? '?'}/${loaded.tag}@${loaded.seq ?? '?'}`,
      summary: `分拣 ${loaded.state}`,
      at: loaded.at,
    });
  }
  for (const backfill of lateBackfills) {
    depends.push({
      source: 'sorting',
      ref: `${backfill.batch ?? '?'}/${backfill.tag}@${backfill.seq ?? '?'}`,
      summary: '晚到补传的待交运记录（未改变责任）',
      at: backfill.at,
      seen: backfill.seen,
    });
  }
  if (manualResolved) {
    depends.push({
      source: 'manual',
      ref: `${manualResolved.oldTag ?? '?'}@${manualResolved.at ?? 'unknown'}`,
      summary: `现场双边确认 ${manualResolved.type}：${manualResolved.from} → ${manualResolved.to}`,
      at: manualResolved.at,
    });
  }
  return depends;
}

function describeHolder(shiftState, carrier, since, basis) {
  const team = carrier ? shiftState.teamFor(carrier) : null;
  return {
    carrier: carrier ?? null,
    team: team?.team ?? null,
    shift: team?.shift ?? null,
    since: since ?? null,
    basis,
  };
}

// A bilateral report names the operating teams that actually signed, which may predate the
// current shift table. Prefer those names over guessing a carrier from the flight number.
function holderFromResolution(shiftState, transfer, resolution) {
  const carrier = resolution.custodySide === 'old' ? transfer.oldCarrier : transfer.newCarrier;
  // The receiving side of the report is the team that physically holds the bag afterwards.
  const namedTeam = resolution.to ?? (resolution.custodySide === 'old' ? resolution.from : resolution.to);
  const table = shiftState.teamFor(carrier);
  const team = namedTeam ?? table?.team ?? null;
  const matched = shiftState.teamForIncludingHistory(carrier).find((entry) => entry.team === team);
  const currentShift = shiftState.current?.shift ?? null;
  return {
    side: resolution.custodySide,
    carrier: carrier ?? null,
    team,
    shift: matched?.shift ?? currentShift,
    since: resolution.at ?? null,
    basis: `双边确认${resolution.typeLabel}（签署 ${resolution.signers.join('、')}）`,
  };
}

function holderFor(shiftState, transfer, side, since, basis) {
  if (side === 'old') return { side, ...describeHolder(shiftState, transfer.oldCarrier, since, basis) };
  if (side === 'new') return { side, ...describeHolder(shiftState, transfer.newCarrier, since, basis) };
  return { side: 'unknown', carrier: null, team: null, shift: null, since: since ?? null, basis };
}

function buildContacts({ shiftState, transfer, base, lastAccepted, lastRejected, loaded, ticket }) {
  const contacts = [];
  if (base.status === STATUS.READY && !base.hold) return contacts;
  const newTeam = shiftState.teamFor(transfer.newCarrier);
  const oldTeam = shiftState.teamFor(transfer.oldCarrier);
  const rampTeam = shiftState.teamFor('load-check');

  if (base.hold && loaded) {
    contacts.push({
      role: '停机坪/装载核对',
      team: rampTeam?.team ?? null,
      shift: rampTeam?.shift ?? null,
      reason: `确认 ${base.originalTag} 能否从 ${loaded.at ?? '原航班'} 装机状态抽回`,
      priority: 1,
    });
    contacts.push({
      role: '新航司受理台',
      team: newTeam?.team ?? null,
      shift: newTeam?.shift ?? null,
      reason: '确认是否收到本件或需拒收',
      priority: 2,
    });
  }
  if (base.reasons.some((entry) => entry.code.startsWith('withdrawn') || entry.code.startsWith('accepted-after'))) {
    contacts.push({
      role: '新航司收件台（现持有人）',
      team: newTeam?.team ?? null,
      shift: newTeam?.shift ?? null,
      reason: `核对新条码 ${base.newTag ?? '未分配'} 的实体凭据`,
      priority: 1,
    });
    contacts.push({
      role: '原航司地服（退接）',
      team: oldTeam?.team ?? null,
      shift: oldTeam?.shift ?? null,
      reason: '登记两边确认的退接或转交事实',
      priority: 2,
    });
  }
  if (lastRejected) {
    contacts.push({
      role: '新航司受理台',
      team: newTeam?.team ?? null,
      shift: newTeam?.shift ?? null,
      reason: `核实 ${lastRejected.at} 拒收原因及重新交运条件`,
      priority: 1,
    });
    contacts.push({
      role: '原航司分拣区',
      team: oldTeam?.team ?? null,
      shift: oldTeam?.shift ?? null,
      reason: '确认拒收行李仍在原分拣区',
      priority: 2,
    });
  }
  if (!lastAccepted && !lastRejected && !base.hold && !ticket.withdrawn) {
    contacts.push({
      role: '新航司受理台',
      team: newTeam?.team ?? null,
      shift: newTeam?.shift ?? null,
      reason: '开立/补齐逐件收件记录',
      priority: 1,
    });
    contacts.push({
      role: '原航司分拣区',
      team: oldTeam?.team ?? null,
      shift: oldTeam?.shift ?? null,
      reason: '确认待交运扫描与实物',
      priority: 2,
    });
  }
  if (ticket.withdrawn && !lastAccepted) {
    contacts.push({
      role: '原航司分拣区',
      team: oldTeam?.team ?? null,
      shift: oldTeam?.shift ?? null,
      reason: '确认撤销后行李留运或改配',
      priority: 1,
    });
  }
  if (base.reasons.some((entry) => entry.code === 'ticket-notice-missing')) {
    contacts.push({
      role: '票务',
      team: null,
      shift: null,
      reason: '补发或核对签转号',
      priority: 1,
    });
  }
  if (base.reasons.some((entry) => entry.code === 'signer-team-mismatch')) {
    contacts.push({
      role: '新航司受理台',
      team: newTeam?.team ?? null,
      shift: newTeam?.shift ?? null,
      reason: '核对签收人与班组登记',
      priority: 1,
    });
  }
  if (base.reasons.some((entry) => entry.code === 'new-tag-equals-old' || entry.code === 'new-tag-missing')) {
    contacts.push({
      role: '新航司受理台',
      team: newTeam?.team ?? null,
      shift: newTeam?.shift ?? null,
      reason: '核对新条码映射',
      priority: 2,
    });
  }
  if (base.reasons.some((entry) => entry.code === 'ticket-state-unrecognized')) {
    contacts.push({ role: '票务', team: null, shift: null, reason: '确认当前签转状态', priority: 1 });
  }
  return dedupeContacts(contacts);
}

function dedupeContacts(contacts) {
  const seen = new Set();
  return contacts
    .sort((a, b) => a.priority - b.priority)
    .filter((contact) => {
      const key = stableKey([contact.role, contact.team]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ priority, ...rest }) => rest);
}

function checkSigner(base, shiftState, transfer, row) {
  if (!row.signedBy) {
    base.observations.push({ code: 'signer-missing', text: `受理批次 ${row.batch ?? '?'} 没有签收人。` });
    return;
  }
  const expected = shiftState.teamFor(transfer.newCarrier);
  if (!expected?.team) return;
  if (expected.team !== row.signedBy) {
    const historical = shiftState.teamForIncludingHistory(transfer.newCarrier);
    const matchedHistory = historical.find((entry) => entry.team === row.signedBy);
    base.observations.push({
      code: matchedHistory ? 'signer-prior-shift' : 'signer-team-mismatch',
      text: matchedHistory
        ? `签收人 ${row.signedBy} 属 ${matchedHistory.shift} 班次，当前班次对应 ${expected.team}；实体签收仍有效，后续由当前班次跟踪。`
        : `签收人 ${row.signedBy} 不是当前班次为该承运人登记的团队（${expected.team}），需要核对。`,
    });
    if (!matchedHistory) {
      base.gaps.push({ code: 'signer-team-mismatch', source: 'receiving+shifts', text: `签收人 ${row.signedBy} 与班次联系人表不一致。` });
      if (base.status === STATUS.READY) {
        base.status = STATUS.CHECK;
        base.reasons.push({
          code: 'signer-team-mismatch',
          severity: STATUS.CHECK,
          text: `收件签收人 ${row.signedBy} 与班次表登记的 ${expected.team} 不一致，收件凭据需要确认。`,
        });
      }
    }
  }
}

function checkFacilitySequences(base, sorting) {
  const byFacility = new Map();
  for (const event of sorting) {
    const facility = event.facility ?? 'unknown';
    if (!byFacility.has(facility)) byFacility.set(facility, []);
    byFacility.get(facility).push(event);
  }
  for (const [facility, events] of byFacility) {
    const withSeq = events.filter((event) => event.seq != null && actionMs(event) != null);
    if (withSeq.length < 2) continue;
    const bySeq = [...withSeq].sort((a, b) => Number(a.seq) - Number(b.seq));
    for (let index = 1; index < bySeq.length; index += 1) {
      if (actionMs(bySeq[index]) < actionMs(bySeq[index - 1])) {
        base.observations.push({
          code: 'facility-seq-time-conflict',
          text: `${facility} 分拣点序号 ${bySeq[index - 1].seq} → ${bySeq[index].seq} 与现场动作时间顺序不一致；按动作时间解释，序号只在各分拣点内部递增。`,
        });
        break;
      }
    }
  }
}

function resolveShifts(shifts) {
  const normalized = (Array.isArray(shifts) ? shifts : [])
    .filter((shift) => shift && shift.shift)
    .map((shift, index) => ({
      shift: shift.shift,
      replaces: shift.replaces ?? null,
      at: shift.at ?? null,
      seen: shift.seen ?? null,
      teams: shift.teams ?? {},
      order: index,
    }))
    .sort((a, b) => {
      const at = normalizeTime(a.at).ms;
      const bt = normalizeTime(b.at).ms;
      if (at != null && bt != null) return at - bt;
      return a.order - b.order;
    });
  const current = normalized.at(-1) ?? null;
  const all = normalized.map(({ order, ...rest }) => rest);
  const publicShift = current
    ? { shift: current.shift, replaces: current.replaces, at: current.at, teams: current.teams }
    : { shift: null, teams: {} };

  function teamFor(carrier) {
    if (!carrier) return null;
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const shift = normalized[index];
      const team = shift.teams?.[carrier] ?? shift.teams?.[carrierFromFlight(carrier) ?? carrier];
      if (team) return { team, shift: shift.shift };
    }
    return null;
  }
  function teamForIncludingHistory(carrier) {
    const found = [];
    for (const shift of normalized) {
      const team = shift.teams?.[carrier];
      if (team) found.push({ team, shift: shift.shift });
    }
    return found;
  }
  return { public: publicShift, all, current, teamFor, teamForIncludingHistory };
}

function groupTravellers(bags) {
  const groups = new Map();
  for (const bag of bags) {
    const key = stableKey([bag.traveller, bag.segment]);
    if (!groups.has(key)) {
      groups.set(key, {
        traveller: bag.traveller,
        segment: bag.segment,
        bags: [],
      });
    }
    groups.get(key).bags.push(bag);
  }
  for (const group of groups.values()) {
    group.bags.sort((a, b) => String(a.originalTag ?? '').localeCompare(String(b.originalTag ?? '')));
    group.status = group.bags.reduce(
      (acc, bag) => (severityRank(bag.status) > severityRank(acc) ? bag.status : acc),
      STATUS.READY,
    );
  }
  return [...groups.values()].sort((a, b) => {
    const traveller = String(a.traveller ?? '').localeCompare(String(b.traveller ?? ''));
    return traveller !== 0 ? traveller : String(a.segment ?? '').localeCompare(String(b.segment ?? ''));
  });
}
