import type { ClientMessage } from '../shared/protocol.js';

// Messages a board page or a paired phone sends over its WebSocket

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (typeof m.id !== 'string') return null;
  switch (m.type) {
    case 'attach':
    case 'detach':
      return { type: m.type, id: m.id };
    case 'input':
      return typeof m.data === 'string' ? { type: 'input', id: m.id, data: m.data } : null;
    case 'resize':
      return isFiniteNumber(m.cols) && isFiniteNumber(m.rows)
        ? { type: 'resize', id: m.id, cols: m.cols, rows: m.rows }
        : null;
    default:
      return null;
  }
}
