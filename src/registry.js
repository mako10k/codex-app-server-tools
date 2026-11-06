// R: Own durable watch definitions and delivery attempts with atomic, DAG-checked updates.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { WatchError, requireValue } from './errors.js';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export function threadId(value, field) {
  requireValue(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} must be a nonempty thread ID (maximum 160 characters).`);
  return value;
}
export function validateDefinition(input, old) {
  const allowed = new Set(['action', 'watch_id', 'caller_thread_id', 'source_thread_id', 'destination_thread_id', 'message', 'delivery', 'check_interval_seconds','events','expected_generation','suppress_self']);
  for (const key of Object.keys(input)) requireValue(allowed.has(key), 'INVALID_ARGUMENT', `Unknown field: ${key}`);
  if(input.expected_generation!==undefined)requireValue(old&&input.expected_generation===old.generation,'GENERATION_CONFLICT','Watch generation changed.');
  const events=input.events??old?.events;
  if(events!==undefined)requireValue(Array.isArray(events)&&events.length>0&&new Set(events).size===events.length&&events.every(x=>['turn_ended','compaction_started','compaction_completed','goal_updated','goal_cleared','user_prompt'].includes(x)),'INVALID_ARGUMENT','Invalid watch events.');
  if(input.suppress_self!==undefined)requireValue(typeof input.suppress_self==='boolean','INVALID_ARGUMENT','suppress_self must be boolean.');
  const suppression=input.suppress_self??old?.suppress_self;
  const owner = threadId(input.caller_thread_id, 'caller_thread_id');
  if (old) requireValue(owner === old.owner_thread_id, 'OWNER_MISMATCH', 'Only the original registering thread may update this watch.');
  const source = threadId(input.source_thread_id ?? old?.source_thread_id, 'source_thread_id');
  const destination = threadId(input.destination_thread_id ?? old?.destination_thread_id ?? owner, 'destination_thread_id');
  requireValue(source !== destination, 'DAG_CYCLE', 'A source-to-destination self edge would create a notification loop.');
  const delivery = input.delivery ?? old?.delivery ?? 'wake';
  requireValue(delivery === 'wake' || delivery === 'message', 'INVALID_ARGUMENT', 'delivery must be wake or message.');
  const message = input.message ?? old?.message ?? 'Thread-watch: inspect the observed thread and the registered work agreement.';
  requireValue(typeof message === 'string' && message.length > 0 && Buffer.byteLength(message) <= 32768, 'INVALID_ARGUMENT', 'message must contain 1–32768 UTF-8 bytes.');
  const interval = input.check_interval_seconds !== undefined ? input.check_interval_seconds : (old?.check_interval_seconds ?? null);
  requireValue(interval === null, 'TIMER_REMOVED', 'Timers are not implemented. Omit check_interval_seconds or set it to null.');
  return { ...(events?{events}:{}), ...(suppression!==undefined?{suppress_self:suppression}:{}), watch_id: old?.watch_id ?? randomUUID(), owner_thread_id: owner, source_thread_id: source, destination_thread_id: destination, message, delivery, check_interval_seconds: null, generation: (old?.generation ?? 0) + 1 };
}
export function assertDag(watches) {
  const graph = new Map();
  for (const w of watches) { if (!graph.has(w.source_thread_id)) graph.set(w.source_thread_id, []); graph.get(w.source_thread_id).push(w.destination_thread_id); }
  const visiting = new Set(), done = new Set();
  function visit(node) {
    if (visiting.has(node)) throw new WatchError('DAG_CYCLE', 'The source-to-destination notification graph must remain acyclic.');
    if (done.has(node)) return;
    visiting.add(node); for (const child of graph.get(node) ?? []) visit(child); visiting.delete(node); done.add(node);
  }
  for (const node of graph.keys()) visit(node);
}
export class Registry {
  constructor(file) { this.file = file; this.state = { schema_version: 1, revision: 0, watches: [], attempts: [] }; this.tail = Promise.resolve(); }
  async load() {
    try {
      const state = JSON.parse(await readFile(this.file, 'utf8'));
      requireValue(state.schema_version === 1 && Number.isSafeInteger(state.revision) && Array.isArray(state.watches) && Array.isArray(state.attempts), 'REGISTRY_INVALID', 'Unsupported or malformed registry.');
      assertDag(state.watches); this.state = state;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  transaction(fn) {
    const run = this.tail.then(async () => {
      const next = structuredClone(this.state); const result = await fn(next);
      next.revision++; await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }); await rename(tmp, this.file); this.state = next; return result;
    });
    this.tail = run.catch(() => {}); return run;
  }
  list() { return structuredClone(this.state.watches); }
  get(id) { return structuredClone(this.state.watches.find(w => w.watch_id === id)); }
  async upsert(input, binding) {
    return this.transaction(state => {
      const old = input.watch_id ? state.watches.find(w => w.watch_id === input.watch_id) : undefined;
      if (input.watch_id && !old) throw new WatchError('WATCH_NOT_FOUND', 'The requested watch does not exist.');
      const next = validateDefinition(input, old);
      const watches = state.watches.filter(w => w.watch_id !== next.watch_id); watches.push(next); assertDag(watches); state.watches = watches; if (binding) Object.assign(state,binding); return next;
    });
  }
  async remove(input) {
    threadId(input.caller_thread_id, 'caller_thread_id'); threadId(input.watch_id, 'watch_id');
    for (const key of Object.keys(input)) requireValue(['action','watch_id','caller_thread_id'].includes(key), 'INVALID_ARGUMENT', `Unknown field: ${key}`);
    return this.transaction(state => {
      const old = state.watches.find(w => w.watch_id === input.watch_id);
      requireValue(old, 'WATCH_NOT_FOUND', 'The requested watch does not exist.');
      requireValue(old.owner_thread_id === input.caller_thread_id, 'OWNER_MISMATCH', 'Only the original registering thread may remove this watch.');
      state.watches = state.watches.filter(w => w.watch_id !== old.watch_id); return old;
    });
  }
  watchers(source) { threadId(source, 'thread_id'); return this.list().filter(w => w.source_thread_id === source); }
  async attemptOnce(key, watch, event) {
    return this.transaction(state => {
      if (!state.watches.some(w => w.watch_id === watch.watch_id && w.generation === watch.generation)) return false;
      if (state.attempts.some(a => a.key === key)) return false;
      state.attempts.push({ key, watch_id: watch.watch_id, generation: watch.generation, event, status: 'pending', created_at: new Date().toISOString() }); return true;
    });
  }
  async finishAttempt(key, status, error, suppression) {
    return this.transaction(state => { const a = state.attempts.find(a => a.key === key); if (a) { a.status = status; a.finished_at = new Date().toISOString(); if (error) a.error = error; if (suppression) a.suppression = suppression; } });
  }
}
