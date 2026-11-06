// R: Persist bounded actor/target/event suppression windows to break feedback from related as_ actions.
import {readFile} from 'node:fs/promises';
import {atomicJson} from './operation-journal.js';
import {requireValue} from './errors.js';
export const relatedEvents=['goal_updated','goal_cleared','user_prompt'];
export class SelfSuppression{
 constructor(file,{now=Date.now,seconds=5}={}){requireValue(Number.isInteger(seconds)&&seconds>=1&&seconds<=60,'INVALID_CONFIG','self_suppression_seconds must be 1..60.');this.file=file;this.now=now;this.seconds=seconds;this.windows=[];this.tail=Promise.resolve();}
 async load(){try{this.windows=JSON.parse(await readFile(this.file,'utf8'));requireValue(Array.isArray(this.windows),'SUPPRESSION_STATE','Invalid suppression state.');}catch(e){if(e.code!=='ENOENT')throw e;}this.windows=this.windows.filter(w=>w.until_ms>this.now());}
 mark(actor,target,kinds=relatedEvents,operation_id=null){const task=this.tail.then(async()=>{const now=this.now(),row={actor_thread_id:actor,target_thread_id:target,kinds:[...kinds],operation_id,started_ms:now,until_ms:now+this.seconds*1000};const next=this.windows.filter(w=>w.until_ms>now);next.push(row);await atomicJson(this.file,next);this.windows=next;return structuredClone(row);});this.tail=task.catch(()=>{});return task;}
 snapshot(event){const at=Date.parse(event.received_at);return structuredClone(this.windows.filter(w=>w.target_thread_id===event.source_thread_id&&w.kinds.includes(event.kind)&&at>=w.started_ms&&at<w.until_ms));}
 match(event,watch){if(watch.suppress_self===false||!relatedEvents.includes(event.kind))return null;const at=Date.parse(event.received_at);const row=(event.self_suppression_windows??this.windows).findLast(w=>[watch.owner_thread_id,watch.destination_thread_id].includes(w.actor_thread_id)&&w.target_thread_id===event.source_thread_id&&w.kinds.includes(event.kind)&&at>=w.started_ms&&at<w.until_ms);return row?{actor_thread_id:row.actor_thread_id,operation_id:row.operation_id,until:new Date(row.until_ms).toISOString(),reason:'related_as_action_window',heuristic:true}:null;}
}
