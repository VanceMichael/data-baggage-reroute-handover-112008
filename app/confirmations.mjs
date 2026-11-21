// Ground-staff registrations of bilateral physical facts.
// These are not booking changes and not loading orders; they record that both sides confirmed
// a return or a transfer of one specific original tag in one acceptance chain.

import { normalizeTag } from './helpers.mjs';

export class ConfirmationError extends Error {
  constructor(message, { status = 400, code = 'confirmation-error' } = {}) {
    super(message);
    this.name = 'ConfirmationError';
    this.status = status;
    this.code = code;
  }
}

const TYPES = new Map([
  ['return', '退接'],
  ['transfer', '转交'],
  ['handover', '转交'],
]);

/**
 * Validates a registration. The registrant must name both the giving and the receiving side and
 * both must appear in `acceptedBy`; a one-sided note is not a custody change.
 */
export function validateConfirmation(input, { bag, shift } = {}) {
  if (!bag) throw new ConfirmationError('找不到对应行李', { status: 404, code: 'bag-not-found' });
  const type = TYPES.has(String(input.type)) ? String(input.type) : null;
  if (!type) throw new ConfirmationError('登记类型只能是退接（return）或转交（transfer）', { code: 'type-required' });
  const from = normalizeTag(input.from);
  const to = normalizeTag(input.to);
  if (!from || !to) throw new ConfirmationError('退接/转交必须写明双方', { code: 'both-sides-required' });
  const acceptedBy = Array.isArray(input.acceptedBy)
    ? input.acceptedBy.map((value) => normalizeTag(value)).filter(Boolean)
    : [];
  const signers = new Set(acceptedBy);
  if (signers.size < 2 || !signers.has(from) || !signers.has(to)) {
    throw new ConfirmationError('需要交接双方都确认：acceptedBy 必须包含 from 与 to', {
      status: 409,
      code: 'bilateral-required',
    });
  }
  if (!input.operator) throw new ConfirmationError('需要登记经办人', { code: 'operator-required' });
  return {
    transfer: bag.transfer,
    originalTag: bag.originalTag,
    type,
    from,
    to,
    acceptedBy,
    at: input.at ?? new Date().toISOString(),
    operator: input.operator,
    shift: input.shift ?? shift ?? null,
    note: input.note ?? null,
    chain: { id: bag.chain?.id ?? null, batch: bag.chain?.batch ?? bag.batch ?? null },
  };
}

export function createConfirmations({ now = () => new Date().toISOString() } = {}) {
  const records = [];
  const events = [];
  let tick = 0;

  return {
    list() {
      return records.map((record) => ({ ...record }));
    },
    forBag(transfer, tag) {
      return records.filter((record) => record.transfer === transfer && record.originalTag === tag);
    },
    events() {
      return [...events];
    },
    register(input, context = {}) {
      const validated = validateConfirmation({ ...input, at: input.at ?? now() }, context);
      const record = {
        id: `C${++tick}`,
        ...validated,
        registeredAt: now(),
        ...(context.bag?.chain?.batch ? { batch: context.bag.chain.batch } : {}),
      };
      records.push(record);
      events.push({ at: record.registeredAt, action: 'confirmation-registered', id: record.id, detail: record });
      return record;
    },
  };
}

/** Converts local registrations into the same row shape the source manual report uses. */
export function asManualRows(records) {
  return records.map((record) => ({
    transfer: record.transfer,
    originalTag: record.originalTag,
    from: record.from,
    to: record.to,
    type: record.type,
    acceptedBy: [...record.acceptedBy],
    at: record.at,
    seen: record.registeredAt,
    registeredBy: record.operator,
    registeredShift: record.shift,
    local: true,
  }));
}
