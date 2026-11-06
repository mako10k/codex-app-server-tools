// R: Route observed completions through generation-checked durable attempts to the registered destinations.
import {AppServerBackend} from './app-server.js';
import {validateDefinition,assertDag} from './registry.js';
import {WatchError,requireValue,errorResult} from './errors.js';
export class CompletionBridge {
 constructor(registry,{socketPath,backendFactory=()=>new AppServerBackend({socketPath})}={}){this.registry=registry;this.socketPath=socketPath;this.backendFactory=backendFactory;this.tail=Promise.resolve();this.connected=false;this.gapSince=new Date().toISOString();this.lastError=null;this.epoch=0;}
 status(){return{mode:'app-server',connected:this.connected,socket_path:this.socketPath,backend_identity:this.backend?.identity??null,subscribed_sources:[...(this.backend?.subscribed??[])],gap_since:this.gapSince,last_error:this.lastError,timers:false,supported_events:['turn/completed']};}
 current(w,epoch){const now=this.registry.get(w.watch_id);return this.connected&&epoch===this.epoch&&now?.generation===w.generation;}
 async activate(){
  if(this.connected)return;
  this.backend?.close();const backend=this.backendFactory();this.backend=backend;this.epoch++;
  backend.on('disconnected',e=>{if(this.backend!==backend)return;this.connected=false;this.epoch++;this.gapSince??=new Date().toISOString();this.lastError=errorResult(e);});
  backend.on('completed',event=>{
   if(!this.connected)return;
   const watches=this.registry.watchers(event.source_thread_id),epoch=this.epoch;
   const job=this.tail.then(()=>this.dispatch(event,watches,epoch));this.tail=job.catch(e=>{this.lastError=errorResult(e);});
  });
  try{
   await backend.connect();
   for(const source of new Set(this.registry.list().map(w=>w.source_thread_id)))await backend.observe(source);
   this.connected=true;this.gapSince=null;this.lastError=null;
  }catch(e){backend.close();this.lastError=errorResult(e);throw e;}
 }
 async upsert(input){
  // A legacy hook registry is preserved until its owner chooses a migration.
  requireValue(this.registry.state.mode==='app-server'||this.registry.list().length===0,'REGISTRY_MIGRATION_REQUIRED','Nonempty Hook registry cannot be automatically reinterpreted as completion watches.');
  requireValue(!this.registry.state.backend_socket||this.registry.state.backend_socket===this.socketPath,'BACKEND_MISMATCH','Registry is bound to another App Server socket.');
  const old=input.watch_id?this.registry.get(input.watch_id):undefined;
  requireValue(!input.watch_id||old,'WATCH_NOT_FOUND','Watch does not exist.');const candidate=validateDefinition(input,old);
  assertDag([...this.registry.list().filter(w=>w.watch_id!==candidate.watch_id),candidate]);
  await this.activate();
  await this.backend.readThread(candidate.source_thread_id);await this.backend.destination(candidate.destination_thread_id);await this.backend.observe(candidate.source_thread_id);
  requireValue(this.connected,'BACKEND_DISCONNECTED','Backend disconnected before registration commit.');
  return this.registry.upsert(input,{mode:'app-server',backend_socket:this.socketPath});
 }
 async dispatch(event,watches,epoch){
  for(const watch of watches){
   if(!this.current(watch,epoch))continue;
   const key=`${watch.watch_id}:${watch.generation}:${event.source_thread_id}:${event.turn_id}:completion`;
   if(!await this.registry.attemptOnce(key,watch,event))continue;
   let submitted=false;
   try{
    if(!this.current(watch,epoch))throw new WatchError('DELIVERY_CANCELLED','Watch changed before submission.');
    const text=`[Thread Watch: turn/completed]\nsource=${event.source_thread_id}\nturn=${event.turn_id}\nstatus=${event.status}\n\n${watch.message}`;
    await this.backend.deliver(watch.destination_thread_id,text,{isCurrent:()=>this.current(watch,epoch),onSubmit:()=>{submitted=true;}});
    await this.registry.finishAttempt(key,'delivered');
   }catch(e){const status=e.code==='DELIVERY_CANCELLED'?'cancelled':e.code==='BACKEND_REJECTED'||['DIRECT_INPUT_UNAVAILABLE','DESTINATION_STATE_UNKNOWN'].includes(e.code)?'failed':submitted?'ambiguous':'cancelled';await this.registry.finishAttempt(key,status,errorResult(e));}
  }
 }
 async resume(){requireValue(this.registry.state.mode==='app-server'||this.registry.list().length===0,'REGISTRY_MIGRATION_REQUIRED','Hook registry requires explicit migration.');requireValue(!this.registry.state.backend_socket||this.registry.state.backend_socket===this.socketPath,'BACKEND_MISMATCH','Registry belongs to another backend.');await this.activate();return this.status();}
 async close(){this.connected=false;this.epoch++;this.backend?.close();await this.tail;}
}
