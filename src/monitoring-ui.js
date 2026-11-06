// R: Publish a self-contained native MCP UI resource and its read-only list tool.
import {readFile} from 'node:fs/promises';
import {dashboardSnapshot} from './dashboard-state.js';
import {requireValue} from './errors.js';
export const MONITORING_UI_URI='ui://thread-watch/monitoring.html';
export const monitoringViewTool={name:'as_monitoring_view',title:'監視・被監視・ハートビート',description:'Show existing monitoring relationships and heartbeat schedules in the Codex right pane. Reads saved state only; does not start monitoring or change registrations. Optional Web dashboard is separate.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},_meta:{ui:{resourceUri:MONITORING_UI_URI},'openai/ui':{entrypoints:[{type:'thread'}],preferredModelDisplayMode:'fullscreen'}}};
export const monitoringUiResources=[{uri:MONITORING_UI_URI,name:'監視・被監視・ハートビート',mimeType:'text/html;profile=mcp-app',description:'Existing registrations and schedule snapshots, rendered through the MCP Apps bridge.'}];
const asset=name=>readFile(new URL('../'+name,import.meta.url),'utf8');
const script=text=>text.replace(/<\/script/gi,'<\\/script');
export async function readMonitoringUiResource(uri){
 requireValue(uri===MONITORING_UI_URI,'RESOURCE_NOT_FOUND','Unknown MCP UI resource.');
 const [template,css,view,bridge,icon]=await Promise.all(['ui/dashboard.html','ui/dashboard.css','ui/dashboard.js','ui/mcp-bridge.js','assets/icon.svg'].map(asset));
 const html=template.replace('<link rel="icon" href="/icon.svg">','').replace('<link rel="stylesheet" href="/dashboard.css">',()=>'<style>'+css+'</style>').replace('<script type="module" src="/dashboard.js"></script>',()=>'<script type="module">'+script(bridge+'\n'+view)+'</script>').replace('src="/icon.svg"','src="data:image/svg+xml;base64,'+Buffer.from(icon).toString('base64')+'"').replaceAll('監視ダッシュボード','監視一覧');
 return {contents:[{uri:MONITORING_UI_URI,mimeType:'text/html;profile=mcp-app',text:html,_meta:{'openai/ui':{availableDisplayModes:['inline','fullscreen'],preferredDisplayMode:'fullscreen'},ui:{prefersBorder:false}}}]};
}
export async function monitoringViewResult(stateDir,{snapshot=()=>dashboardSnapshot(stateDir),metadata={}}={}){
 let turn=metadata['x-codex-turn-metadata'];if(typeof turn==='string'){try{turn=JSON.parse(turn);}catch{turn=undefined;}}
 const current=metadata.threadId??metadata['openai/threadId']??turn?.thread_id;
 const data=await snapshot();return {content:[{type:'text',text:`監視 ${data.watches.length}件・被監視 ${new Set(data.watches.map(w=>w.source_thread_id)).size}チャット・ハートビート ${data.heartbeats.length}件。右ペインに一覧を表示します。`}],structuredContent:typeof current==='string'?{...data,current_thread_id:current}:data,isError:false};
}
