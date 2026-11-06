// R: Keep body-free progress observations, coverage gaps and resumable local event cursors.
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {atomicJson} from './operation-journal.js';
import {WatchError} from './errors.js';
export class ProgressStore extends EventEmitter{
 constructor(file){super();this.file=file;this.data={sequence:0,events:[],gaps:[]};this.instance=randomUUID();this.epoch=0;this.active=new Map();this.expired=new Map();this.tail=Promise.resolve();}
 async load(){try{this.data=JSON.parse(await readFile(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}this.epoch=this.data.gaps.at(-1)?.epoch??0;for(const [id,scope]of Object.entries(this.data.leases??{}))this.active.set(id,scope);await this.gap('controller_started');}
 save(){const value=structuredClone(this.data);const p=this.tail.then(()=>atomicJson(this.file,value));this.tail=p.catch(e=>{this.lastError={code:e.code??'PROGRESS_STORAGE'};this.emit('changed');});return p;}
 gap(reason){const at=new Date().toISOString();for(const [id,scope]of this.active)this.expired.set(id,{...scope,expired_at:at});this.active.clear();this.data.leases={};this.epoch++;this.data.gaps.push({epoch:this.epoch,started_at:at,reason});this.emit('changed');return this.save();}
 attach(id,origin){const current=this.active.get(id);this.active.set(id,{epoch:this.epoch,started_at:current?.started_at??new Date().toISOString(),origin:current?.origin==='watch'?'watch':origin});this.data.leases=Object.fromEntries(this.active);void this.save().catch(()=>{});return this.coverage(id);}
 temporary(id){const lease=this.active.get(id);if(lease){lease.origin='residual';this.data.leases=Object.fromEntries(this.active);void this.save().catch(()=>{});}}
 coverage(id){return{storage_error:this.lastError??null,subscription_active:this.active.has(id),subscription_scope:this.active.get(id)?.origin==='watch'?'persistent_watch':this.active.get(id)?.origin==='heartbeat'?'persistent_heartbeat':'connection_epoch',epoch:this.epoch,observation:this.active.get(id)??null,expired:this.expired.get(id)??null,gaps:structuredClone(this.data.gaps)};}
 observe(notification){const p=notification.params;if(!p?.threadId||!this.active.has(p.threadId))return;
  const method=notification.method;if(!['thread/status/changed','turn/started','turn/completed','item/started','item/completed','thread/goal/updated','thread/goal/cleared','error'].includes(method))return;
  const e={sequence:++this.data.sequence,thread_id:p.threadId,turn_id:p.turnId??p.turn?.id??null,item_id:p.item?.id??null,item_type:p.item?.type??null,method,status:p.turn?.status??p.status??null,received_at:new Date().toISOString(),server_at_ms:p.completedAtMs??p.startedAtMs??null,epoch:this.epoch};
  if(method==='thread/goal/updated'){e.goal_status=p.goal?.status??null;e.goal_updated_at=p.goal?.updatedAt??null;}
  if(p.item?.type==='contextCompaction')e.compaction=method==='item/started'?'started':'completed';
  this.data.events.push(e);void this.save().catch(()=>{});this.emit('changed');
 }
 page(id,cursor){let after=0;if(cursor){const [instance,seq]=cursor.split(':');if(instance!==this.instance||!/^\d+$/.test(seq??''))throw new WatchError('CURSOR_EXPIRED','Cursor belongs to another controller instance.');after=Number(seq);if(after>this.data.sequence)throw new WatchError('CURSOR_EXPIRED','Cursor is beyond current coverage.');}
  const observed=this.data.events.filter(e=>e.thread_id===id),compactions=new Map();for(const e of observed)if(e.compaction)compactions.set(e.turn_id+':'+e.item_id,{turn_id:e.turn_id,item_id:e.item_id,phase:e.compaction==='started'&&(e.epoch!==this.epoch||!this.active.has(id))?'unknown':e.compaction,observed_at:e.received_at});
  const all=this.data.events.filter(e=>e.thread_id===id&&e.sequence>after),events=all.slice(0,100),next=events.at(-1)?.sequence??this.data.sequence;return{events,last_activity:observed.at(-1)??null,compactions:[...compactions.values()].slice(-20),next_cursor:this.instance+':'+next,has_more:all.length>100,coverage:this.coverage(id)};
 }
 async read(id,cursor,wait=0){let page=this.page(id,cursor);if(wait&&!page.events.length){await new Promise(resolve=>{const done=()=>{clearTimeout(timer);this.off('changed',done);resolve();};const timer=setTimeout(done,wait);this.on('changed',done);});page=this.page(id,cursor);}return page;}
 async close(){this.emit('changed');await this.tail;}
}
