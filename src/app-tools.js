// R: Call the configured standard App Tools MCP using the actual triggering thread/turn context.
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {WatchError,requireValue} from './errors.js';
import {threadId} from './registry.js';
const exec=promisify(execFile);
const DIRECT_SUBAGENT_REFUSAL='direct app-server input is not allowed for multi-agent v2 sub-agents';
// Only fixed host error signatures become persisted diagnostics; never retain arbitrary backend text.
export function appToolsFailure(response,{rpc=false}={}){
 const messages=[];
 if(typeof response?.message==='string')messages.push(response.message.slice(0,8192));
 for(const item of response?.content??[]){if(item?.type==='text'&&typeof item.text==='string')messages.push(item.text.slice(0,8192));if(messages.length>=8)break;}
 const values=messages.flatMap(text=>{try{const value=JSON.parse(text);return[text,...[value?.message,value?.error?.message].filter(x=>typeof x==='string')];}catch{return[text];}});
 const details={reason:'unclassified'};
 if(rpc&&Number.isSafeInteger(response?.code))details.rpcCode=response.code;
 if(values.some(text=>text.trim().replace(/^Error:\s*/,'')===DIRECT_SUBAGENT_REFUSAL))return new WatchError('APP_TOOLS_AGENT_CONTROL_REQUIRED','Standard App tools cannot start a V2 internal agent; use an owner-approved agent-control route or an independent chat.',{...details,reason:'v2_subagent_direct_input_forbidden',notSubmitted:true});
 if(values.some(text=>/^Cannot steer conversation [A-Za-z0-9-]+ without an active turn id$/.test(text.trim().replace(/^Error:\s*/,''))))return new WatchError('APP_TOOLS_STEER_CONTEXT','Standard App tools could not resolve the destination active turn.',{...details,reason:'destination_active_turn_missing'});
 if(rpc)details.reason=({[-32600]:'invalid_request',[-32602]:'invalid_params',[-32603]:'internal_error'})[response?.code]??'rpc_error';
 return new WatchError('APP_TOOLS_REJECTED',rpc?'App Tools request did not produce a successful result.':'Standard App tool returned an error.',details);
}
export function callerContext(metadata={},expectedThread){
 let turnMetadata=metadata['x-codex-turn-metadata']??{};
 if(typeof turnMetadata==='string'){try{turnMetadata=JSON.parse(turnMetadata);}catch{turnMetadata={};}}
 const source=metadata['openai/threadId']??turnMetadata.thread_id;
 const turn=metadata['openai/turnId']??turnMetadata.turn_id;
 requireValue(typeof source==='string'&&typeof turn==='string','RUNTIME_CONTEXT_REQUIRED','Actual runtime thread and turn metadata are required for registration.');
 threadId(source,'runtime thread_id');threadId(turn,'runtime turn_id');
 requireValue(!expectedThread||source===expectedThread,'CALLER_MISMATCH','Explicit caller must match the runtime thread context.');
 return {threadId:source,turnId:turn,hostId:'local'};
}
export class AppTools {
 constructor({transport,timeout=15000}={}){this.transport=transport;this.timeout=timeout;this.pending=new Map();this.counter=0;}
 async connect(){
  let transport=this.transport;
  if(!transport){
   // Package updates can remove this long-lived MCP process's inherited cwd.
   // Resolve the same explicit user config domain from its stable home, not a version cache.
   let configs;try{const r=await exec(process.env.THREAD_WATCH_CODEX_PATH??'codex',['mcp','list','--json'],{cwd:process.env.CODEX_HOME||homedir(),timeout:this.timeout,maxBuffer:4*1024*1024});configs=JSON.parse(r.stdout);}catch{throw new WatchError('APP_TOOLS_CONFIG','Cannot resolve standard codex_app MCP config. Make the existing Codex CLI available or set THREAD_WATCH_CODEX_PATH.');}
   // The App enables its built-in server at session startup. A separate CLI listing
   // can show the saved disabled stub; use its transport only with the real App's
   // inherited pipe. Each call still supplies and is checked against real runtime metadata.
   const config=configs.find(x=>x.name==='codex_app'&&!x.disabled_reason&&(x.enabled||process.env.CODEX_APP_TOOLS_PIPE_PATH));
   requireValue(config?.transport?.type==='stdio','APP_TOOLS_UNAVAILABLE','An enabled standard codex_app stdio MCP is required.');transport=config.transport;
  }
  this.child=spawn(transport.command,transport.args??[],{cwd:transport.cwd??undefined,env:{...process.env,...transport.env},stdio:['pipe','pipe','pipe']});
  this.child.stdin.on('error',()=>this.fail(new WatchError('APP_TOOLS_DISCONNECTED','App Tools stdin failed.')));
  this.child.stderr.resume(); // Never forward credentials or backend payloads into hook stdout/logs.
  this.child.on('error',()=>this.fail(new WatchError('APP_TOOLS_UNAVAILABLE','Standard App Tools MCP could not start.')));
  this.child.on('exit',()=>this.fail(new WatchError('APP_TOOLS_DISCONNECTED','Standard App Tools MCP exited; submitted send outcome may be unknown.')));
  this.lines=readline.createInterface({input:this.child.stdout,crlfDelay:Infinity});
  this.lines.on('line',line=>{try{const m=JSON.parse(line),p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);if(m.error)p.reject(appToolsFailure(m.error,{rpc:true}));else p.resolve(m.result);}catch{this.fail(new WatchError('APP_TOOLS_PROTOCOL','Invalid standard MCP response.'));}});
  this.lines.on('error',()=>this.fail(new WatchError('APP_TOOLS_PROTOCOL','App Tools MCP read failed.')));
  await this.request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'thread-watch',version:'0.3.1'}});
  this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 }
 request(method,params){return new Promise((resolve,reject)=>{const id=++this.counter,timer=setTimeout(()=>{this.pending.delete(id);reject(new WatchError('APP_TOOLS_TIMEOUT','App Tools request timed out; submitted send outcome may be unknown.'));},this.timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(new WatchError('APP_TOOLS_DISCONNECTED','App Tools write failed.'));}});});}
 async call(name,args,context){
  threadId(context?.threadId,'runtime thread_id');threadId(context?.turnId,'runtime turn_id');
  const r=await this.request('tools/call',{name,arguments:args,_meta:{'openai/threadId':context.threadId,'openai/turnId':context.turnId,'openai/toolCallId':`thread-watch-${randomUUID()}`}});
  requireValue(r&&typeof r==='object','APP_TOOLS_PROTOCOL','App tool returned no result object.');
  if(r.isError)throw appToolsFailure(r);
  const text=r.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n');
  requireValue(typeof text==='string'&&text.length>0,'APP_TOOLS_PROTOCOL','App tool returned no readable result.');
  try{return JSON.parse(text);}catch{throw new WatchError('APP_TOOLS_PROTOCOL','App tool returned invalid structured text.');}
 }
 async readThread(id,context){return this.call('read_thread',{threadId:id,hostId:context.hostId??'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:0},context);}
 async deliver(id,prompt,context){return this.call('send_message_to_thread',{threadId:id,hostId:context.hostId??'local',prompt},context);}
 fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
 async close(){if(!this.child)return;this.lines?.close();this.child.stdin.end();this.child.kill('SIGTERM');this.fail(new WatchError('APP_TOOLS_DISCONNECTED','App Tools client closed.'));}
}
