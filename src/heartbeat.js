// R: Own bounded self-chat schedules and durable dispatch receipts independently of external polling results.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {atomicJson,digest} from './operation-journal.js';
import {WatchError,requireValue,errorResult} from './errors.js';
const iso=n=>new Date(n).toISOString();
function date(value){requireValue(typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value)),'INVALID_ARGUMENT','Use an ISO datetime with an explicit offset.');const [y,m,d,h,min,sec]=value.match(/^\d+/)?[Number(value.slice(0,4)),Number(value.slice(5,7)),Number(value.slice(8,10)),Number(value.slice(11,13)),Number(value.slice(14,16)),Number(value.slice(17,19))]:[];const days=[31,(y%4===0&&(y%100!==0||y%400===0))?29:28,31,30,31,30,31,31,30,31,30,31];requireValue(m>=1&&m<=12&&d>=1&&d<=days[m-1]&&h<24&&min<60&&sec<60,'INVALID_ARGUMENT','Invalid calendar datetime.');return Date.parse(value);}
export class Heartbeats{
 constructor(file,service,{now=Date.now,gate=async()=>true,automatic=true}={}){this.file=file;this.service=service;this.now=now;this.gate=gate;this.automatic=automatic;this.data={schema:1,registrations:[],deliveries:[]};this.tail=Promise.resolve();this.closed=false;}
 serial(fn){const p=this.tail.then(fn);this.tail=p.catch(e=>{this.lastError=errorResult(e);});return p;}
 async load(){try{this.data=JSON.parse(await readFile(this.file,'utf8'));requireValue(this.data.schema===1&&Array.isArray(this.data.registrations)&&Array.isArray(this.data.deliveries),'HEARTBEAT_STATE','Invalid heartbeat state.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const now=this.now();for(const r of this.data.registrations){if(r.state==='removed')continue;if(now>=r.expires_ms)r.state='expired';for(const c of r.checks){if(c.pending){r.gap={reason:'controller_restart',at:iso(now)};delete c.pending;}this.skip(r,c,now,'controller_restart');}}
  for(const d of this.data.deliveries)if(['prepared','submitted'].includes(d.status)){d.status='ambiguous';d.finished_at=iso(now);}await this.save();return this;
 }
 async save(){try{await atomicJson(this.file,this.data);}catch(e){this.storageError=errorResult(e);throw e;}}
 profile(){return this.service.config.heartbeat??{};}
 grant(r){requireValue(r.backend_id===this.service.config.backend_id,'BACKEND_MISMATCH','Heartbeat backend differs.');return this.profile();}
 active(){return this.data.registrations.filter(r=>!['removed','expired'].includes(r.state)&&this.now()<r.expires_ms);}
 async set(a,owner,submit=async()=>{}){return this.serial(async()=>{
  const p=this.profile();const start=date(a.starts_at),end=date(a.expires_at);requireValue(start<end&&end>this.now(),'INVALID_ARGUMENT','Heartbeat expiry must be in the future and after starts_at.');
  const old=a.heartbeat_id?this.data.registrations.find(r=>r.heartbeat_id===a.heartbeat_id):null;
  if(a.heartbeat_id)requireValue(old&&old.owner_thread_id===owner&&old.generation===a.expected_generation,'GENERATION_CONFLICT','Owned heartbeat generation changed.');
  else requireValue(a.expected_generation===undefined,'INVALID_ARGUMENT','New heartbeat does not take expected_generation.');
  const duplicate=this.active().find(r=>r.owner_thread_id===owner&&r.heartbeat_id!==old?.heartbeat_id);if(duplicate)throw new WatchError('HEARTBEAT_EXISTS','An active self heartbeat already exists.',{heartbeat_id:duplicate.heartbeat_id});
  const seen=new Set();const checks=a.checks.map(c=>{const cat=Array.isArray(p.catalog)?p.catalog.find(x=>x.check_id===c.check_id):null;requireValue(!seen.has(c.check_id),'INVALID_ARGUMENT','Duplicate check_id.');seen.add(c.check_id);const first=c.first_due_at?date(c.first_due_at):start+c.interval_seconds*1000;requireValue(first>=start&&first<end,'INVALID_ARGUMENT','First due time must lie in the registration window.');return{check_id:c.check_id,label:cat?.label??c.check_id,scope_ref:cat?.scope_ref??'',interval_ms:c.interval_seconds*1000,first_ms:first,next_ms:first};});
  const r={heartbeat_id:old?.heartbeat_id??randomUUID(),owner_thread_id:owner,target_thread_id:owner,backend_id:this.service.config.backend_id,generation:(old?.generation??0)+1,starts_at:iso(start),expires_at:iso(end),starts_ms:start,expires_ms:end,profile_digest:digest(p),state:'scheduled',checks,created_at:old?.created_at??iso(this.now()),updated_at:iso(this.now())};
  // Slots already in the past at registration/update are skipped, never sent immediately.
  for(const c of r.checks)this.skip(r,c,this.now(),'registration');
  const preview=this.view(r);preview.deliveries=[];preview.deliveries_omitted=0;requireValue(Buffer.byteLength(JSON.stringify(preview))<=32768,'HEARTBEAT_SIZE','Registration exceeds the 32KiB response budget; use shorter catalog labels or scope references.');
  await submit();if(old)this.data.registrations[this.data.registrations.indexOf(old)]=r;else this.data.registrations.push(r);await this.save();this.arm();return this.view(r);
 });}
 async remove(a,owner,submit=async()=>{}){return this.serial(async()=>{const r=this.data.registrations.find(x=>x.heartbeat_id===a.heartbeat_id);requireValue(r&&r.owner_thread_id===owner&&r.generation===a.expected_generation,'GENERATION_CONFLICT','Owned heartbeat generation changed.');await submit();r.state='removed';r.generation++;for(const c of r.checks)delete c.pending;r.updated_at=iso(this.now());await this.save();this.arm();return{...this.view(r),submitted_inputs_cancelled:false,watches_changed:false};});}
 view(r){const copy=structuredClone(r);delete copy.profile_digest;delete copy.starts_ms;delete copy.expires_ms;copy.checks=copy.checks.map(c=>({check_id:c.check_id,label:c.label,scope_ref:c.scope_ref,interval_seconds:c.interval_ms/1000,next_due_at:!['removed','expired'].includes(r.state)&&c.next_ms<r.expires_ms?iso(c.next_ms):null,pending:c.pending??null}));if(copy.state!=='removed'&&this.now()>=r.expires_ms)copy.state='expired';copy.deliveries=[];copy.timezone=this.service.config.heartbeat?.timezone??'UTC';copy.watch_coalescing=false;const history=this.data.deliveries.filter(d=>d.heartbeat_id===r.heartbeat_id);for(const d of history.slice(-5).reverse()){const receipt={...structuredClone(d),reasons:(d.reasons??[]).map(({check_id,from,to,count})=>({check_id,from,to,count}))};if(Buffer.byteLength(JSON.stringify({...copy,deliveries:[receipt,...copy.deliveries]}))>54000)break;copy.deliveries.unshift(receipt);}copy.deliveries_omitted=history.length-copy.deliveries.length;return copy;}
 list(a,owner){const scope=digest([owner,this.service.config.backend_id,a.heartbeat_id??null]);let offset=0;if(a.cursor){const [hash,n]=a.cursor.split(':');requireValue(hash===scope&&/^\d+$/.test(n??''),'INVALID_CURSOR','Heartbeat cursor scope mismatch.');offset=Number(n);}const all=this.data.registrations.filter(r=>r.owner_thread_id===owner&&(!a.heartbeat_id||r.heartbeat_id===a.heartbeat_id));const rows=[];let bytes=0;for(const r of all.slice(offset,offset+(a.limit??10))){const row=this.view(r),size=Buffer.byteLength(JSON.stringify(row));if(rows.length&&bytes+size>55000)break;rows.push(row);bytes+=size;}const next=offset+rows.length;return{heartbeats:rows,next_cursor:next<all.length?scope+':'+next:null,has_more:next<all.length,storage_error:this.storageError??null,gate_error:this.gateError??null};}
 skip(r,c,now,reason){if(c.next_ms>=now)return;const count=Math.ceil((now-c.next_ms)/c.interval_ms);r.missed_count=(r.missed_count??0)+count;r.gap={reason,at:iso(now)};c.next_ms+=count*c.interval_ms;}
 arm(){clearTimeout(this.timer);this.timer=null;if(this.closed||this.storageError||!this.automatic||this.service.services?.heartbeat===false)return;const now=this.now(),deadlines=this.active().filter(r=>r.state!=='suspended').flatMap(r=>[r.expires_ms,...r.checks.filter(c=>c.next_ms<r.expires_ms).map(c=>c.next_ms),...(r.checks.some(c=>c.pending)?[now+60000]:[])]);if(!deadlines.length)return;const delay=Math.min(2147483647,Math.max(1,Math.min(...deadlines)-now));this.timer=setTimeout(()=>{void this.tick().catch(()=>{});},delay);this.timer.unref();}
 wake(){if(!this.closed)void this.tick().catch(()=>{});}
 tick(){return this.serial(async()=>{try{await this.run();}finally{this.arm();}});}
 async allowed(profile){try{const outcome=await this.gate(profile);this.gateDeadline=outcome===true?Infinity:outcome?.valid_until;return outcome===true||outcome?.allowed===true&&Number.isFinite(this.gateDeadline)&&this.gateDeadline>Date.now();}catch(e){this.gateError=errorResult(e);return false;}}
 async run(){await this.service.refreshServices?.();if(this.service.services?.heartbeat===false)return;await this.service.refreshCompatibility?.();if(this.service.stopping)return;requireValue(!this.storageError,'HEARTBEAT_STORAGE','Heartbeat storage failed; inspect before restarting.');const now=this.now(),s=this.service;
  for(const r of this.data.registrations){if(['removed','expired'].includes(r.state))continue;if(now>=r.expires_ms){r.state='expired';for(const c of r.checks)delete c.pending;continue;}
   if(r.state==='suspended')continue;
   for(const c of r.checks){if(c.next_ms>now||c.next_ms>=r.expires_ms)continue;if(!s.connected){this.skip(r,c,now+1,'backend_disconnected');continue;}
    // Only slots within grace observed while connected become reasons; older slots are gaps.
    if(now-c.next_ms>60000)this.skip(r,c,now-60000,'clock_gap');
    if(c.next_ms<=now&&c.next_ms<r.expires_ms){const n=Math.floor((now-c.next_ms)/c.interval_ms)+1,last=c.next_ms+(n-1)*c.interval_ms;const pending=c.pending??{from:iso(c.next_ms),count:0};pending.to=iso(last);pending.count+=n;c.pending=pending;c.next_ms+=n*c.interval_ms;}
   }
  }await this.save();
  for(const r of this.active()){if(r.state==='suspended'||!r.checks.some(c=>c.pending))continue;
   try{const p=this.grant(r);if(!s.connected){r.hold_reason='backend_disconnected';continue;}if(!await this.allowed(p)){r.hold_reason='dispatch_not_ready';continue;}
    const b=s.backend,epoch=s.progress.epoch;let t=await this.target(b,r.owner_thread_id);if(t.status?.type!=='idle'){r.state='pending_busy';r.hold_reason=t.status?.type??'unknown';continue;}
    // No background reuse of runtime caller metadata: the durable self-chat grant is the authority.
    this.grant(r);if(this.now()>=r.expires_ms||s.stopping||s.services?.heartbeat===false||!s.connected||s.backend!==b||s.progress.epoch!==epoch)continue;
    const reasons=r.checks.filter(c=>c.pending).map(c=>({check_id:c.check_id,label:c.label,scope_ref:c.scope_ref,...c.pending}));
    const text='[App Server heartbeat]\n'+JSON.stringify({heartbeat_id:r.heartbeat_id,generation:r.generation,reasons});
    await s.suppression?.mark(r.owner_thread_id,r.owner_thread_id,undefined,'heartbeat:'+r.heartbeat_id+':'+r.generation);
    const d={batch_id:randomUUID(),heartbeat_id:r.heartbeat_id,generation:r.generation,reasons,payload_digest:digest(text),status:'prepared',created_at:iso(this.now())};this.data.deliveries.push(d);await this.save();
    // The final status check must never resume/steer an active chat.
    t=await this.target(b,r.owner_thread_id);if(t.status?.type!=='idle'){d.status='cancelled';r.state='pending_busy';continue;}
    this.grant(r);if(!await this.allowed(p)||this.now()>=r.expires_ms||s.stopping||s.services?.heartbeat===false||!s.connected||s.backend!==b||s.progress.epoch!==epoch){d.status='cancelled';continue;}
    d.status='submitted';await this.save();
    try{t=await this.target(b,r.owner_thread_id);}catch(e){d.status='cancelled';throw e;}
    if(t.status?.type!=='idle'){d.status='cancelled';r.state='pending_busy';r.hold_reason=t.status?.type??'unknown';await this.save();continue;}
    this.grant(r);if(this.now()>=r.expires_ms||Date.now()>=this.gateDeadline||s.stopping||s.services?.heartbeat===false||!s.connected||s.backend!==b||s.progress.epoch!==epoch){d.status='cancelled';await this.save();continue;}
    for(const c of r.checks)delete c.pending;
    try{const out=await b.request('turn/start',{threadId:r.owner_thread_id,input:[{type:'text',text}]});d.status='accepted';d.turn_id=out.turn?.id??null;d.readback='unavailable';if(d.turn_id)try{const page=await b.request('thread/items/list',{threadId:r.owner_thread_id,turnId:d.turn_id,limit:100,sortDirection:'desc'});if(page.data?.some(e=>e.turnId===d.turn_id&&e.item.type==='userMessage'&&e.item.content?.some(x=>x.type==='text'&&x.text===text)))d.readback='verified';}catch{}r.state='scheduled';r.hold_reason=null;
    }catch(e){d.status=e.code==='BACKEND_REJECTED'?'failed':'ambiguous';d.error=errorResult(e);}d.finished_at=iso(this.now());await this.save();
   }catch(e){r.state='suspended';r.hold_reason=errorResult(e);await this.save();}
  }await this.save();
 }
 async target(b,id){let t=await b.readThread(id);
  // Stored chat metadata alone does not expose archive state. Bound the live-list lookup;
  // failure to find the exact target is unknown, never permission to unarchive/resume it.
  let cursor,found=false;for(let n=0;n<10;n++){const page=await b.request('thread/list',{archived:false,useStateDbOnly:true,limit:100,...(cursor?{cursor}:{})});if(page.data?.some(x=>x.id===id)){found=true;break;}cursor=page.nextCursor;if(!cursor)break;}requireValue(found,'HEARTBEAT_TARGET','Target is archived or its active-list identity cannot be verified.');
  requireValue(['idle','active','notLoaded','waitingOnApproval','waitingOnUserInput'].includes(t.status?.type),'HEARTBEAT_TARGET','Target status is unknown or unavailable.');
  if(t.status.type==='notLoaded'){await b.observe(id,{refresh:true});t=await b.readThread(id);}
  requireValue(t.canAcceptDirectInput===true,'HEARTBEAT_TARGET','Loaded target must accept direct input.');return t;
 }
 async reconnect(){return this.serial(async()=>{const now=this.now();for(const r of this.active()){for(const c of r.checks){if(c.pending){delete c.pending;r.gap={reason:'backend_reconnected',at:iso(now)};}this.skip(r,c,now+1,'backend_reconnected');}if(r.state==='suspended')continue;try{this.grant(r);await this.target(this.service.backend,r.owner_thread_id);await this.service.backend.observe(r.owner_thread_id);this.service.progress.attach(r.owner_thread_id,'heartbeat');}catch(e){r.state='suspended';r.hold_reason=errorResult(e);}}await this.save();this.arm();});}
 async close(){this.closed=true;clearTimeout(this.timer);await this.tail;}
}

export async function readHeartbeatsOffline(file,config,args,owner){
const h=new Heartbeats(file,{config});let text;
 try{text=await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 if(text!==undefined){h.data=JSON.parse(text);let binding;try{binding=JSON.parse(await readFile(join(dirname(file),'as-binding.json'),'utf8'));}catch{throw new WatchError('BACKEND_MISMATCH','Stored heartbeat binding is unavailable.');}requireValue(binding.config_digest===digest(config),'BACKEND_MISMATCH','Stored heartbeat profile differs.');requireValue(h.data.schema===1&&Array.isArray(h.data.registrations)&&Array.isArray(h.data.deliveries),'HEARTBEAT_STATE','Invalid heartbeat state.');}
 return{backend_id:config.backend_id,observed_at:new Date().toISOString(),controller_running:false,offline:true,...h.list(args,owner)};
}
