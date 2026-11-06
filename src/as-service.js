import {AS_VERSION,CONTROL_PROTOCOL_VERSION,LEGACY_CONTROL_VERSION} from './as-version.js';
import {serviceSettings} from './service-settings.js';
import {CompatibilityPolicy,cliVersion,serverVersion} from './protocol-compatibility.js';
// R: Coordinate candidate chat operations and durable event watches on one authorized Proxy backend.
import {join,resolve} from 'node:path';
import {readFile,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AppServerBackend} from './app-server.js';
import {ProxyTransport} from './proxy-transport.js';
import {validateDefinition,assertDag,threadId} from './registry.js';
import {WatchError,requireValue,errorResult} from './errors.js';
import {loadConfig} from './as-config.js';
import {OperationJournal,atomicJson,digest,canonical} from './operation-journal.js';
import {ProgressStore} from './progress-store.js';
import {metadata,readHistory,listChats} from './chat-reader.js';
import {validateTool} from './as-schema.js';
import {callerContext} from './app-tools.js';
import {manageChat,sendChat} from './chat-operations.js';
import {randomUUID} from 'node:crypto';
import {watchPage} from './local-state-reader.js';
import {SelfSuppression,relatedEvents} from './self-suppression.js';
import {getGoal,mutateGoal} from './goal-operations.js';
import {Heartbeats} from './heartbeat.js';
import {callMcp} from './mcp-gateway.js';
const exec=promisify(execFile),version=AS_VERSION;
export class AsService{
 constructor(registry,{config,backendFactory,verifyVersion,heartbeatOptions,suppressionOptions}={}){this.registry=registry;this.config=config;this.heartbeatOptions=heartbeatOptions;this.suppressionOptions=suppressionOptions;this.backendFactory=backendFactory;this.verifyVersion=verifyVersion;this.connected=false;this.stopping=false;this.retry=0;this.tail=Promise.resolve();}
 async init(){this.config??=await loadConfig();const c=this.config;this.socketPath=c.socket_path;
  const forbidden=['thread-watch-plugin','thread-watch-plugin-app-server'].map(x=>resolve(process.env.HOME??'', '.local/state',x));requireValue(!forbidden.includes(await realpath(resolve(this.registry.file,'..'))),'STATE_ISOLATION','Candidate cannot use either live registry directory.');
  requireValue((!this.registry.state.mode&&this.registry.list().length===0)||this.registry.state.mode==='as-tools-candidate','REGISTRY_MIGRATION_REQUIRED','Candidate never auto-converts an existing registry.');
  requireValue(!this.registry.state.backend_id||this.registry.state.backend_id===c.backend_id,'BACKEND_MISMATCH','Registry backend differs.');requireValue(!this.registry.state.backend_socket||this.registry.state.backend_socket===c.socket_path,'BACKEND_MISMATCH','Registry socket differs.');
  const dir=resolve(this.registry.file,'..'),bindingFile=join(dir,'as-binding.json'),binding={backend_id:c.backend_id,host:c.host,socket_path:c.socket_path,expected_codex_home:c.expected_codex_home,config_digest:digest(c)};
  try{const old=JSON.parse(await readFile(bindingFile,'utf8'));requireValue(canonical(old)===canonical(binding),'BACKEND_MISMATCH','Candidate profile changed; inspect state before reconfiguration.');}catch(e){if(e.code!=='ENOENT')throw e;await atomicJson(bindingFile,binding);}
  if(this.registry.state.attempts.some(a=>a.status==='pending'))await this.registry.transaction(state=>{for(const a of state.attempts)if(a.status==='pending')a.status='ambiguous';});
  this.journal=new OperationJournal(join(dir,'operations.json'));await this.journal.load();this.progress=new ProgressStore(join(dir,'progress.json'));await this.progress.load();
  this.stateDir=dir;this.services=await serviceSettings(dir);
  this.compatibility=new CompatibilityPolicy(c,{failureFile:join(dir,'compatibility-failure.json')});await this.compatibility.refresh();
  this.suppression=new SelfSuppression(join(dir,'self-suppression.json'),{seconds:c.self_suppression_seconds??5,...this.suppressionOptions});await this.suppression.load();
  this.heartbeats=new Heartbeats(join(dir,'heartbeats.json'),this,this.heartbeatOptions);await this.heartbeats.load();
  if(this.registry.list().length||this.heartbeats.active().length)void this.connect().catch(()=>{});return this;
 }
 status(){return{controller_version:LEGACY_CONTROL_VERSION,controller_build_version:version,controller_protocol_version:CONTROL_PROTOCOL_VERSION,management_protocol_version:1,mode:'as-tools-candidate',service_error:this.serviceError??null,desired_services:this.services,operating_state:this.compatibility.state==='normal'?(this.connected?'normal':'disconnected'):'degraded',compatibility:this.compatibility.report(),protocol_baseline:this.config.supported_protocol_version,proxy_cli_version:this.proxyCliVersion??null,backend_id:this.config.backend_id,socket_path:this.socketPath,connected:this.connected,epoch:this.progress?.epoch,subscribed_sources:[...(this.backend?.subscribed??[])],last_error:this.lastError??null,gap_since:this.connected?null:this.progress?.data.gaps.at(-1)?.started_at,timers:!!this.heartbeats?.timer,heartbeat_tools_version:1,goal_tools_version:1,self_suppression_seconds:this.suppression.seconds,heartbeat_error:this.heartbeats?.lastError??null,supported_events:['turn_ended','compaction_started','compaction_completed',...relatedEvents]};}
 schedule(){if(this.stopping||this.services?.proxy===false||this.timer)return;this.timer=setTimeout(()=>{this.timer=null;void this.connect().catch(()=>{});},Math.min(30000,250*2**Math.min(this.retry++,7)));this.timer.unref();}
 async connect(){await this.refreshServices();requireValue(this.services.proxy,'SERVICE_STOPPED','Proxy is explicitly stopped; use as_control to start it.');await this.refreshCompatibility();if(this.connected)return this.backend;if(this.connecting)return this.connecting;
  this.connecting=(async()=>{const c=this.config;
   const actual=this.verifyVersion?await this.verifyVersion():await exec(c.proxy_executable,['--version'],{timeout:10000,maxBuffer:4096});this.proxyCliVersion=cliVersion(actual.stdout);
   const b=this.backend=this.backendFactory?this.backendFactory():new AppServerBackend({socketPath:c.socket_path,clientInfo:{name:'app-server-tools',version},capabilityErrors:true,transport:new ProxyTransport({socketPath:c.socket_path,executable:c.proxy_executable})});
   b.on('notification',e=>{this.progress.observe(e);if(['turn/completed','thread/status/changed'].includes(e.method)&&this.heartbeats.active().some(r=>r.owner_thread_id===e.params?.threadId))this.heartbeats.wake();const event=this.normalize(e);if(event&&b.connected){event.self_suppression_windows=this.suppression.snapshot(event);const watches=this.registry.watchers(event.source_thread_id),epoch=this.progress.epoch;const job=this.tail.then(async()=>{if(this.connecting)await this.connecting;return this.dispatch(event,watches,epoch);});this.tail=job.catch(e=>{this.lastError=errorResult(e);});}});
   b.on('disconnected',e=>{if(this.backend!==b||this.stopping||this.rejectedBackend===b)return;this.connected=false;this.lastError=errorResult(e);void this.progress.gap('proxy_disconnected').catch(()=>{});this.schedule();});
   try{await b.connect();requireValue(b.identity.codex_home===c.expected_codex_home,'BACKEND_IDENTITY','App Server CODEX_HOME does not match the configured profile.');
    this.compatibility.evaluate(this.proxyCliVersion,serverVersion(b.identity.user_agent));this.compatibility.assert();
    b.authorizeRequest=()=>{requireValue(this.services.proxy,'SERVICE_STOPPED','Proxy is stopped.');this.compatibility.assert();requireValue(this.backend===b,'BACKEND_IDENTITY','Backend connection changed.');};
    for(const row of this.services.watch?c.guard_contexts:[]){
     const restored=await b.request('thread/resume',{threadId:row.guard,excludeTurns:true,developerInstructions:row.instructions,config:row.config});b.subscribed.add(row.guard);
     const r=await b.request('mcpServerStatus/list',{threadId:row.guard,serverName:'guardrail_context',detail:'toolsAndAuthOnly'});requireValue(r.data?.some(s=>s.name==='guardrail_context'&&s.runtimeStatus==='connected'&&s.serverInfo?.version===(row.context_version??'0.1.1')),'GUARD_CONTEXT','Guard context is not ready.');}
    for(const id of new Set(this.services.watch?this.registry.list().map(w=>w.source_thread_id):[])){this.progress.attach(id,'watch');await b.observe(id);}
    this.connected=true;if(this.services.heartbeat)await this.heartbeats.reconnect();this.lastError=null;this.retry=0;return b;
   }catch(e){if(e.code==='BACKEND_IDENTITY')await this.compatibility.invalidate('backend_identity_mismatch');this.connected=false;this.lastError=errorResult(e);this.rejectedBackend=b;b.close();if(!['BACKEND_IDENTITY','GUARD_CONTEXT','UNSUPPORTED_CAPABILITY','COMPATIBILITY_REQUIRED'].includes(e.code))this.schedule();else{clearTimeout(this.timer);this.timer=null;}throw e;}
  })().catch(e=>{this.lastError=errorResult(e);throw e;}).finally(()=>{this.connecting=null;});return this.connecting;
 }
 normalize({method,params:p}){if(!p||typeof p.threadId!=='string')return null;const base={backend_id:this.config.backend_id,source_thread_id:p.threadId,turn_id:p.turnId??p.turn?.id,received_at:new Date(this.suppression.now()).toISOString()};
  if(method==='turn/completed'&&['completed','interrupted','failed'].includes(p.turn?.status))return{...base,kind:'turn_ended',phase:'ended',status:p.turn.status};
  if(['item/started','item/completed'].includes(method)&&p.item?.type==='userMessage'&&typeof p.item.id==='string'&&typeof p.turnId==='string')return{...base,item_id:p.item.id,kind:'user_prompt',phase:'submitted'};
  if(method==='thread/goal/updated'&&p.goal?.threadId===p.threadId)return{...base,kind:'goal_updated',phase:'updated',goal_digest:digest(p.goal),goal_status:p.goal.status};
  if(method==='thread/goal/cleared')return{...base,kind:'goal_cleared',phase:'cleared',observation_id:randomUUID()};
  if(['item/started','item/completed'].includes(method)&&p.item?.type==='contextCompaction'&&typeof p.item.id==='string'&&typeof p.turnId==='string')return{...base,item_id:p.item.id,kind:method==='item/started'?'compaction_started':'compaction_completed',phase:method==='item/started'?'started':'completed',server_at_ms:p.startedAtMs??p.completedAtMs??null};return null;
 }
 async dispatch(event,watches,epoch){await this.refreshServices();if(!this.services.watch)return;await this.refreshCompatibility();for(const w of watches){if(!(w.events??['turn_ended']).includes(event.kind))continue;const current=()=>this.services.watch&&this.connected&&epoch===this.progress.epoch&&this.registry.get(w.watch_id)?.generation===w.generation;if(!current())continue;
   const key='as:'+digest([event.backend_id,w.watch_id,w.generation,event.source_thread_id,event.turn_id,event.item_id??null,event.kind,event.phase,...(relatedEvents.includes(event.kind)?[event.goal_digest??event.observation_id??null]:[])]);if(!await this.registry.attemptOnce(key,w,event))continue;
   const suppressed=this.suppression.match(event,w);if(suppressed){await this.registry.finishAttempt(key,'suppressed',undefined,suppressed);continue;}
   let submitted=false;try{await this.suppression.mark(w.owner_thread_id,w.destination_thread_id,relatedEvents,'watch:'+w.watch_id+':'+key);await this.backend.deliver(w.destination_thread_id,`[App Server event: ${event.kind}]\nbackend=${event.backend_id}\nsource=${event.source_thread_id}\nturn=${event.turn_id}\nitem=${event.item_id??''}\nstatus=${event.status??event.goal_status??event.phase}${event.goal_digest?'\ngoal_digest='+event.goal_digest:''}\n\n${w.message}`,{isCurrent:current,onSubmit:()=>{submitted=true;}});await this.registry.finishAttempt(key,'delivered');}
   catch(e){await this.registry.finishAttempt(key,e.code==='BACKEND_REJECTED'?'failed':submitted?'ambiguous':'cancelled',errorResult(e));}
  }}
 async refreshServices(){
  try{this.services=await serviceSettings(this.stateDir);this.serviceError=null;}catch(e){this.services={controller:true,proxy:false,watch:false,heartbeat:false};this.serviceError=errorResult(e);}
  if(!this.services.heartbeat&&this.heartbeats){clearTimeout(this.heartbeats.timer);this.heartbeats.timer=null;}
  if(!this.services.proxy){clearTimeout(this.timer);this.timer=null;if(this.connected){this.connected=false;this.rejectedBackend=this.backend;this.backend?.close();await this.progress.gap('operator_stopped_proxy');}}
  return this.services;
 }
 async disconnectProxy(reason){clearTimeout(this.timer);this.timer=null;if(this.connecting)await this.connecting.catch(()=>{});this.connected=false;this.rejectedBackend=this.backend;this.backend?.close();await this.backend?.transport?.stopped?.();await this.progress.gap(reason);}
 async servicesReload(){await this.refreshServices();await this.disconnectProxy('service_settings_changed');if(this.services.proxy)try{await this.connect();}catch(e){this.lastError=errorResult(e);}return this.status();}
 async proxyReconnect(){await this.refreshServices();requireValue(this.services.proxy,'SERVICE_STOPPED','Proxy is explicitly stopped.');await this.disconnectProxy('operator_reconnect');try{await this.connect();}catch(e){this.lastError=errorResult(e);}return this.status();}
 async refreshCompatibility(){await this.compatibility.refresh();if(this.connected&&this.compatibility.state!=='normal'){this.connected=false;this.rejectedBackend=this.backend;this.backend?.close();await this.progress.gap('compatibility_degraded');}return this.compatibility.report();}
 async compatibilityReload(){await this.compatibility.clearFailure();await this.refreshCompatibility();try{await this.connect();}catch(e){this.lastError=errorResult(e);}return this.status();}
 async resume(){await this.connect();return this.status();}
 async close(){this.stopping=true;await this.heartbeats.close();this.connected=false;clearTimeout(this.timer);if(this.connecting)await this.connecting.catch(()=>{});this.backend?.close();this.connected=false;await this.backend?.transport?.stopped?.();await this.tail;await this.journal.tail;await this.suppression.tail;await this.compatibility.tail;await this.progress.gap('controller_stopping');await this.progress.close();}
 // Only fresh malformed-protocol observations can invalidate compatibility.
 // A missing method is a per-operation capability error; stored receipts are data.
 async observeProtocolFailure(fn){try{return await fn();}catch(e){if(e.code==='BACKEND_PROTOCOL'){await this.compatibility.invalidate();await this.refreshCompatibility();}throw e;}}
 async handle(request){return this.observeProtocolFailure(()=>this.handleTool(request));}
 async handleTool({name,args,meta}){
  const tool=validateTool(name,args);requireValue(!args.backend_id||args.backend_id===this.config.backend_id,'BACKEND_MISMATCH','Choose this controller backend profile.');
  const mutation=!tool.annotations.readOnlyHint&&!(name==='as_chat_manage'&&args.action==='operation_status');let caller=args.caller_thread_id;
  if(mutation)requireValue(typeof caller==='string'&&caller.length>0,'CALLER_REQUIRED','Explicit caller_thread_id is required.');
  if(mutation||name==='as_chat_manage'&&args.action==='operation_status'||name.startsWith('as_heartbeat_')){caller=callerContext(meta,caller).threadId;}else if(meta&&args.caller_thread_id)caller=callerContext(meta,caller).threadId;
  const policy={threads:null};
  if(name==='as_heartbeat_list')return this.result(this.heartbeats.list(args,caller));
  if(name==='as_watch_list')return this.result(watchPage(this.registry,args,{config:this.config,policy,monitoring:this.status()}));
  if(name==='as_chat_manage'&&args.action==='operation_status')return this.result({operation:this.journal.get(caller,args.query_operation_id)});
  if(mutation)return this.result({operation:await this.journal.run(caller,{...args,tool:name,backend_id:this.config.backend_id},submit=>this.observeProtocolFailure(async()=>{if(name==='as_heartbeat_remove')return this.heartbeats.remove(args,caller,submit);if(name==='as_watch_remove')return this.mutate(name,args,caller,null,submit);const b=await this.connect();await b.readThread(caller);if(name==='as_heartbeat_set'){await this.heartbeats.target(b,caller);await b.observe(caller);this.progress.attach(caller,'heartbeat');return this.heartbeats.set(args,caller,submit);}return this.mutate(name,args,caller,b,submit);} ))});
  const b=await this.connect();let value;
  if(name==='as_goal_get')value=await getGoal(b,args.thread_id);
  else if(name==='as_chat_list')value=await listChats(b,args,this.config.backend_id,policy);
  else if(name==='as_chat_inspect'){value={chat:metadata(await b.readThread(args.thread_id)),watch_ids:this.registry.watchers(args.thread_id).map(w=>w.watch_id),coverage:this.progress.coverage(args.thread_id)};}
  else if(name==='as_chat_history')value=await readHistory(b,args,this.config.backend_id);
  else if(name==='as_chat_progress'){const chat=metadata(await b.readThread(args.thread_id)),turns=await b.request('thread/turns/list',{threadId:args.thread_id,limit:1,sortDirection:'desc',itemsView:'notLoaded'});value={chat,current_turn:turns.data[0]?{id:turns.data[0].id,status:turns.data[0].status}:null,...await this.progress.read(args.thread_id,args.after_cursor,args.wait_ms??0)};}
  else if(name==='as_mcp_inspect'){const r=await b.request('mcpServerStatus/list',{threadId:args.thread_id,serverName:args.server_name,detail:'toolsAndAuthOnly',cursor:args.cursor,limit:args.limit??20});value={servers:r.data,next_cursor:r.nextCursor??null,has_more:!!r.nextCursor};}
  else throw new WatchError('UNKNOWN_TOOL','Unknown read Tool.');return this.result(value);
 }
 result(value){const out={backend_id:this.config.backend_id,observed_at:new Date().toISOString(),untrusted_source_data:true,...value};requireValue(Buffer.byteLength(JSON.stringify(out))<=65536,'RESULT_LIMIT','Result exceeds 64KiB; use smaller pages or a narrower server filter.');return out;}
 async mutate(name,a,caller,b,submit){
  if(name==='as_watch_set'){
   requireValue(!a.watch_id||a.expected_generation!==undefined,'INVALID_ARGUMENT','Watch update requires expected_generation.');const input={...a,action:'upsert',caller_thread_id:caller};for(const k of ['operation_id','backend_id'])delete input[k];const old=a.watch_id?this.registry.get(a.watch_id):undefined;const w=validateDefinition(input,old);assertDag([...this.registry.list().filter(x=>x.watch_id!==w.watch_id),w]);await b.readThread(w.source_thread_id);await b.destination(w.destination_thread_id);this.progress.attach(w.source_thread_id,this.registry.watchers(w.source_thread_id).length?'watch':'resume');await this.suppression.mark(caller,w.source_thread_id,relatedEvents,a.operation_id);await b.observe(w.source_thread_id);await submit();const saved=await this.registry.upsert(input,{mode:'as-tools-candidate',backend_id:this.config.backend_id,backend_socket:this.socketPath});this.progress.attach(w.source_thread_id,'watch');return saved;
  }
  if(name==='as_watch_remove'){const w=this.registry.get(a.watch_id);requireValue(w&&w.generation===a.expected_generation,'GENERATION_CONFLICT','Watch generation changed.');requireValue(w.owner_thread_id===caller,'OWNER_MISMATCH','Only the original registering owner may remove this watch.');await submit();const removed=(await this.registry.remove({action:'remove',caller_thread_id:caller,watch_id:a.watch_id})).watch_id;if(!this.registry.watchers(w.source_thread_id).length)this.progress.temporary(w.source_thread_id);return{removed};}
  if(name.startsWith('as_goal_'))return mutateGoal(b,name,a,{caller,submit,suppression:this.suppression});
  if(name==='as_chat_send'){await this.suppression.mark(caller,a.thread_id,relatedEvents,a.operation_id);return sendChat(b,a,submit);}
  if(name==='as_chat_manage'&&a.action==='resume')await this.suppression.mark(caller,a.thread_id,relatedEvents,a.operation_id);
  if(name==='as_mcp_call')return callMcp(b,a,{config:this.config,caller,submit});
  return manageChat(b,a,{config:this.config,registry:this.registry,progress:this.progress,caller,submit});
 }
}
