// R: Adapt a single existing App Server's UDS protocol to completion observation and normal thread input.
import {EventEmitter} from 'node:events';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {UnixWebSocket} from './websocket.js';
import {WatchError,requireValue} from './errors.js';
export const defaultBackendSocket=()=>resolve(process.env.THREAD_WATCH_BACKEND_SOCKET??join(process.env.CODEX_HOME??join(homedir(),'.codex'),'app-server-control','app-server-control.sock'));
export class AppServerBackend extends EventEmitter {
 constructor({socketPath=defaultBackendSocket(),timeout=15000,transport,clientInfo={name:'thread-watch-plugin',version:'0.4.0'},capabilityErrors=false}={}){
  super();this.clientInfo=clientInfo;this.capabilityErrors=capabilityErrors;this.socketPath=socketPath;this.timeout=timeout;this.transport=transport??new UnixWebSocket(socketPath,{timeout});this.pending=new Map();this.subscribed=new Set();this.counter=0;this.connected=false;
  this.transport.on('message',text=>this.received(text));this.transport.on('close',()=>this.fail(new WatchError('BACKEND_DISCONNECTED','App Server connection closed; monitoring is unknown.')));this.transport.on('fault',()=>this.fail(new WatchError('BACKEND_PROTOCOL','App Server transport failed.')));
 }
 async connect(){
  try{await this.transport.connect();const result=await this.request('initialize',{clientInfo:this.clientInfo,capabilities:{experimentalApi:true}});this.transport.send(JSON.stringify({method:'initialized',params:{}}));this.identity={codex_home:result.codexHome??null,user_agent:result.userAgent??null};this.connected=true;return this.identity;}
  catch(e){this.fail(e);throw e;}
 }
 request(method,params){
  try{this.authorizeRequest?.(method);}catch(e){return Promise.reject(e);}
  if(this.failure)return Promise.reject(this.failure);
  return new Promise((resolve,reject)=>{
   const id=++this.counter,timer=setTimeout(()=>{this.pending.delete(id);reject(new WatchError('BACKEND_TIMEOUT','App Server request timed out; submitted input outcome may be unknown.',{method}));},this.timeout);
   this.pending.set(id,{resolve,reject,timer,method});try{this.transport.send(JSON.stringify({id,method,params}));}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
  });
 }
 received(text){
  let value;try{value=JSON.parse(text);}catch{this.fail(new WatchError('BACKEND_PROTOCOL','Invalid App Server JSON.'));this.transport.close();return;}
  if(value.id!==undefined&&value.method){try{this.transport.send(JSON.stringify({id:value.id,error:{code:-32601,message:'Monitoring client does not handle execution requests.'}}));}catch{}return;}
  if(value.id!==undefined){const p=this.pending.get(value.id);if(!p)return;this.pending.delete(value.id);clearTimeout(p.timer);
   if(value.error){
    const upstream=value.error,details={method:p.method,rpc_code:upstream.code};
    if(Object.hasOwn(upstream,'message'))details.rpc_message=upstream.message;
    if(Object.hasOwn(upstream,'data'))details.rpc_data=upstream.data;
    p.reject(new WatchError(this.capabilityErrors&&upstream.code===-32601?'UNSUPPORTED_CAPABILITY':'BACKEND_REJECTED',typeof upstream.message==='string'?upstream.message:'App Server rejected the request.',details));
   }else if(!value.result||typeof value.result!=='object')p.reject(new WatchError('BACKEND_PROTOCOL','App Server returned an invalid result.'));else p.resolve(value.result);return;
  }
  this.emit('notification',{method:value.method,params:value.params});
  if(value.method==='turn/completed'){
   const p=value.params;if(typeof p?.threadId==='string'&&typeof p.turn?.id==='string'&&['completed','interrupted','failed'].includes(p.turn.status))this.emit('completed',{source_thread_id:p.threadId,turn_id:p.turn.id,status:p.turn.status,kind:'completion'});
  }
 }
 async readThread(id){const r=await this.request('thread/read',{threadId:id,includeTurns:false});requireValue(r?.thread?.id===id,'BACKEND_PROTOCOL','App Server returned an unexpected thread identity.');return r.thread;}
 async observe(id,{refresh=false}={}){
  if(this.subscribed.has(id)&&!refresh)return;
  const r=await this.request('thread/resume',{threadId:id,excludeTurns:true});requireValue(r?.thread?.id===id,'BACKEND_PROTOCOL','App Server resumed an unexpected thread.');this.subscribed.add(id);
 }
 async destination(id){
  let t=await this.readThread(id);
  if(t.status?.type==='notLoaded'){await this.observe(id,{refresh:true});t=await this.readThread(id);}
  requireValue(t.canAcceptDirectInput===true,'DIRECT_INPUT_UNAVAILABLE','Destination must explicitly accept direct input; internal agents require their owner control route.');return t;
 }
 async deliver(id,text,{isCurrent=()=>true,onSubmit=()=>{}}={}){
  const t=await this.destination(id),input=[{type:'text',text}];
  if(t.status?.type==='active'){
   const page=await this.request('thread/turns/list',{threadId:id,limit:1,sortDirection:'desc',itemsView:'notLoaded'}),turn=page?.data?.find(x=>x.status==='inProgress');
   requireValue(turn?.id,'DESTINATION_STATE_UNKNOWN','Active destination has no current turn identity.');
   requireValue(isCurrent(),'DELIVERY_CANCELLED','Watch changed or backend disconnected before submission.');
   onSubmit();return this.request('turn/steer',{threadId:id,expectedTurnId:turn.id,input});
  }
  requireValue(t.status?.type==='idle','DESTINATION_STATE_UNKNOWN','Destination is not idle or active.');
  requireValue(isCurrent(),'DELIVERY_CANCELLED','Watch changed or backend disconnected before submission.');
  onSubmit();return this.request('turn/start',{threadId:id,input});
 }
 fail(error){if(this.failure)return;this.failure=error;this.connected=false;this.subscribed.clear();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('disconnected',error);}
 close(){this.fail(new WatchError('BACKEND_DISCONNECTED','App Server client closed.'));this.transport.close();}
}
