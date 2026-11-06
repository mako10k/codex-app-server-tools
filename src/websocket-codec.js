// R: Encode and decode bounded RFC 6455 messages independently of the stream transport.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TextDecoder } from 'node:util';
import { WatchError } from './errors.js';
const LIMIT = 16 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
export function encodeFrame(opcode, payload, masked = true, fin = true) {
  payload = Buffer.from(payload); const length = payload.length;
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (masked ? 4 : 0)); header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = (masked ? 0x80 : 0) | (extra === 0 ? length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(length, 2); if (extra === 8) header.writeBigUInt64BE(BigInt(length), 2);
  if (!masked) return Buffer.concat([header, payload]);
  const key = randomBytes(4); key.copy(header, 2 + extra); const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4]; return Buffer.concat([header, body]);
}
export class FrameDecoder extends EventEmitter {
  constructor({ expectMasked = false, limit = LIMIT } = {}) { super(); this.buffer = Buffer.alloc(0); this.fragments = []; this.total = 0; this.opcode = null; this.expectMasked = expectMasked; this.limit = limit; }
  feed(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 2) {
      const b = this.buffer, fin = Boolean(b[0] & 0x80), opcode = b[0] & 15, masked = Boolean(b[1] & 0x80);
      if ((b[0] & 0x70) || masked !== this.expectMasked) throw new WatchError('WS_PROTOCOL', 'Unsupported WebSocket flags or masking.');
      let length = b[1] & 127, offset = 2;
      if (length === 126) { if (b.length < 4) return; length = b.readUInt16BE(2); offset = 4; if (length < 126) throw new WatchError('WS_PROTOCOL','Non-minimal frame length.'); }
      else if (length === 127) { if (b.length < 10) return; const n = b.readBigUInt64BE(2); if (n > BigInt(this.limit) || n < 65536n) throw new WatchError('WS_LIMIT','Invalid or oversized frame.'); length = Number(n); offset = 10; }
      if (length > this.limit || this.total + length > this.limit) throw new WatchError('WS_LIMIT','WebSocket message exceeds the configured limit.');
      if (opcode >= 8 && (!fin || length > 125)) throw new WatchError('WS_PROTOCOL','Invalid control frame.');
      const maskOffset = offset; if (masked) offset += 4;
      if (b.length < offset + length) return;
      const payload = Buffer.from(b.subarray(offset, offset + length));
      if (masked) for (let i=0;i<payload.length;i++) payload[i] ^= b[maskOffset + i % 4];
      this.buffer = b.subarray(offset + length);
      if (opcode === 8) {
        if (length === 1) throw new WatchError('WS_PROTOCOL','Invalid close payload.');
        if (length >= 2) utf8.decode(payload.subarray(2)); this.emit('close',payload); return;
      }
      if (opcode === 9 || opcode === 10) { this.emit(opcode === 9 ? 'ping':'pong', payload); continue; }
      if (opcode === 1) { if (this.opcode !== null) throw new WatchError('WS_PROTOCOL','Nested fragmented message.'); this.opcode = opcode; }
      else if (opcode !== 0 || this.opcode === null) throw new WatchError('WS_PROTOCOL','Unsupported message opcode.');
      this.fragments.push(payload); this.total += length;
      if (fin) { const message = Buffer.concat(this.fragments); this.fragments=[];this.total=0;this.opcode=null;this.emit('message',utf8.decode(message)); }
    }
  }
}
