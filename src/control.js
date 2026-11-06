// R: Serialize shared watch definitions and durable lifecycle notification attempts.
import net from 'node:net';
import {mkdir,open,unlink,chmod,readFile,stat,lstat,writeFile,rename,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {CompletionBridge} from './bridge.js';
import {defaultBackendSocket} from './app-server.js';
import {Registry,threadId} from './registry.js';
import {errorResult,WatchError,requireValue} from './errors.js';
export const defaultStateDir=()=>resolve(process.env.THREAD_WATCH_STATE_DIR??join(homedir(),'.local','state','thread-watch-plugin-app-server'));
const socketAt=dir=>join(dir,'controller.sock');
export async function controllerRequest(dir,method,params={},timeout=25000){
 return new Promise((resolve,reject)=>{const socket=net.createConnection(socketAt(dir));let data='',done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(new WatchError('CONTROLLER_TIMEOUT','Controller outcome unknown; inspect status before retrying.')),timeout);
  socket.on('connect',()=>socket.write(JSON.stringify({id:1,method,params})+'\n'));
  socket.on('data',chunk=>{data+=chunk;if(Buffer.byteLength(data)>1024*1024)return finish(new WatchError('CONTROLLER_LIMIT','Response too large.'));const end=data.indexOf('\n');if(end<0)return;try{const r=JSON.parse(data.slice(0,end));r.error?finish(new WatchError(r.error.code,r.error.message,r.error.details)):finish(null,r.result);}catch(e){finish(e);}});
  socket.on('error',e=>finish(e));socket.on('end',()=>{if(!done)finish(new WatchError('CONTROLLER_DISCONNECTED','Controller closed without result.'));});
 });
}
async function privateDirectory(dir){
 await mkdir(dir,{recursive:true,mode:0o700});const metadata=await stat(dir);
 requireValue(metadata.uid===process.getuid()&&(metadata.mode&0o077)===0,'STATE_PERMISSIONS','State directory must be owned by current user and private (0700).');
}
export async function startController(dir,{entrypoint=fileURLToPath(new URL('../bin/thread-watch.js',import.meta.url))}={}){
 await privateDirectory(dir);
 const guard=join(dir,'controller.guard');const file=await open(guard,'a',0o600);await file.close();
 const child=spawn('flock',['--exclusive','--nonblock','--conflict-exit-code','75','--no-fork',guard,process.execPath,entrypoint,'serve-locked','--state',dir],{detached:true,stdio:'ignore',env:process.env});
 let launchError;child.on('error',e=>{launchError=e;});child.unref();
 for(let i=0;i<100;i++){
  await new Promise(r=>setTimeout(r,50));
  if(launchError)throw new WatchError('CONTROLLER_LAUNCH','Linux flock could not start; ensure util-linux flock is available.');
  if(child.exitCode!==null||child.signalCode!==null)throw new WatchError(child.exitCode===75?'CONTROLLER_LOCKED':'CONTROLLER_START_FAILED','Controller did not acquire exclusive ownership or failed startup; inspect state.');
  try{const status=await controllerRequest(dir,'status',{},1000);
   requireValue(status.controller_pid===child.pid,'CONTROLLER_LOCKED','Another controller owns this registry.');
   return{pid:child.pid,status:()=>controllerRequest(dir,'status'),wait:async()=>{child.ref();if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');},stop:async()=>{
    if(child.exitCode!==null||child.signalCode!==null)return;
    let current;try{current=await controllerRequest(dir,'status');}catch(e){
     if(!['ENOENT','ECONNREFUSED','ECONNRESET','CONTROLLER_DISCONNECTED'].includes(e.code))throw e;
    }
    if(current&&current.controller_pid!==child.pid)return;
    if(current)await controllerRequest(dir,'stop');
    // Socket removal precedes process exit. Wait for exit so the kernel lease is
    // released before a caller starts a replacement controller in the same state.
    for(let n=0;n<100;n++){if(child.exitCode!==null||child.signalCode!==null)return;await new Promise(r=>setTimeout(r,20));}
    throw new WatchError('CONTROLLER_STOP_TIMEOUT','Controller has not stopped; inspect before retrying.');
   }};
  }catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}
 }
 throw new WatchError('CONTROLLER_UNAVAILABLE','Controller startup timed out; inspect status before retrying.');
}
function requireController(status){
 requireValue(status.controller_version==='0.4.0','CONTROLLER_VERSION_MISMATCH','Inspect and explicitly stop the old controller before switching versions.');
 requireValue(status.socket_path===defaultBackendSocket(),'BACKEND_OVERRIDE_IGNORED','Running controller uses a different App Server socket; inspect before switching.');
}
export async function ensureController(dir){
 try{const s=await controllerRequest(dir,'status',{},1000);requireController(s);return;}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}
 try{await startController(dir);return;}catch(e){if(e.code!=='CONTROLLER_LOCKED')throw e;}
 // A simultaneous starter owns the kernel lease. Wait for its listener; never remove its files.
 for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,50));try{const s=await controllerRequest(dir,'status',{},1000);requireController(s);return;}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}}
 throw new WatchError('CONTROLLER_UNAVAILABLE','Exclusive owner has no ready listener; inspect without stealing its lock.');
}
export async function queryWatchers(dir,params){
 const id=threadId(params.thread_id??params.caller_thread_id,'thread_id');
 try{return await controllerRequest(dir,'watchers',{thread_id:id});}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;const registry=new Registry(join(dir,'registry.json'));await registry.load();return{watchers:registry.watchers(id),monitoring:{controller_running:false,mode:registry.state.mode??'legacy-hook',offline:true,timers:false}};}
}
export async function serveController(dir,{createService,version='0.4.0'}={}){
 await privateDirectory(dir);
 const guard=await stat(join(dir,'controller.guard'));let kernelLease=false;
 for(const fd of await readdir('/proc/self/fd')){
  try{const held=await stat('/proc/self/fd/'+fd);if(held.dev===guard.dev&&held.ino===guard.ino&&/\bFLOCK\s+ADVISORY\s+WRITE\b/.test(await readFile('/proc/self/fdinfo/'+fd,'utf8')))kernelLease=true;}catch{}
 }
 requireValue(kernelLease,'CONTROLLER_LAUNCH_REQUIRED','Controller must run under its Linux flock lease.');
 const lockPath=join(dir,'controller.lock'),token=randomUUID();let previous;
 try{previous=JSON.parse(await readFile(lockPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new WatchError('CONTROLLER_LOCK_STATE','Unrecognized legacy lock; inspect before recovery.');}
 if(previous&&previous.lease!=='flock-v1'){
  requireValue(Number.isSafeInteger(previous.pid)&&previous.pid>0,'CONTROLLER_LOCK_STATE','Invalid legacy PID lock.');
  try{process.kill(previous.pid,0);throw new WatchError('CONTROLLER_LOCKED','Legacy controller PID exists; stop it explicitly before upgrade.');}catch(e){if(e.code!=='ESRCH')throw e;}
 }
 // Kernel ownership excludes every new controller even after SIGKILL or PID reuse.
 try{const old=await lstat(socketAt(dir));requireValue(old.isSocket(),'CONTROLLER_SOCKET_TYPE','Refusing to remove a non-socket entry.');await unlink(socketAt(dir));}catch(e){if(e.code!=='ENOENT')throw e;}
 const temporary=join(dir,`controller-${token}.json`);
 await writeFile(temporary,JSON.stringify({pid:process.pid,token,lease:'flock-v1'}),{mode:0o600,flag:'wx'});await rename(temporary,lockPath);
 const registry=new Registry(join(dir,'registry.json'));try{await registry.load();}catch(e){await unlink(lockPath);throw e;}
 const bridge=createService?await createService(registry):new CompletionBridge(registry,{socketPath:defaultBackendSocket()});
 let stopped=false,tail=Promise.resolve();const activeJobs=new Set();
 const monitoring=()=>({controller_running:true,controller_lock:'kernel-flock',...bridge.status()});
 async function handle(method,p={}){
  switch(method){
   case 'status':return{schema_version:2,controller_pid:process.pid,controller_version:version,...monitoring(),watches:registry.list(),attempts:structuredClone(registry.state.attempts.slice(-100))};
   case 'watch':requireValue(!createService,'UNKNOWN_METHOD','Use the candidate Tool dispatcher.');if(p.action==='upsert')return bridge.upsert(p);if(p.action==='remove')return{removed:(await registry.remove(p)).watch_id};throw new WatchError('INVALID_ARGUMENT','action must be upsert or remove.');
   case 'watchers':return{watchers:registry.watchers(p.thread_id),monitoring:monitoring()};
   case 'services_reload':requireValue(createService,'UNKNOWN_METHOD','Candidate mode required.');return bridge.servicesReload();
   case 'proxy_reconnect':requireValue(createService,'UNKNOWN_METHOD','Candidate mode required.');return bridge.proxyReconnect();
   case 'compatibility_status':requireValue(createService,'UNKNOWN_METHOD','Compatibility controls require candidate mode.');return bridge.status();
   case 'compatibility_reload':requireValue(createService,'UNKNOWN_METHOD','Compatibility controls require candidate mode.');return bridge.compatibilityReload();
   case 'resume':return bridge.resume();
   case 'tool':requireValue(createService,'UNKNOWN_METHOD','Candidate Tool dispatch is not enabled.');return bridge.handle(p);
   case 'stop':setTimeout(()=>stop(),20);return{stopping:true};
   default:throw new WatchError('UNKNOWN_METHOD','Unknown controller method.');
  }
 }
 const server=net.createServer(socket=>{let input='';socket.setTimeout(createService?65000:30000,()=>socket.destroy());socket.on('error',()=>{});
  socket.on('data',chunk=>{input+=chunk;if(Buffer.byteLength(input)>131072)return socket.destroy();const end=input.indexOf('\n');if(end<0)return;socket.pause();let request;
   const job=(createService?Promise.resolve():tail).then(async()=>{try{request=JSON.parse(input.slice(0,end));const result=await handle(request.method,request.params);socket.end(JSON.stringify({id:request.id,result})+'\n');}catch(e){socket.end(JSON.stringify({id:request?.id??null,error:errorResult(e)})+'\n');}});if(createService){activeJobs.add(job);void job.finally(()=>activeJobs.delete(job)).catch(()=>{});tail=Promise.allSettled([...activeJobs]).then(()=>{});}else tail=job.catch(()=>{});
  });
 });
 async function stop(){if(stopped)return;stopped=true;await new Promise(r=>server.close(r));await tail;await bridge.close();try{const owner=JSON.parse(await readFile(lockPath,'utf8'));if(owner.token===token){await unlink(socketAt(dir)).catch(()=>{});await unlink(lockPath);}}catch{}}
 try{await new Promise((r,j)=>{server.once('error',j);server.listen(socketAt(dir),r);});await chmod(socketAt(dir),0o600);}catch(e){await unlink(lockPath).catch(()=>{});throw e;}
 return{registry,server,stop};
}
