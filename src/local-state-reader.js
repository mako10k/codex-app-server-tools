// R: Serve scoped local inspection pages without starting a controller or restoring subscriptions.
import {readFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Registry} from './registry.js';
import {callerContext} from './app-tools.js';
import {digest} from './operation-journal.js';
import {readHeartbeatsOffline} from './heartbeat.js';
import {requireValue} from './errors.js';
export function watchPage(registry,args,{config,policy,monitoring}){
 const watches=registry.list().filter(w=>(!args.source_thread_id||w.source_thread_id===args.source_thread_id)&&(!args.owner_thread_id||w.owner_thread_id===args.owner_thread_id)&&(!args.destination_thread_id||w.destination_thread_id===args.destination_thread_id));let offset=0;
 const filter=digest({source:args.source_thread_id,owner:args.owner_thread_id,destination:args.destination_thread_id,scope:null,backend:config.backend_id});if(args.cursor){const [hash,n]=args.cursor.split(':');requireValue(hash===filter&&/^\d+$/.test(n??''),'INVALID_CURSOR','Watch cursor scope mismatch.');offset=Number(n);}
 const selected=watches.slice(offset,offset+(args.limit??20)),next=offset+selected.length;return{watches:selected,next_cursor:next<watches.length?filter+':'+next:null,has_more:next<watches.length,attempts:registry.state.attempts.filter(a=>selected.some(w=>w.watch_id===a.watch_id)).slice(-10),monitoring};
}
export async function readLocalTool(stateDir,config,{name,args,meta}){
 requireValue(!args.backend_id||args.backend_id===config.backend_id,'BACKEND_MISMATCH','Choose this backend profile.');let caller=args.caller_thread_id;
 if(name!=='as_watch_list'||meta&&caller)caller=callerContext(meta??{},caller).threadId;
 const policy={threads:null};
 let actual;try{actual=await realpath(stateDir);}catch(e){if(e.code!=='ENOENT')throw e;actual=resolve(stateDir);}requireValue(!['thread-watch-plugin','thread-watch-plugin-app-server'].map(x=>resolve(process.env.HOME??'','.local/state',x)).includes(actual),'STATE_ISOLATION','Candidate cannot use live registry directories.');
 let bound=false;try{const b=JSON.parse(await readFile(join(stateDir,'as-binding.json'),'utf8'));requireValue(b.config_digest===digest(config),'BACKEND_MISMATCH','Stored candidate profile differs.');bound=true;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(name==='as_heartbeat_list')return readHeartbeatsOffline(join(stateDir,'heartbeats.json'),config,args,caller);
 let value;
 if(name==='as_watch_list'){const registry=new Registry(join(stateDir,'registry.json'));await registry.load();requireValue(!registry.list().length||bound&&registry.state.mode==='as-tools-candidate','STATE_ISOLATION','Existing watches require their candidate backend binding.');value=watchPage(registry,args,{config,policy,monitoring:{controller_running:false,connected:false,offline:true,timers:false}});}
 else{requireValue(name==='as_chat_manage'&&args.action==='operation_status','UNKNOWN_TOOL','Only local inspection routes are accepted.');let records=[];try{records=JSON.parse(await readFile(join(stateDir,'operations.json'),'utf8'));requireValue(bound&&Array.isArray(records),'STATE_ISOLATION','Operation journal requires its candidate backend binding.');}catch(e){if(e.code!=='ENOENT')throw e;}value={operation:records.find(r=>r.caller===caller&&r.operation_id===args.query_operation_id)??null};}
 const out={backend_id:config.backend_id,observed_at:new Date().toISOString(),untrusted_source_data:true,controller_running:false,offline:true,...value};requireValue(Buffer.byteLength(JSON.stringify(out))<=65536,'RESULT_LIMIT','Result exceeds 64KiB; use a smaller page.');return out;
}
