#!/usr/bin/env node
// R: Run the plugin's inspection viewer without starting a monitoring controller.
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {startDashboard} from '../src/dashboard-server.js';
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('Usage: node bin/as-dashboard.js [--state DIR]\nOpen the printed local URL in the Codex browser panel. Reads existing watches and heartbeat files; changes no registrations.');}
else{
 if(args.length&&!(args.length===2&&args[0]==='--state'))throw Error('Usage: node bin/as-dashboard.js [--state DIR]');
 const stateDir=args.length?resolve(args[1]):join(homedir(),'.local/state/app-server-tools-candidate');
 const ui=await startDashboard(stateDir,{keepAlive:true});console.log(ui.url);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void ui.close().then(()=>process.exit(0));});
}
