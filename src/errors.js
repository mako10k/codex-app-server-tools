// R: Represent bounded, machine-readable failures without leaking backend payloads.
export class WatchError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
export function errorResult(error) {
  return { code: error.code ?? 'INTERNAL_ERROR', message: error.message ?? 'Unexpected failure', ...(error.details ? { details: error.details } : {}) };
}
export function requireValue(condition, code, message) { if (!condition) throw new WatchError(code, message); }
