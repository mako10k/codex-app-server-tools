// R: Persist operator-desired candidate service states independently of backend compatibility.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {requireValue} from './errors.js';
export async function serviceSettings(dir){
 try{const v=JSON.parse(await readFile(join(dir,'services.json'),'utf8'));requireValue(v.schema_version===1&&['controller','proxy','watch','heartbeat'].every(k=>typeof v[k]==='boolean'),'SERVICE_SETTINGS','Invalid desired service state.');return v;}
 catch(e){if(e.code!=='ENOENT')throw e;return{schema_version:1,controller:true,proxy:true,watch:true,heartbeat:true};}
}
