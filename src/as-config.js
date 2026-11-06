// R: Resolve the configured backend transport and identity without Plugin access-policy gates.
import {readFile} from 'node:fs/promises';
import {homedir,hostname} from 'node:os';
import {join,resolve} from 'node:path';
import {requireValue} from './errors.js';
import {requireProtocolBaseline} from './protocol-compatibility.js';
export async function loadConfig(file=process.env.AS_TOOLS_CONFIG){
 const raw=file?JSON.parse(await readFile(file,'utf8')):{};
 const c={backend_id:'local-wsl',host:hostname(),socket_path:join(process.env.CODEX_HOME??join(homedir(),'.codex'),'app-server-control/app-server-control.sock'),expected_codex_home:process.env.CODEX_HOME??join(homedir(),'.codex'),proxy_executable:process.env.THREAD_WATCH_CODEX_PATH??'codex',supported_protocol_version:'0.166.0',permissions:['read','send','manage','watch'],threads:null,cwd_roots:[homedir()],callers:{},mcp_calls:[],guard_contexts:[],...raw};
 requireValue(typeof c.backend_id==='string'&&c.backend_id.length>0&&c.host===hostname(),'BACKEND_IDENTITY','Profile must name this host and backend.');
 requireValue(typeof c.proxy_executable==='string'&&c.proxy_executable.length>0,'INVALID_CONFIG','Proxy executable must be configured.');
 requireProtocolBaseline(c.supported_protocol_version);
 for(const p of ['socket_path','expected_codex_home'])requireValue(typeof c[p]==='string'&&resolve(c[p])===c[p],'INVALID_CONFIG','Backend identity paths must be absolute.');
 requireValue(Array.isArray(c.guard_contexts),'INVALID_CONFIG','Invalid context restoration configuration.');
 return c;
}
