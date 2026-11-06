// R: Persist operation identity and ambiguous outcomes without resubmitting a recorded operation.
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {requireValue,errorResult} from './errors.js';
export function canonical(v){return JSON.stringify(v,(k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);}
export const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
export async function atomicJson(file,value){await mkdir(dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(value)+'\n',{mode:0o600});await rename(tmp,file);}
const transient=Symbol('transient-output');
export const withTransientOutput=(receipt,output)=>({[transient]:true,receipt,output});
export class OperationJournal{
 constructor(file){this.file=file;this.records=[];this.tail=Promise.resolve();}
 async load(){try{this.records=JSON.parse(await readFile(this.file,'utf8'));requireValue(Array.isArray(this.records),'JOURNAL_INVALID','Invalid operation journal.');}catch(e){if(e.code!=='ENOENT')throw e;}let changed=false;for(const r of this.records)if(['pending','submitted'].includes(r.status)){r.status='ambiguous';changed=true;}if(changed)await this.save();}
 save(){return atomicJson(this.file,this.records);}
 get(caller,operation){return structuredClone(this.records.find(r=>r.caller===caller&&r.operation_id===operation)??null);}
 run(caller,args,fn){const work=this.tail.then(async()=>{
  requireValue(typeof args.operation_id==='string'&&/^[A-Za-z0-9._:-]{1,160}$/.test(args.operation_id),'OPERATION_REQUIRED','A bounded operation_id is required.');const hash=digest(args),existing=this.get(caller,args.operation_id);
  if(existing){requireValue(existing.request_digest===hash,'OPERATION_CONFLICT','Operation ID already belongs to a different request.');return existing;}
  const r={caller,operation_id:args.operation_id,request_digest:hash,status:'pending',created_at:new Date().toISOString()};this.records.push(r);await this.save();
  const submit=async()=>{r.status='submitted';await this.save();};
  let output;try{const value=await fn(submit);if(value?.[transient]){r.result=value.receipt;output=value.output;}else r.result=value;r.status='accepted';}catch(e){r.status=r.status==='submitted'&&!['BACKEND_REJECTED','UNSUPPORTED_CAPABILITY'].includes(e.code)?'ambiguous':'failed';r.error=errorResult(e);}
  r.finished_at=new Date().toISOString();await this.save();return{...structuredClone(r),...(output!==undefined?{output}:{} )};
 });this.tail=work.catch(()=>{});return work;}
}
