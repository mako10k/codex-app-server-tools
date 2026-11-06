// R: Establish a bounded WebSocket session over a same-user Unix socket.
import net from 'node:net';
import {stat} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {WatchError} from './errors.js';
import {FrameDecoder,encodeFrame} from './websocket-codec.js';
export {FrameDecoder,encodeFrame} from './websocket-codec.js';
export class UnixWebSocket extends EventEmitter {
  constructor(path, { timeout = 10000 } = {}) { super(); this.path=path; this.timeout=timeout; this.open=false; }
  async connect() {
    let metadata;try{metadata=await stat(this.path);}catch(e){throw new WatchError('BACKEND_UNAVAILABLE','Cannot inspect App Server socket.',{socket_path:this.path,system_code:e.code??null});}
    if(!metadata.isSocket()||metadata.uid!==process.getuid())throw new WatchError('BACKEND_SOCKET_IDENTITY','App Server endpoint must be a Unix socket owned by the current user.');
    const key=randomBytes(16).toString('base64'), expected=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const decoder=new FrameDecoder(); this.decoder=decoder;
    decoder.on('message',m=>this.emit('message',m));decoder.on('ping',p=>this.socket?.write(encodeFrame(10,p)));
    decoder.on('close',p=>{ if(this.open)this.socket.write(encodeFrame(8,p));this.socket.end(); });
    return new Promise((resolve,reject)=>{
      let header=Buffer.alloc(0),settled=false;
      const socket=net.createConnection(this.path);this.socket=socket;
      const timer=setTimeout(()=>fail(new WatchError('BACKEND_TIMEOUT','App-server WebSocket upgrade timed out.')),this.timeout);
      const fail=e=>{ if(!settled){settled=true;clearTimeout(timer);reject(e);} socket.destroy(); };
      socket.on('connect',()=>socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
      socket.on('data',data=>{try{
        if(!this.open){header=Buffer.concat([header,data]);if(header.length>32768)throw new WatchError('WS_UPGRADE','Upgrade headers exceed limit.');
          const end=header.indexOf('\r\n\r\n');if(end<0)return;
          const lines=header.subarray(0,end).toString('ascii').split('\r\n');const fields=new Map(lines.slice(1).map(l=>{const i=l.indexOf(':');return[l.slice(0,i).trim().toLowerCase(),l.slice(i+1).trim()];}));
          if(!/^HTTP\/1\.[01] 101\b/.test(lines[0])||fields.get('sec-websocket-accept')!==expected||fields.get('upgrade')?.toLowerCase()!=='websocket'||!fields.get('connection')?.toLowerCase().split(/,\s*/).includes('upgrade'))throw new WatchError('WS_UPGRADE','App-server rejected WebSocket upgrade.');
          this.open=true;settled=true;clearTimeout(timer);resolve();data=header.subarray(end+4);header=Buffer.alloc(0);
        } if(data.length)decoder.feed(data);
      }catch(e){if(!settled)fail(e);else{this.emit('fault',e);socket.destroy();}}});
      socket.on('error',e=>{if(!settled)fail(new WatchError('BACKEND_UNAVAILABLE',`Cannot connect to app-server socket: ${e.code ?? 'connection error'}`,{socket_path:this.path,system_code:e.code??null}));else this.emit('fault',e);});
      socket.on('close',()=>{clearTimeout(timer);if(!settled){settled=true;reject(new WatchError('BACKEND_DISCONNECTED','App-server closed during connection.'));}this.open=false;this.emit('close');});
    });
  }
  send(message) { if(!this.open)throw new WatchError('BACKEND_DISCONNECTED','App-server is disconnected.'); this.socket.write(encodeFrame(1,Buffer.from(message))); }
  close() { if(this.open)this.socket.write(encodeFrame(8,Buffer.from([3,232])));this.socket?.end();this.open=false; }
}
