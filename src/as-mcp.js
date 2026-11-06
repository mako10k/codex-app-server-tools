import {monitoringViewTool,monitoringUiResources,readMonitoringUiResource,monitoringViewResult} from './monitoring-ui.js';
import {startDashboard,dashboardTool} from './dashboard-server.js';
import {localManagement} from './local-management.js';
import {serviceSettings} from './service-settings.js';
import {AS_VERSION,CONTROL_PROTOCOL_VERSION} from './as-version.js';
// R: Expose typed as_ Tools and legacy watch aliases through an isolated candidate controller.
import readline from 'node:readline';
import {join} from 'node:path';
import {readLocalTool} from './local-state-reader.js';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {startController,controllerRequest} from './control.js';
import {tools as legacyTools} from './mcp.js';
import {asTools,validateTool,checkSchema} from './as-schema.js';
import {loadConfig} from './as-config.js';
import {callerContext} from './app-tools.js';
import {errorResult,requireValue} from './errors.js';
import {digest} from './operation-journal.js';
const entrypoint=fileURLToPath(new URL('../bin/as-tools.js',import.meta.url));
function matchesController(s,config){requireValue(s.controller_protocol_version===CONTROL_PROTOCOL_VERSION&&s.heartbeat_tools_version===1&&s.goal_tools_version===1&&s.backend_id===config.backend_id&&s.socket_path===config.socket_path&&s.config_digest===digest(config),'CONTROLLER_VERSION_MISMATCH','Candidate controller profile differs; inspect before switching.');}
export async function ensureAsController(stateDir,config){
 const matches=s=>matchesController(s,config);
 try{matches(await controllerRequest(stateDir,'status',{},1000));return;}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}
 requireValue((await serviceSettings(stateDir)).controller,'SERVICE_STOPPED','Candidate controller is explicitly stopped; use as_control to start it.');
 try{await startController(stateDir,{entrypoint});}catch(e){if(e.code!=='CONTROLLER_LOCKED')throw e;}
 for(let n=0;n<100;n++){try{matches(await controllerRequest(stateDir,'status',{},1000));return;}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,50));}}
 requireValue(false,'CONTROLLER_UNAVAILABLE','Candidate owner did not expose its listener.');
}
export async function runAsMcp({stateDir,input=process.stdin,output=process.stdout,config,call,ensure}={}){
 config??=await loadConfig();let initialized=false,ready=false;let dashboard;const listed=asTools.concat(monitoringViewTool,dashboardTool,legacyTools),write=x=>output.write(JSON.stringify(x)+'\n');
 for await(const line of readline.createInterface({input,crlfDelay:Infinity})){let r;try{
  requireValue(Buffer.byteLength(line)<=131072,'INVALID_REQUEST','MCP message exceeds size limit.');r=JSON.parse(line);requireValue(r.jsonrpc==='2.0'&&typeof r.method==='string','INVALID_REQUEST','Invalid JSON-RPC.');
  if(r.method==='notifications/initialized'){requireValue(initialized,'INVALID_REQUEST','Initialize first.');ready=true;continue;}if(r.id===undefined)continue;
  let result;if(r.method==='initialize'){requireValue(!initialized,'INVALID_REQUEST','Already initialized.');initialized=true;result={protocolVersion:['2025-11-25','2025-06-18'].includes(r.params?.protocolVersion)?r.params.protocolVersion:'2025-06-18',capabilities:{tools:{},resources:{}},serverInfo:{name:'app-server-tools',version:AS_VERSION},instructions:'as_ Tools use the configured existing backend through the official Proxy. Mutations need actual runtime caller metadata and operation_id. Accepted is not completed. Only explicitly registered expiring self-chat heartbeats use timers. No blind retries.'};}
  else if(r.method==='ping')result={};else{requireValue(ready,'INVALID_REQUEST','Complete initialization.');if(r.method==='resources/list')result={resources:monitoringUiResources};else if(r.method==='resources/templates/list')result={resourceTemplates:[]};else if(r.method==='resources/read')result=await readMonitoringUiResource(r.params?.uri);else if(r.method==='tools/list')result={tools:listed};else if(r.method==='tools/call'){
   try{let {name,arguments:args={},_meta:meta}=r.params??{};const original=name;requireValue(listed.some(t=>t.name===name),'UNKNOWN_TOOL','Tool is not enabled.');if(name==='as_monitoring_view'){checkSchema(monitoringViewTool.inputSchema,args);const value=await monitoringViewResult(stateDir,{metadata:meta});write({jsonrpc:'2.0',id:r.id,result:value});continue;}if(name==='as_dashboard'){checkSchema(dashboardTool.inputSchema,args);dashboard??=await startDashboard(stateDir);const value={dashboard_url:dashboard.url,read_only:true};write({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:false}});continue;}if(!name.startsWith('as_'))checkSchema(listed.find(t=>t.name===name).inputSchema,args);
    if(name==='list_thread_watchers'){args={...(args.caller_thread_id?{caller_thread_id:args.caller_thread_id}:{}),source_thread_id:args.thread_id??args.caller_thread_id};name='as_watch_list';}
    if(name==='watch_thread'){
     requireValue(args.check_interval_seconds===undefined||args.check_interval_seconds===null,'TIMER_REMOVED','No timers.');callerContext(meta,args.caller_thread_id);const {action,delivery,check_interval_seconds,...rest}=args;requireValue(!delivery||['wake','message'].includes(delivery),'INVALID_ARGUMENT','Invalid delivery.');requireValue(['upsert','remove'].includes(action),'INVALID_ARGUMENT','Invalid watch action.');name=action==='upsert'?'as_watch_set':'as_watch_remove';args={...rest,operation_id:meta?.['openai/toolCallId']??'legacy-'+randomUUID()};
     if(action==='upsert'){if(args.watch_id){await (ensure?ensure():ensureAsController(stateDir,config));const s=await controllerRequest(stateDir,'status');const w=s.watches.find(w=>w.watch_id===args.watch_id);requireValue(w,'WATCH_NOT_FOUND','Watch not found.');args={...w,...args,expected_generation:w.generation};delete args.owner_thread_id;delete args.generation;delete args.delivery;delete args.check_interval_seconds;}args.destination_thread_id??=args.caller_thread_id;args.events??=['turn_ended'];}
     else{await (ensure?ensure():ensureAsController(stateDir,config));const s=await controllerRequest(stateDir,'status');args.expected_generation=s.watches.find(w=>w.watch_id===args.watch_id)?.generation;}
    }
    validateTool(name,args);const tool=asTools.find(t=>t.name===name);if(name==='as_chat_manage'&&args.action==='operation_status'||name.startsWith('as_heartbeat_')||!tool.annotations.readOnlyHint&&!(name==='as_chat_manage'&&args.action==='operation_status'))callerContext(meta,args.caller_thread_id);
    let value;
    if(name==='as_status'||name==='as_control'){value=await localManagement(stateDir,config,{name,args,meta});}
    else if(name==='as_heartbeat_list'||name==='as_watch_list'||name==='as_chat_manage'&&args.action==='operation_status'){
     requireValue(!args.backend_id||args.backend_id===config.backend_id,'BACKEND_MISMATCH','Choose this backend profile.');
     try{if(!call)matchesController(await controllerRequest(stateDir,'status',{},1000),config);value=await (call?call({name,args,meta}):controllerRequest(stateDir,'tool',{name,args,meta},1000));}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;value=await readLocalTool(stateDir,config,{name,args,meta});}
    }else{await (ensure?ensure():ensureAsController(stateDir,config));value=await (call?call({name,args,meta}):controllerRequest(stateDir,'tool',{name,args,meta},60000));}
    if(original==='watch_thread'){requireValue(value.operation?.status==='accepted',value.operation?.error?.code??'OPERATION_UNRESOLVED',value.operation?.error?.message??'Inspect the recorded operation outcome.');value=value.operation.result;}
    if(original==='list_thread_watchers')value={watchers:value.watches,monitoring:value.monitoring};
    result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:['failed','ambiguous'].includes(value.operation?.status)};
   }catch(e){const value={error:errorResult(e)};result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:true};}
  }else requireValue(false,'METHOD_NOT_FOUND','Unknown MCP method.');}
  write({jsonrpc:'2.0',id:r.id,result});
 }catch(e){write({jsonrpc:'2.0',id:r?.id??null,error:{code:e instanceof SyntaxError?-32700:e.code==='METHOD_NOT_FOUND'?-32601:-32600,message:e instanceof SyntaxError?'Parse error':e.message}});}}
 await dashboard?.close();
}
