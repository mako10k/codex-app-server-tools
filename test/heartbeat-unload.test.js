// R: Verify first delivery, unload and next due retain the exact destination and never duplicate a slot.
import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {AsService} from '../src/as-service.js';import {Registry} from '../src/registry.js';import {loadConfig} from '../src/as-config.js';
test('registered heartbeat survives unload despite a cached observation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'as-public-hb-unload-'));let s,now=Date.now();const sent=[],owner='fixture-owner';
 class Backend extends EventEmitter{
  constructor(){super();this.identity={codex_home:dir,user_agent:'fixture/0.166.0'};this.subscribed=new Set();this.transport={};this.loaded=true;this.resumes=0;}
  async connect(){this.connected=true;}
  async readThread(id){assert.equal(id,owner);return{id,status:{type:this.loaded?'idle':'notLoaded'},canAcceptDirectInput:this.loaded?true:null};}
  async observe(id,{refresh=false}={}){assert.equal(id,owner);if(this.subscribed.has(id)&&!refresh)return;this.loaded=true;this.resumes++;this.subscribed.add(id);}
  async request(method,p){if(method==='thread/list')return{data:[{id:owner}],nextCursor:null};if(method==='turn/start'){assert.equal(p.threadId,owner);sent.push(p);return{turn:{id:'fixture-turn'}};}if(method==='thread/items/list')return{data:[{turnId:'fixture-turn',item:{type:'userMessage',content:sent.at(-1).input}}]};throw Error('Unexpected method '+method);}
  close(){this.connected=false;}
 }
 try{const profile=join(dir,'profile.json');await writeFile(profile,JSON.stringify({expected_codex_home:dir,socket_path:join(dir,'unused.sock'),compatibility_file:join(dir,'no-operator-settings.json')}));const config=await loadConfig(profile),registry=new Registry(join(dir,'registry.json'));await registry.load();const b=new Backend();s=await new AsService(registry,{config,backendFactory:()=>b,verifyVersion:async()=>({stdout:'codex-cli 0.166.0'}),heartbeatOptions:{now:()=>now,automatic:false}}).init();const meta={'openai/threadId':owner,'openai/turnId':'fixture-turn'};const r=await s.handle({name:'as_heartbeat_set',meta,args:{caller_thread_id:owner,operation_id:'public-unload-test',starts_at:new Date(now).toISOString(),expires_at:new Date(now+3600000).toISOString(),checks:[{check_id:'check',interval_seconds:900}]}});assert.equal(r.operation.status,'accepted');now+=900000;await s.heartbeats.tick();assert.equal(sent.length,1);b.loaded=false;now+=900000;await s.heartbeats.tick();assert.equal(sent.length,2);assert.equal(b.resumes,2);await s.heartbeats.tick();assert.equal(sent.length,2);assert.equal(s.heartbeats.list({},owner).heartbeats[0].state,'scheduled');}
 finally{await s?.close();await rm(dir,{recursive:true,force:true});}
});
