// R: Exchange monitoring snapshots through the MCP Apps host bridge, without HTTP.
let nextId=0;
const pending=new Map();
function send(message){window.parent.postMessage({jsonrpc:'2.0',...message},'*');}
function request(method,params){return new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(Error('Appとの通信が時間内に完了しませんでした。更新で再取得できます。'));},15000);pending.set(id,{resolve,reject,timer});send({id,method,params});});}
window.addEventListener('message',event=>{
 if(event.source!==window.parent||!event.data||event.data.jsonrpc!=='2.0')return;
 const message=event.data;
 if(message.id!==undefined&&pending.has(message.id)&&!message.method){const task=pending.get(message.id);pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(Error(message.error.message??'Appの取得処理が失敗しました。')):task.resolve(message.result);return;}
 if(message.method==='ui/notifications/host-context-changed'&&message.params?.theme)document.documentElement.style.colorScheme=message.params.theme;
 if(message.id!==undefined&&message.method){if(['ui/resource-teardown','ping'].includes(message.method))send({id:message.id,result:{}});else send({id:message.id,error:{code:-32601,message:'Unsupported UI request'}});}
});
const ready=request('ui/initialize',{appInfo:{name:'App Server Tools monitoring',version:'1'},appCapabilities:{},protocolVersion:'2025-11-21'}).then(result=>{if(result.hostContext?.theme)document.documentElement.style.colorScheme=result.hostContext.theme;send({method:'ui/notifications/initialized'});return result;});
// The view tool is read-only; refreshing never starts a monitor or changes a registration.
window.monitoringTransport={async snapshot(){await ready;const result=await request('tools/call',{name:'as_monitoring_view',arguments:{}});if(result.isError)throw Error(result.content?.find(c=>c.type==='text')?.text??'一覧を取得できませんでした。');const snapshot=result.structuredContent;if(!Array.isArray(snapshot?.watches)||!Array.isArray(snapshot?.heartbeats))throw Error('一覧データの形式が不明です。');return snapshot;}};
