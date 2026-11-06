// R: Read watch relationships and heartbeat snapshots without starting or mutating any service.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {controllerRequest} from './control.js';
async function optionalJson(path){try{return {data:JSON.parse(await readFile(path,'utf8')),error:null};}catch(e){return {data:null,error:e.code==='ENOENT'?null:{code:e.code??'READ_ERROR',message:e.message}};}}
export async function dashboardSnapshot(stateDir,{home=homedir(),now=()=>new Date(),sources}={}){
 const origins=sources??[{id:'candidate',label:'App Server Tools',dir:stateDir},{id:'pinned',label:'従来のApp Server監視',dir:join(home,'.local/state/thread-watch-plugin-app-server')},{id:'legacy',label:'旧登録',dir:join(home,'.local/state/thread-watch-plugin')}];
 const watches=[],heartbeats=[],profiles=[];
 for(const origin of origins){
  const [registry,hb]=await Promise.all([optionalJson(join(origin.dir,'registry.json')),optionalJson(join(origin.dir,'heartbeats.json'))]);
  let live=null,statusError=null;
  // IPC status is observation only: never ensure/start/resume a controller.
  try{live=await controllerRequest(origin.dir,'status',{},500);}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))statusError={code:e.code??'STATUS_ERROR',message:e.message};}
  const source={id:origin.id,label:origin.label};
  profiles.push({...source,present:!!(registry.data||hb.data),controller_running:!!live,connected:live?.connected??null,build:live?.controller_build_version??live?.controller_version??null,error:registry.error??hb.error??statusError});
  for(const w of registry.data?.watches??[]){const attempts=(registry.data.attempts??[]).filter(a=>a.watch_id===w.watch_id);watches.push({...w,origin:source,controller_running:!!live,connected:live?.connected??null,last_attempt:attempts.at(-1)??null});}
  for(const r of hb.data?.registrations??[]){const deliveries=(hb.data.deliveries??[]).filter(d=>d.heartbeat_id===r.heartbeat_id);heartbeats.push({...r,origin:source,state:r.state!=='removed'&&Date.parse(r.expires_at)<=now().getTime()?'expired':r.state,controller_running:!!live,connected:live?.connected??null,deliveries:deliveries.slice(-5)});}
 }
 const thread_names={};let names_error=null;
 const ids=[...new Set([...watches.flatMap(w=>[w.source_thread_id,w.destination_thread_id,w.owner_thread_id]),...heartbeats.flatMap(r=>[r.owner_thread_id,r.target_thread_id])].filter(Boolean))];
 if(ids.length){try{const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(process.env.CODEX_SQLITE_HOME??process.env.CODEX_HOME??join(home,'.codex'),'state_5.sqlite'),{readOnly:true});try{for(const row of db.prepare(`SELECT id, COALESCE(NULLIF(name,''),title) AS label FROM threads WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids))if(row.label)thread_names[row.id]=row.label;}finally{db.close();}}catch(e){names_error={code:e.code??'NAMES_UNAVAILABLE',message:e.message};}}
 return {observed_at:now().toISOString(),watches,heartbeats,profiles,thread_names,names_error};
}
