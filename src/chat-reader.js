// R: Read chat identity and bounded history without loading or mutating the target session.
import {requireValue} from './errors.js';
const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
function decode(x){try{return JSON.parse(Buffer.from(x,'base64url').toString());}catch{requireValue(false,'INVALID_CURSOR','Invalid history cursor.');}}
function chunk(text,offset,max=8000){const chars=Array.from(text);requireValue(Number.isSafeInteger(offset)&&offset>=0&&offset<=chars.length,'INVALID_CURSOR','Invalid text offset.');let end=offset,bytes=0;while(end<chars.length&&bytes+Buffer.byteLength(chars[end])<=max)bytes+=Buffer.byteLength(chars[end++]);return{text:chars.slice(offset,end).join(''),next:end,complete:end===chars.length};}
export function metadata(t){return{id:t.id,name:t.name??null,cwd:t.cwd,status:t.status,parent_thread_id:t.parentThreadId??null,forked_from_id:t.forkedFromId??null,can_accept_direct_input:t.canAcceptDirectInput??null,updated_at:t.updatedAt??null};}
export async function readHistory(b,a,backend){
 const limit=a.limit??20;requireValue(Number.isInteger(limit)&&limit>=1&&limit<=100,'INVALID_ARGUMENT','limit must be 1..100.');
 let cursor=a.cursor?decode(a.cursor):null,turn=a.turn_id;
 if(cursor){requireValue(cursor.backend===backend&&cursor.thread===a.thread_id&&cursor.view===a.view,'INVALID_CURSOR','History cursor target mismatch.');if(turn)requireValue(turn===cursor.turn,'INVALID_CURSOR','History cursor turn mismatch.');turn=cursor.turn;}
 if(a.view==='turns'){
  requireValue(!a.turn_id&&!a.latest,'INVALID_ARGUMENT','Turn listing does not accept a selected turn.');const r=await b.request('thread/turns/list',{threadId:a.thread_id,limit,sortDirection:'desc',itemsView:'notLoaded',...(cursor?.server?{cursor:cursor.server}:{})});
  return{turns:r.data.map(t=>({id:t.id,status:t.status,error:t.error?{code:t.error.codexErrorInfo??null}:null})),next_cursor:r.nextCursor?encode({backend,thread:a.thread_id,view:a.view,server:r.nextCursor}):null,has_more:!!r.nextCursor,read_complete:!r.nextCursor};
 }
 requireValue(['items','messages'].includes(a.view),'INVALID_ARGUMENT','Invalid history view.');
 if(!cursor){requireValue((typeof turn==='string')!==(a.latest===true),'INVALID_ARGUMENT','Choose exactly one of turn_id or latest:true.');if(a.latest){const r=await b.request('thread/turns/list',{threadId:a.thread_id,limit:1,sortDirection:'desc',itemsView:'notLoaded'});turn=r.data[0]?.id;requireValue(turn,'TURN_NOT_FOUND','No turn is available.');}}
 const wrap=c=>encode({backend,thread:a.thread_id,view:a.view,turn,...c});
 const fragment=(item,offset)=>{const isMessage=['userMessage','agentMessage'].includes(item.type),text=isMessage?(item.text??item.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')??''):JSON.stringify(item),part=chunk(text,offset);return{entry:{id:item.id,type:item.type,phase:item.phase??null,text:part.text,representation:isMessage?'message_text':'item_json',text_offset:offset,text_truncated:!part.complete},part};};
 if(cursor?.item){const r=await b.request('thread/items/read',{threadId:a.thread_id,turnId:turn,itemIds:[cursor.item]});const entries=r.data??r.items;requireValue(Array.isArray(entries),'BACKEND_PROTOCOL','Invalid item read response.');const e=entries.find(x=>(x.item??x).id===cursor.item);requireValue(e&&(!e.turnId||e.turnId===turn),'TURN_NOT_FOUND','Continuation item is unavailable.');const {entry,part}=fragment(e.item??e,cursor.offset);return{turn_id:turn,items:[entry],next_cursor:part.complete?wrap({server:{type:'item',itemId:entry.id}}):wrap({item:entry.id,offset:part.next}),has_more:true,read_complete:false,continuation_unit:'unicode_code_points'};}
 const r=await b.request('thread/items/list',{threadId:a.thread_id,turnId:turn,limit,sortDirection:'desc',...(cursor?.server?{cursor:cursor.server}:{})});
 requireValue(Array.isArray(r.data)&&r.data.every(e=>e.turnId===turn&&e.item),'BACKEND_PROTOCOL','Source returned another turn identity.');
 const items=[];let next=r.nextCursor?wrap({server:r.nextCursor}):null,bytes=0,last;
 for(const e of r.data){const item=e.item;if(a.view==='messages'&&!['agentMessage','userMessage'].includes(item.type)){last=item.id;continue;}
  const {entry,part}=fragment(item,0),size=Buffer.byteLength(JSON.stringify(entry));if(bytes+size>60000&&items.length){next=last?wrap({server:{type:'item',itemId:last}}):null;break;}
  items.push(entry);bytes+=size;if(!part.complete){next=wrap({item:item.id,offset:part.next});break;}last=item.id;
 }
 return{turn_id:turn,items,next_cursor:next,has_more:!!next,read_complete:!next,target_found:r.data.length>0,target_missing:r.data.length===0&&!a.cursor,continuation_unit:'unicode_code_points'};
}
export async function listChats(b,a,backend,policy){
 const filters={archived:a.archived??false,cwd:a.cwd??null,updated_since:a.updated_since??null,threads:null};let cursor;
 if(a.cursor){const c=decode(a.cursor);requireValue(c.kind==='chat_list'&&c.backend===backend&&JSON.stringify(c.filters)===JSON.stringify(filters),'INVALID_CURSOR','Chat cursor profile/filter mismatch.');cursor=c.server;}
 const r=await b.request('thread/list',{archived:filters.archived,...(a.cwd?{cwd:a.cwd}:{}),...(cursor?{cursor}:{}),limit:a.limit??20,sortKey:'updated_at',sortDirection:'desc',useStateDbOnly:true});
 return{chats:r.data.filter(t=>(!a.updated_since||t.updatedAt>=a.updated_since)).map(metadata),next_cursor:r.nextCursor?encode({kind:'chat_list',backend,filters,server:r.nextCursor}):null,has_more:!!r.nextCursor};
}
