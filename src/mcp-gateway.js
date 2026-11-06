// R: Forward downstream MCP calls through the configured backend and retain only durable receipts.
import {digest,withTransientOutput} from './operation-journal.js';
import {WatchError} from './errors.js';
export async function callMcp(b,a,{submit}){await submit();try{const output=await b.request('mcpServer/tool/call',{threadId:a.thread_id,server:a.server,tool:a.tool,arguments:a.arguments});const receipt={rpc_accepted:true,response_digest:digest(output),output_retained:false,is_tool_error:output.isError===true};return withTransientOutput(receipt,Buffer.byteLength(JSON.stringify(output))<=48000?output:{output_omitted:'result_limit',response_digest:receipt.response_digest});}catch(e){if(e.code==='UNSUPPORTED_CAPABILITY')throw e;throw new WatchError('MCP_OUTCOME_UNKNOWN','Downstream outcome may be unknown; no retry. Approval/elicitation is not auto-approved.');}
}
