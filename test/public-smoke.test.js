// R: Verify the extracted plugin discovers its tools and local diagnostics without a backend or private user configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('clean MCP discovery/status requires no running App Server',async t=>{
 const home=await mkdtemp(join(tmpdir(),'as-public-smoke-'));t.after(()=>rm(home,{recursive:true,force:true}));const state=join(home,'state');
 const messages=[{jsonrpc:'2.0',id:1,method:'initialize'},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'as_status',arguments:{}}},{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'as_chat_send',arguments:{thread_id:'example-thread',caller_thread_id:'example-caller',operation_id:'unsubmitted-smoke',text:'not sent'}}}];
 const launch=fileURLToPath(new URL('../scripts/launch-as-mcp.sh',import.meta.url));const r=spawnSync('/bin/sh',[launch,'--state',state],{input:messages.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',timeout:15000,env:{...process.env,CODEX_HOME:home,AS_TOOLS_CONFIG:''}});assert.equal(r.status,0,r.stderr);
 const rows=r.stdout.trim().split('\n').map(JSON.parse);assert.equal(rows[0].result.serverInfo.name,'app-server-tools');assert.ok(rows[1].result.tools.some(t=>t.name==='as_mcp_call'));assert.equal(rows[2].result.isError,false);assert.equal(rows[2].result.structuredContent.controller_running,false);assert.equal(rows[3].result.isError,true);assert.equal(rows[3].result.structuredContent.error.code,'RUNTIME_CONTEXT_REQUIRED');await assert.rejects(access(state),{code:'ENOENT'});
});
