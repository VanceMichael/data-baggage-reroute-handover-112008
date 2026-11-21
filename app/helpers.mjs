// Pure helpers shared by the collector, evaluator and HTTP layer.
// Source payloads are never rewritten in place; codes are normalized for comparison only.

export const STATUS = Object.freeze({
  READY: '可交接',
  CHECK: '待确认',
  MANUAL: '必须人工处理',
});

export const ACTIVE_TICKET_STATES = new Set(['confirmed', 'reopened', 'reissued', 'active']);
export const WITHDRAWN_TICKET_STATES = new Set(['withdrawn', 'cancelled', 'canceled', 'void']);

export function normalizeTag(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function normalizeTime(value) {
  if (value == null || value === '') return { raw: null, ms: null };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { raw: new Date(value).toISOString(), ms: value };
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? { raw: String(value), ms: null } : { raw: String(value), ms };
}

export function actionMs(record) {
  const at = normalizeTime(record?.at);
  if (at.ms != null) return at.ms;
  return normalizeTime(record?.seen).ms;
}

export function seenMs(record) {
  return normalizeTime(record?.seen).ms ?? normalizeTime(record?.at).ms;
}

export function carrierFromFlight(flight) {
  if (typeof flight !== 'string') return null;
  const trimmed = flight.trim();
  if (trimmed === '') return null;
  const dash = trimmed.indexOf('-');
  return dash === -1 ? trimmed : trimmed.slice(0, dash);
}

export function oldCarrierOf(record) {
  return record?.oldCarrier ?? carrierFromFlight(record?.old);
}

export function newCarrierOf(record) {
  return record?.newCarrier ?? carrierFromFlight(record?.new);
}

export function ticketActive(state) {
  return ACTIVE_TICKET_STATES.has(String(state ?? '').toLowerCase());
}

export function ticketWithdrawn(state) {
  return WITHDRAWN_TICKET_STATES.has(String(state ?? '').toLowerCase());
}

export function compareAction(a, b) {
  const am = actionMs(a);
  const bm = actionMs(b);
  if (am == null && bm == null) return 0;
  if (am == null) return -1;
  if (bm == null) return 1;
  return am - bm;
}

export function stableKey(parts) {
  return parts.map((part) => (part == null ? '' : String(part))).join('\u001f');
}

export function dedupeByKey(records, keyOf) {
  const map = new Map();
  const duplicates = [];
  for (const record of records) {
    const key = keyOf(record);
    const first = map.get(key);
    if (!first) {
      map.set(key, { ...record, retransmissions: [] });
      continue;
    }
    // A re-transmission collected later is still one physical action. Keep it as a re-scan
    // marker rather than letting it count twice.
    const laterCollection = (seenMs(record) ?? -Infinity) > (seenMs(first) ?? -Infinity);
    if (laterCollection && record.seen) first.retransmissions.push({ seen: record.seen, at: record.at ?? null });
    duplicates.push({ record, original: first, laterCollection });
  }
  return { unique: [...map.values()], duplicates };
}

export function sortByAction(records) {
  return [...records].sort((a, b) => {
    const diff = compareAction(a, b);
    return diff === 0 ? 0 : diff;
  });
}

export function severityRank(status) {
  if (status === STATUS.MANUAL) return 3;
  if (status === STATUS.CHECK) return 2;
  return 1;
}

