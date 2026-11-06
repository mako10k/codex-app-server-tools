// R: Verify the viewer reads actual saved state without starting or changing monitoring.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Readable,Writable} from 'node:stream';
import {dashboardSnapshot} from '../src/dashboard-state.js';import {startDashboard} from '../src/dashboard-server.js';import {runAsMcp} from '../src/as-mcp.js';
test('cold inspector preserves every definition and reports unavailable controllers and expired heartbeats',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'as-dashboard-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const definitions={watches:[{watch_id:'w',source_thread_id:'watched',destination_thread_id:'receiver',owner_thread_id:'owner',message:'<script>untrusted</script>'}],attempts:[{watch_id:'w',status:'failed'}]};
 const heartbeat={registrations:[{heartbeat_id:'h',owner_thread_id:'another-owner',starts_at:'2026-11-01T00:00:00Z',expires_at:'2026-11-02T00:00:00Z',state:'scheduled',checks:[]}],deliveries:[]};
 await writeFile(join(dir,'registry.json'),JSON.stringify(definitions));await writeFile(join(dir,'heartbeats.json'),JSON.stringify(heartbeat));
 const before=await readFile(join(dir,'heartbeats.json'),'utf8'),sources=[{id:'fixture',label:'fixture',dir}];
 const s=await dashboardSnapshot(dir,{sources,home:dir,now:()=>new Date('2026-11-06T00:00:00Z')});
 assert.equal(s.watches[0].last_attempt.status,'failed');assert.equal(s.watches[0].source_thread_id,'watched');assert.equal(s.heartbeats[0].owner_thread_id,'another-owner');assert.equal(s.heartbeats[0].state,'expired');assert.equal(s.profiles[0].controller_running,false);
 assert.equal(await readFile(join(dir,'heartbeats.json'),'utf8'),before);assert.deepEqual(JSON.parse(await readFile(join(dir,'registry.json'))),definitions);
 await assert.rejects(readFile(join(dir,'controller.lock')),{code:'ENOENT'});
});
test('HTTP viewer serves real read snapshots, assets and no mutation endpoint',async t=>{
 let count=0;const ui=await startDashboard('/unused',{snapshot:async()=>({observed_at:'now',watches:[],heartbeats:[],profiles:[],generation:++count})});t.after(()=>ui.close());
 const page=await fetch(ui.url);assert.match(await page.text(),/被監視/);assert.equal((await fetch(ui.url+'api/snapshot').then(r=>r.json())).generation,1);assert.equal((await fetch(ui.url+'api/snapshot').then(r=>r.json())).generation,2);
 assert.equal((await fetch(ui.url+'unknown')).status,404);assert.equal((await fetch(ui.url+'api/snapshot',{method:'POST'})).status,405);assert.match((await fetch(ui.url+'icon.svg')).headers.get('content-type'),/svg/);
});
test('MCP advertises and returns dashboard URL without ensuring a controller',async()=>{
 let output='';const requests=[{jsonrpc:'2.0',id:1,method:'initialize'},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'as_dashboard',arguments:{}}}];
 await runAsMcp({stateDir:'/unused',config:{},ensure:()=>assert.fail('must not start a controller'),input:Readable.from(requests.map(r=>JSON.stringify(r)+'\n')),output:new Writable({write(c,e,cb){output+=c;cb();}})});
 const lines=output.trim().split('\n').map(JSON.parse);assert.ok(lines[1].result.tools.some(t=>t.name==='as_dashboard'));assert.match(lines[2].result.structuredContent.dashboard_url,/^http:\/\/127\.0\.0\.1:\d+\/$/);assert.equal(lines[2].result.isError,false);
});
