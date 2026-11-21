// Builds per-transfer, per-bag evidence sets from collected sources.
// Time is only ever compared within one bracket: transfer + original tag + actionable time.
// Nothing here merges by flight number alone, by surname, or by a new ticket tag.

import {
  stableKey,
  dedupeByKey,
  sortByAction,
  actionMs,
  oldCarrierOf,
  newCarrierOf,
  ticketActive,
  ticketWithdrawn,
} from './helpers.mjs';

export function buildEvidence({ tickets, sorting, receiving, manual, shifts, knownIdentities }) {
  const ticketNotices = Array.isArray(tickets?.records) ? tickets.records : [];
  const sortEntries = Array.isArray(sorting?.entries) ? sorting.entries : [];
  const receivingRows = Array.isArray(receiving?.rows) ? receiving.rows : [];
  const manualReports = Array.isArray(manual?.reports) ? manual.reports : [];

  const transfers = new Map();

  function ensureTransfer(transferId) {
    if (!transferId) return null;
    if (!transfers.has(transferId)) {
      transfers.set(transferId, {
        transfer: transferId,
        traveller: null,
        segment: null,
        oldCarrier: null,
        newCarrier: null,
        ticket: {
          available: tickets?.available !== false,
          notices: [],
          state: null,
          withdrawn: false,
          active: false,
          acceptedNotice: null,
          withdrawnNotice: null,
          conflicts: [],
        },
        bags: new Map(),
      });
    }
    return transfers.get(transferId);
  }

  // --- Ticket notices -------------------------------------------------------
  for (const notice of ticketNotices) {
    const transfer = ensureTransfer(notice.transfer);
    if (!transfer) continue;
    if (notice.traveller != null) transfer.traveller = notice.traveller;
    if (notice.segment != null) transfer.segment = notice.segment;
    // Carrier identity is immutable. Later notices (withdrawals) may omit flight numbers, so a
    // previously learned identity may fill the gap without touching ticket state.
    const known = knownIdentities?.get?.(notice.transfer) ?? null;
    transfer.oldCarrier ??= oldCarrierOf(notice) ?? known?.oldCarrier ?? null;
    transfer.newCarrier ??= newCarrierOf(notice) ?? known?.newCarrier ?? null;
    transfer.traveller ??= known?.traveller ?? null;
    transfer.segment ??= known?.segment ?? null;
    const state = String(notice.state ?? '').toLowerCase();
    const normalized = {
      state: notice.state ?? null,
      at: notice.at ?? null,
      seen: notice.seen ?? null,
      traveller: notice.traveller ?? null,
      segment: notice.segment ?? null,
      old: notice.old ?? null,
      new: notice.new ?? null,
      oldCarrier: oldCarrierOf(notice),
      newCarrier: newCarrierOf(notice),
      withdrawn: ticketWithdrawn(state),
      active: ticketActive(state),
    };
    transfer.ticket.notices.push(normalized);
  }

  // Withdrawn vs (re)confirmed is resolved per transfer, using the actionable time of each notice.
  // A later confirmation re-opens; a later withdrawal closes. Equal times are a conflict.
  for (const transfer of transfers.values()) {
    const notices = sortByAction(transfer.ticket.notices);
    let current = null;
    for (const notice of notices) {
      if (!notice.active && !notice.withdrawn) continue;
      if (!current) {
        current = notice;
        continue;
      }
      const currentAt = actionMs(current);
      const nextAt = actionMs(notice);
      if (currentAt != null && nextAt != null && currentAt === nextAt) {
        if (current.withdrawn !== notice.withdrawn) {
          transfer.ticket.conflicts.push({ kind: 'ticket-same-time-conflict', at: notice.at ?? null });
        }
        current = notice;
      } else {
        current = notice;
      }
    }
    transfer.ticket.state = current?.state ?? null;
    transfer.ticket.withdrawn = current?.withdrawn === true;
    transfer.ticket.active = current?.active === true && !transfer.ticket.withdrawn;
    transfer.ticket.acceptedNotice = [...notices].reverse().find((notice) => notice.active) ?? null;
    transfer.ticket.withdrawnNotice = [...notices].reverse().find((notice) => notice.withdrawn) ?? null;
    if (transfer.ticket.withdrawn && transfer.ticket.acceptedNotice) {
      const withdrawnAt = actionMs(transfer.ticket.withdrawnNotice);
      const acceptedAt = actionMs(transfer.ticket.acceptedNotice);
      if (withdrawnAt != null && acceptedAt != null && withdrawnAt >= acceptedAt) {
        transfer.ticket.active = false;
      }
    }
  }

  // --- Receiving rows -------------------------------------------------------
  // A row is keyed by transfer + old tag. New tags are recorded, never used as the original key.
  for (const row of receivingRows) {
    if (!row.transfer || !row.oldTag) continue;
    const transfer = ensureTransfer(row.transfer);
    if (!transfer) continue;
    const bag = ensureBag(transfer, row.oldTag);
    bag.receiving.push({
      batch: row.batch ?? null,
      oldTag: row.oldTag,
      newTag: row.newTag ?? null,
      accepted: row.accepted === true,
      at: row.at ?? null,
      signedBy: row.signedBy ?? null,
      seen: row.seen ?? null,
      source: 'receiving',
    });
  }

  // --- Sorting entries ------------------------------------------------------
  // Index transfers by traveller+segment once; matching per scan against every transfer is
  // quadratic and the source can publish hundreds of scans.
  const sortToTransfer = new Map();
  const transfersByTravellerSegment = new Map();
  for (const transfer of transfers.values()) {
    const key = stableKey([transfer.traveller, transfer.segment]);
    if (!transfersByTravellerSegment.has(key)) transfersByTravellerSegment.set(key, []);
    transfersByTravellerSegment.get(key).push(transfer);
  }

  for (const entry of sortEntries) {
    if (!entry.tag) continue;
    const match = matchSortingToTransfer(transfersByTravellerSegment, entry);
    if (!match) continue;
    if (!sortToTransfer.has(entry.tag)) sortToTransfer.set(entry.tag, new Set());
    sortToTransfer.get(entry.tag).add(match.transfer);
  }
  // A tag that maps to more than one transfer is left unattributed rather than guessed.
  const ambiguousTags = new Set();
  for (const [tag, ids] of sortToTransfer) {
    if (ids.size !== 1) ambiguousTags.add(tag);
  }

  for (const entry of sortEntries) {
    if (!entry.tag) continue;
    if (ambiguousTags.has(entry.tag)) continue;
    const ids = sortToTransfer.get(entry.tag);
    if (!ids) continue;
    const transfer = transfers.get([...ids][0]);
    if (!transfer) continue;
    const bag = ensureBag(transfer, entry.tag);
    bag.sorting.push({
      tag: entry.tag,
      facility: entry.facility ?? null,
      state: entry.state ?? null,
      seq: entry.seq ?? null,
      at: entry.at ?? null,
      seen: entry.seen ?? null,
      batch: entry.batch ?? null,
      page: entry.page ?? null,
    });
  }

  // --- Manual reports -------------------------------------------------------
  for (const report of manualReports) {
    const ids = new Set();
    if (report.transfer) ids.add(report.transfer);
    if (!report.transfer && report.originalTag) {
      for (const [tag, candidate] of sortToTransfer) {
        if (tag !== report.originalTag) continue;
        for (const id of candidate) ids.add(id);
      }
    }
    for (const id of ids) {
      const transfer = transfers.get(id);
      if (!transfer) continue;
      const bag = report.originalTag ? ensureBag(transfer, report.originalTag) : null;
      const record = {
        oldTag: report.originalTag ?? null,
        from: report.from ?? null,
        to: report.to ?? null,
        type: report.type ?? null,
        acceptedBy: Array.isArray(report.acceptedBy) ? [...report.acceptedBy] : [],
        at: report.at ?? null,
        seen: report.seen ?? null,
      };
      if (bag) bag.manual.push(record);
      else (transfer.unbaggedManual ??= []).push(record);
    }
  }

  // --- Duplicate scans ------------------------------------------------------
  for (const transfer of transfers.values()) {
    for (const bag of transfer.bags.values()) {
      const { unique, duplicates } = dedupeByKey(
        bag.sorting,
        (entry) => stableKey([entry.tag, entry.facility, entry.state, entry.seq, entry.at]),
      );
      bag.sorting = sortByAction(unique);
      bag.rescans = duplicates.map(({ record }) => ({
        tag: record.tag,
        state: record.state,
        at: record.at ?? null,
        seen: record.seen ?? null,
      }));
      const receiving = dedupeByKey(
        bag.receiving,
        (row) => stableKey([row.batch, row.oldTag, row.newTag, row.accepted, row.at, row.signedBy]),
      );
      bag.receiving = sortByAction(receiving.unique);
      bag.receivingRescans = receiving.duplicates.map(({ record }) => ({ batch: record.batch, at: record.at ?? null, seen: record.seen ?? null }));
      const manuals = dedupeByKey(
        bag.manual,
        (report) => stableKey([report.oldTag, report.type, report.from, report.to, [...report.acceptedBy].sort(), report.at]),
      );
      bag.manual = sortByAction(manuals.unique);
      bag.manualRescans = manuals.duplicates.map(({ record }) => ({ at: record.at ?? null, seen: record.seen ?? null }));
    }
  }

  return { transfers, shifts: Array.isArray(shifts?.shifts) ? shifts.shifts : [] };
}

function matchSortingToTransfer(transfersByTravellerSegment, entry) {
  if (!entry.segment || entry.traveller == null) return null;
  const exact = transfersByTravellerSegment.get(stableKey([entry.traveller, entry.segment])) ?? [];
  return exact.length === 1 ? exact[0] : null;
}

function ensureBag(transfer, tag) {
  if (!tag) return null;
  if (!transfer.bags.has(tag)) {
    transfer.bags.set(tag, {
      originalTag: tag,
      sorting: [],
      receiving: [],
      manual: [],
      rescans: [],
    });
  }
  return transfer.bags.get(tag);
}
