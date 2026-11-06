// R: Implement the stdio MCP lifecycle and the two thread-watch tool contracts.
import readline from 'node:readline';
import { callerContext } from './app-tools.js';
import { validateDefinition } from './registry.js';
import { ensureController,controllerRequest,queryWatchers } from './control.js';
import { errorResult,requireValue,WatchError } from './errors.js';
export const tools=[
  {name:'watch_thread',description:'Register/update/remove an App Server turn/completed watch. Timers are removed. source→destination must remain a DAG. Explicit caller_thread_id is required because host caller metadata is not assumed. Defaults destination to caller. Owner is retained on update; Both delivery labels send normal input (idle turn/start or active turn/steer). Hooks are deferred.',inputSchema:{type:'object',additionalProperties:false,required:['action','caller_thread_id'],properties:{action:{type:'string',enum:['upsert','remove']},caller_thread_id:{type:'string'},watch_id:{type:'string'},source_thread_id:{type:'string'},destination_thread_id:{type:'string'},message:{type:'string',minLength:1,maxLength:32768},delivery:{type:'string',enum:['wake','message'],default:'wake'},check_interval_seconds:{type:'null',description:'Timers removed; only null is accepted.',default:null}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
  {name:'list_thread_watchers',description:'List registrations observing thread_id (default explicit caller_thread_id), including registering/observer owner and notification destination separately. Read-only; use built-in thread messaging to contact a watcher.',inputSchema:{type:'object',additionalProperties:false,required:['caller_thread_id'],properties:{caller_thread_id:{type:'string'},thread_id:{type:'string'}}},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
];
const supported=['2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
export async function runMcp({stateDir,input=process.stdin,output=process.stdout}={}){
  const lines=readline.createInterface({input,crlfDelay:Infinity});let initialized=false,ready=false;
  const write=value=>output.write(JSON.stringify(value)+'\n');
  for await(const line of lines){if(!line.trim())continue;
    if(Buffer.byteLength(line)>131072){write({jsonrpc:'2.0',id:null,error:{code:-32700,message:'MCP message exceeds size limit.'}});continue;}
    let request;try{request=JSON.parse(line);}catch{write({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});continue;}
    const notification=request.id===undefined;
    try{
      requireValue(request.jsonrpc==='2.0'&&typeof request.method==='string','INVALID_REQUEST','Invalid JSON-RPC request.');
      if(request.method==='notifications/initialized'){requireValue(initialized,'INVALID_REQUEST','initialize must precede initialized.');ready=true;continue;}
      if(notification)continue;
      let result;
      if(request.method==='initialize'){
        requireValue(!initialized,'INVALID_REQUEST','Already initialized.');initialized=true;
        result={protocolVersion:supported.includes(request.params?.protocolVersion)?request.params.protocolVersion:supported[0],capabilities:{tools:{}},serverInfo:{name:'thread-watch',version:'0.4.0'},instructions:'Explicit caller_thread_id is required. A watch is persistent and can wake another thread; remove it when no longer needed.'};
      }else if(request.method==='ping')result={};
      else{
        requireValue(initialized&&ready,'INVALID_REQUEST','Complete MCP initialization first.');
        if(request.method==='tools/list')result={tools};
        else if(request.method==='tools/call'){
          try{const args=request.params?.arguments??{};const name=request.params?.name;
            requireValue(args&&typeof args==='object'&&!Array.isArray(args),'INVALID_ARGUMENT','Tool arguments must be an object.');
            requireValue(typeof args.caller_thread_id==='string'&&args.caller_thread_id.length>0,'CALLER_REQUIRED','Pass caller_thread_id explicitly; host metadata propagation is not assumed.');
            let value;
            if(name==='watch_thread'){
              if(args.action==='upsert'){
                // Validate scalar fields before any host access; full updates are validated by the controller.
                if(!args.watch_id)validateDefinition(args);
                callerContext(request.params._meta,args.caller_thread_id);
              }
              await ensureController(stateDir);value=await controllerRequest(stateDir,'watch',args);
            }
            else if(name==='list_thread_watchers'){
              for(const key of Object.keys(args))requireValue(['thread_id','caller_thread_id'].includes(key),'INVALID_ARGUMENT',`Unknown field: ${key}`);
              value=await queryWatchers(stateDir,args);
            }else throw new WatchError('UNKNOWN_TOOL','Unknown tool.');
            result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:false};
          }catch(e){const value={error:errorResult(e)};result={content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:true};}
        }else throw new WatchError('METHOD_NOT_FOUND','Method not found.');
      }
      write({jsonrpc:'2.0',id:request.id,result});
    }catch(e){if(!notification)write({jsonrpc:'2.0',id:request.id??null,error:{code:e.code==='METHOD_NOT_FOUND'?-32601:-32600,message:e.message}});}
  }
}
