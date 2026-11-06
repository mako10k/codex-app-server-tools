#!/usr/bin/env node
// R: Launch the isolated App Server Tools candidate MCP and kernel-owned controller lifecycle.
import {AS_VERSION} from '../src/as-version.js';
import {CompatibilityPolicy} from '../src/protocol-compatibility.js';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {runAsMcp,ensureAsController} from '../src/as-mcp.js';
import {serveController,controllerRequest} from '../src/control.js';
import {AsService} from '../src/as-service.js';
import {loadConfig} from '../src/as-config.js';
import {digest} from '../src/operation-journal.js';
import {errorResult,requireValue} from '../src/errors.js';
const help=`App Server Tools ${AS_VERSION}
Usage: node bin/as-tools.js mcp|serve-locked|status|compat-status|compat-reload|resume|stop [--state DIR]
Compatibility: settings under expected CODEX_HOME/app-server-tools/compatibility.json; compat-status/compat-reload never restart the shared daemon.
Configuration: AS_TOOLS_CONFIG is an optional JSON profile; fixed official Proxy executable/socket.
Default state: ~/.local/state/app-server-tools-candidate (never either live watch registry).
MCP exposes as_ Tools including bounded self-chat heartbeat set/list/remove and legacy watch aliases. Downstream mcp_call is exposed by default; Plugin permission/allowlist gates are removed.
Read tools do not resume chats; changes require actual caller metadata and operation_id.
This CLI does not install, migrate registrations, start/restart the shared daemon, or approve execution.
`;
try{const args=process.argv.slice(2),cmd=args.shift()??'help';if(['help','--help','-h'].includes(cmd)){console.log(help);}else{
 let state=join(homedir(),'.local/state/app-server-tools-candidate');if(args.length){requireValue(args.length===2&&args[0]==='--state','INVALID_ARGUMENT','Only --state DIR is accepted.');state=resolve(args[1]);}
 const config=await loadConfig();if(cmd==='mcp')await runAsMcp({stateDir:state,config});
 else if(cmd==='serve-locked'){let service,stopRequested=false;const stop=()=>{stopRequested=true;service?.stop().then(()=>process.exit(0));};for(const s of ['SIGINT','SIGTERM'])process.once(s,stop);service=await serveController(state,{version:AS_VERSION,createService:async registry=>{const s=await new AsService(registry,{config}).init();const status=s.status.bind(s);s.status=()=>({...status(),config_digest:digest(config)});return s;}});if(stopRequested)await service.stop();}
 else if(cmd==='compat-status'){try{console.log(JSON.stringify(await controllerRequest(state,'compatibility_status')));}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;const p=new CompatibilityPolicy(config);await p.refresh();console.log(JSON.stringify({controller_running:false,operating_state:'degraded',compatibility:p.report()}));}}
 else if(cmd==='compat-reload'){await ensureAsController(state,config);console.log(JSON.stringify(await controllerRequest(state,'compatibility_reload')));}
 else if(['status','resume','stop'].includes(cmd)){if(cmd==='resume')await ensureAsController(state,config);console.log(JSON.stringify(await controllerRequest(state,cmd)));}else requireValue(false,'INVALID_ARGUMENT','Unknown command.');
}}catch(e){console.error(JSON.stringify({error:errorResult(e)}));process.exitCode=1;}
