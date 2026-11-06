// R: Serve local candidate diagnostics and serialize operator recovery actions without backend RPC dependencies.
import {readFile,mkdir,stat,realpath} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {controllerRequest,startController} from './control.js';
import {CompatibilityPolicy,compatibilityFile} from './protocol-compatibility.js';
import {serviceSettings} from './service-settings.js';
import {AS_VERSION,CONTROL_PROTOCOL_VERSION} from './as-version.js';
import {callerContext} from './app-tools.js';
import {OperationJournal,atomicJson,digest} from './operation-journal.js';
import {requireValue,errorResult} from './errors.js';
import {validateTool} from './as-schema.js';
const entrypoint=fileURLToPath(new URL('../bin/as-tools.js',import.meta.url));
const worker=fileURLToPath(new URL('../bin/as-admin.js',import.meta.url));
const absent=e=>['ENOENT','ECONNREFUSED'].includes(e.code);
async function scope(dir,c,{binding=true}={}){
 let actual;try{actual=await realpath(dir);}catch(e){if(e.code!=='ENOENT')throw e;actual=resolve(dir);}
 requireValue(!['thread-watch-plugin','thread-watch-plugin-app-server'].map(x=>resolve(process.env.HOME??'','.local/state',x)).includes(actual),'STATE_ISOLATION','Management cannot operate the live monitoring registries.');
 if(!binding)return;
 try{const b=JSON.parse(await readFile(join(dir,'as-binding.json'),'utf8'));requireValue(b.config_digest===digest(c),'BACKEND_MISMATCH','Candidate profile differs.');}catch(e){if(e.code!=='ENOENT')throw e;}
}
function owner(s,c){requireValue(s.mode==='as-tools-candidate'&&s.controller_protocol_version===CONTROL_PROTOCOL_VERSION&&s.backend_id===c.backend_id&&s.socket_path===c.socket_path&&s.config_digest===digest(c),'CONTROLLER_VERSION_MISMATCH','Management target is not this candidate profile.');}
async function current(dir,c){try{const s=await controllerRequest(dir,'status',{},1000);owner(s,c);return s;}catch(e){if(!absent(e))throw e;return null;}}
async function start(dir,c){const s=await current(dir,c);if(s)return s;await startController(dir,{entrypoint});const v=await current(dir,c);requireValue(v,'CONTROLLER_UNAVAILABLE','Started controller has no listener.');return v;}
async function lastReceipt(dir,caller,id){try{const rows=JSON.parse(await readFile(join(dir,'management','operations.json'),'utf8'));return id?rows.find(r=>r.caller===caller&&r.operation_id===id)??null:rows.at(-1)??null;}catch(e){if(e.code!=='ENOENT')throw e;return null;}}
export async function managementStatus(dir,c,{caller,id,receipt=true}={}){
 await scope(dir,c,{binding:false});let s=null,diagnostic=null,desired=null;
 try{await scope(dir,c);desired=await serviceSettings(dir);}catch(e){diagnostic=errorResult(e);}
 try{s=await current(dir,c);}catch(e){diagnostic=errorResult(e);}
 const p=new CompatibilityPolicy(c,{failureFile:join(dir,'compatibility-failure.json')});await p.refresh();
 let record=null,receiptError=null;if(receipt)try{record=await lastReceipt(dir,caller,id);}catch(e){receiptError=errorResult(e);}
 const compatibility=s?.compatibility??p.report(),reason=diagnostic??(!desired?.controller?'operator_stopped':!s&&record?.error?{source:'recorded_management_failure',...record.error}:null);
 const state=(enabled,running,why)=>({desired:enabled===null?'unknown':enabled?'running':'stopped',state:running?'running':why==='unknown'?'unknown':'stopped',reason:running?null:why});
 const blocked=!s?'controller_unavailable':!desired?.proxy?'operator_stopped':compatibility.state!=='normal'?'compatibility_degraded':s.last_error??'disconnected';
 return{backend_id:c.backend_id,observed_at:new Date().toISOString(),management_version:AS_VERSION,controller_build_version:s?.controller_build_version??null,management_controls_available:!s||s.management_protocol_version===1,controller_running:!!s,controller_observation:s?'reachable':'unreachable',diagnostic,compatibility,settings_error:p.config_error??null,pending_settings_reload:!!s&&s.compatibility?.policy_digest!==p.policy_digest,compatibility_registrations:p.config_error?null:p.data.registrations,settings_digest:p.policy_digest??null,services:{controller:state(desired?.controller??null,!!s,reason??'unknown'),proxy:state(desired?.proxy??null,!!s?.connected,blocked),watch:state(desired?.watch??null,!!s?.connected&&desired?.watch===true&&!s?.service_error,desired?.watch===false?'operator_stopped':s?.service_error??blocked),heartbeat:state(desired?.heartbeat??null,!!s?.connected&&desired?.heartbeat===true&&s?.timers===true,desired?.heartbeat===false?'operator_stopped':s?.heartbeat_error??(s?.connected?'no_active_schedule':blocked))},last_error:s?.last_error??null,operation:record,receipt_error:receiptError,shared_app_server:{managed:false,state:'not_inspected'},pinned_monitoring:{managed:false,state:'outside_management_scope'}};
}
export async function localManagement(dir,c,{name,args,meta}){
 validateTool(name,args);await scope(dir,c,{binding:name!=='as_status'});requireValue(!args.backend_id||args.backend_id===c.backend_id,'BACKEND_MISMATCH','Select this profile.');
 let caller=args.caller_thread_id;
 if(name==='as_control'||args.query_operation_id||caller)caller=callerContext(meta,caller).threadId;
 if(name==='as_status')return managementStatus(dir,c,{caller,id:args.query_operation_id});
 // flock is process scoped, so controller shutdown cannot strand the management writer lease.
 await mkdir(dir,{recursive:true,mode:0o700});const d=await stat(dir);requireValue(d.uid===process.getuid()&&(d.mode&0o077)===0,'STATE_PERMISSIONS','Candidate state must be private.');
 await mkdir(join(dir,'management'),{recursive:true,mode:0o700});
 let invocation=[process.execPath,worker];if(args.action==='compatibility_set'){await mkdir(dirname(compatibilityFile(c)),{recursive:true,mode:0o700});invocation=['flock','--exclusive','--nonblock','--conflict-exit-code','75','--no-fork',compatibilityFile(c)+'.guard',...invocation];}
 return new Promise((resolve,reject)=>{
  const child=spawn('flock',['--exclusive','--nonblock','--conflict-exit-code','75','--no-fork',join(dir,'management','writer.guard'),...invocation],{stdio:['pipe','pipe','pipe']});let out='';
  child.on('error',reject);child.stdout.on('data',b=>{out+=b;if(out.length>1048576)child.kill();});child.stderr.resume();
  child.once('close',code=>{try{requireValue(code!==75,'CONTROL_BUSY','Another management action is running; inspect status before retrying.');requireValue(code===0,'CONTROL_FAILED','Management worker failed; inspect local receipts.');const r=JSON.parse(out);if(r.error){const e=new Error(r.error.message);Object.assign(e,r.error);reject(e);}else resolve(r);}catch(e){reject(e);}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({dir,config:c,request:{name,args,meta}}));
 });
}
export async function managementControlLocked(dir,c,{name,args,meta}){
 validateTool(name,args);await scope(dir,c,{binding:name!=='as_status'});requireValue(name==='as_control','UNKNOWN_TOOL','Management worker accepts only control.');const caller=callerContext(meta,args.caller_thread_id).threadId;
 const journal=new OperationJournal(join(dir,'management','operations.json'));await journal.load();
 const operation=await journal.run(caller,{tool:name,...args,backend_id:c.backend_id},async submit=>{
  const existing=await current(dir,c);requireValue(!existing||existing.management_protocol_version===1,'MANAGEMENT_UPGRADE_REQUIRED','Running candidate lacks management controls; inspect and explicitly upgrade it before control.'); // Refuse an unrelated listener before writing settings or stopping anything.
  if(args.action==='compatibility_set'){
   const p=new CompatibilityPolicy(c);await p.refresh();requireValue(!p.config_error,'COMPATIBILITY_CONFIG','Repair invalid settings explicitly before registering a decision.');requireValue(p.policy_digest===args.expected_settings_digest,'SETTINGS_CONFLICT','Compatibility settings changed; read as_status again.');
   const r={...args.registration,backend_id:c.backend_id,protocol_baseline:c.supported_protocol_version,scope:'all',enabled:args.registration.decision==='compatible',approved_by:caller,checked_at:new Date().toISOString()};
   const key=x=>[x.backend_id,x.proxy_cli_version,x.app_server_version,x.protocol_baseline].join(':');const data={schema_version:1,registrations:[...p.data.registrations.filter(x=>key(x)!==key(r)),r]};
   // Validate the entire candidate registry before replacing the operator file.
   requireValue(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(r.proxy_cli_version)&&/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(r.app_server_version),'INVALID_ARGUMENT','Use exact semantic versions.');
   requireValue(data.registrations.length<=200&&Buffer.byteLength(JSON.stringify(data))<=65536,'COMPATIBILITY_CONFIG','Registry exceeds policy limits.');
   await submit();await atomicJson(compatibilityFile(c),data);const running=await current(dir,c);if(running)await controllerRequest(dir,'compatibility_reload');return managementStatus(dir,c,{receipt:false});
  }
  if(args.action==='service_set'){
   const desired=await serviceSettings(dir);desired[args.service]=args.enabled;await submit();await atomicJson(join(dir,'services.json'),desired);
   if(args.service==='controller'){
    if(args.enabled)await start(dir,c);else{const s=await current(dir,c);if(s){await controllerRequest(dir,'stop');for(let n=0;n<250;n++){if(!await current(dir,c))break;await new Promise(r=>setTimeout(r,20));}requireValue(!await current(dir,c),'CONTROLLER_STOP_TIMEOUT','Controller still stopping; inspect before retrying.');}}
   }else{const s=await current(dir,c);if(s)await controllerRequest(dir,'services_reload');}
  }else{await submit();const desired=await serviceSettings(dir);requireValue(desired.controller,'SERVICE_STOPPED','Start the controller explicitly first.');await start(dir,c);await controllerRequest(dir,args.action==='compatibility_reload'?'compatibility_reload':'proxy_reconnect');}
  return managementStatus(dir,c,{receipt:false});
 });return{backend_id:c.backend_id,operation};
}
