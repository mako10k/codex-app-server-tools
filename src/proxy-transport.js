// R: Own one official Proxy subprocess and carry a framed WebSocket stream over its pipes.
import {spawn} from 'node:child_process';
import {EventEmitter,once} from 'node:events';
import {stat} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {FrameDecoder,encodeFrame} from './websocket-codec.js';
import {WatchError,requireValue} from './errors.js';
export class ProxyTransport extends EventEmitter {
 constructor({socketPath,executable='codex',timeout=15000,spawnProcess=spawn}={}){super();Object.assign(this,{socketPath,executable,timeout,spawnProcess});this.open=false;this.closed=false;}
 async connect(){
  const s=await stat(this.socketPath);requireValue(s.isSocket()&&s.uid===process.getuid(),'BACKEND_IDENTITY','Expected current-user-owned backend socket.');
  const p=this.child=this.spawnProcess(this.executable,['app-server','proxy','--sock',this.socketPath],{stdio:['pipe','pipe','pipe']});p.stderr.resume();
  this.decoder=new FrameDecoder();this.decoder.on('message',x=>this.emit('message',x));this.decoder.on('ping',x=>this.write(encodeFrame(10,x)));this.decoder.on('close',()=>this.close());
  p.on('exit',()=>{this.open=false;this.emit('close');});p.stdin.on('error',()=>this.emit('fault',new WatchError('PROXY_PIPE','Proxy pipe failed.')));
  await new Promise((resolve,reject)=>{
   let header=Buffer.alloc(0),done=false;const key=randomBytes(16).toString('base64'),expected=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
   const timer=setTimeout(()=>fail(new WatchError('PROXY_TIMEOUT','Proxy handshake timed out.')),this.timeout);
   const fail=e=>{if(!done){done=true;clearTimeout(timer);reject(e);}else this.emit('fault',e);this.close();};
   p.once('error',()=>fail(new WatchError('PROXY_START','Official Proxy could not start.')));p.once('exit',()=>{if(!done)fail(new WatchError('PROXY_EXIT','Proxy exited before handshake.'));});
   p.stdout.on('data',chunk=>{try{
    if(!this.open){header=Buffer.concat([header,chunk]);requireValue(header.length<=32768,'PROXY_PROTOCOL','Oversized upgrade header.');const end=header.indexOf('\r\n\r\n');if(end<0)return;
     const lines=header.subarray(0,end).toString('ascii').split('\r\n'),fields=new Map(lines.slice(1).map(x=>{const i=x.indexOf(':');return[x.slice(0,i).toLowerCase(),x.slice(i+1).trim()];}));
     requireValue(/^HTTP\/1\.[01] 101\b/.test(lines[0])&&fields.get('sec-websocket-accept')===expected&&fields.get('upgrade')?.toLowerCase()==='websocket'&&fields.get('connection')?.toLowerCase().split(/,\s*/).includes('upgrade'),'PROXY_PROTOCOL','Invalid Proxy WebSocket handshake.');
     this.open=true;done=true;clearTimeout(timer);resolve();chunk=header.subarray(end+4);header=Buffer.alloc(0);
    }
    if(chunk.length)this.decoder.feed(chunk);
   }catch(e){fail(e);}});
   p.stdin.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
 }
 write(frame){requireValue(this.child&&!this.child.stdin.destroyed,'BACKEND_DISCONNECTED','Proxy is disconnected.');requireValue(this.child.stdin.writableLength<16*1024*1024,'PROXY_BACKPRESSURE','Proxy output queue is full.');this.child.stdin.write(frame);}
 send(text){requireValue(this.open,'BACKEND_DISCONNECTED','Proxy is disconnected.');this.write(encodeFrame(1,Buffer.from(text)));}
 close(){if(this.closed)return;this.closed=true;this.open=false;this.child?.stdin.end();this.child?.kill('SIGTERM');this.emit('close');}
 async stopped(){const p=this.child;if(!p||p.exitCode!==null||p.signalCode!==null)return;await Promise.race([once(p,'exit'),new Promise(r=>{const t=setTimeout(()=>{p.kill('SIGKILL');r();},1000);t.unref();})]);}
}
