// R: Serve the bundled inspection UI and fresh read-only snapshots on a local ephemeral port.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {dashboardSnapshot} from './dashboard-state.js';
import {errorResult} from './errors.js';
const files=new Map([['/',[new URL('../ui/dashboard.html',import.meta.url),'text/html; charset=utf-8']],['/dashboard.js',[new URL('../ui/dashboard.js',import.meta.url),'text/javascript; charset=utf-8']],['/dashboard.css',[new URL('../ui/dashboard.css',import.meta.url),'text/css; charset=utf-8']],['/icon.svg',[new URL('../assets/icon.svg',import.meta.url),'image/svg+xml']]]);
export async function startDashboard(stateDir,{snapshot=()=>dashboardSnapshot(stateDir),port=0,keepAlive=false}={}){
 const server=http.createServer(async(req,res)=>{res.setHeader('Cache-Control','no-store');try{
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/api/snapshot'){res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(await snapshot()));return;}
  const asset=files.get(path);if(!asset){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',asset[1]);res.end(await readFile(asset[0]));
 }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:errorResult(e)}));}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});if(!keepAlive)server.unref();
 const url=`http://127.0.0.1:${server.address().port}/`;
 return {url,close:()=>new Promise((resolve,reject)=>{server.closeAllConnections();server.close(e=>e?reject(e):resolve());})};
}
export const dashboardTool={name:'as_dashboard',description:'Open the bundled GUI for watch relationships, watched chats and all local heartbeat schedules. Returns dashboard_url for a browser panel. Reads local state only; never starts monitoring or changes registrations.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}};
