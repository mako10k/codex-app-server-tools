// R: Preserve upstream JSON-RPC refusal diagnostics without changing error classification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {AppServerBackend} from '../src/app-server.js';
import {errorResult} from '../src/errors.js';

test('backend rejection preserves message and structured data through serialization',async()=>{
 for(const data of [{type:'modelProviderMismatch',savedProvider:'saved',currentProvider:'current'},null,false,0,'']){
  const transport=new EventEmitter();transport.send=()=>{};
  const b=new AppServerBackend({transport,capabilityErrors:true});
  const pending=b.request('thread/resume',{threadId:'fixture-thread'});
  b.received(JSON.stringify({id:1,error:{code:-32600,message:'original refusal',data}}));
  await assert.rejects(pending,error=>{
   assert.deepEqual(JSON.parse(JSON.stringify(errorResult(error))),{code:'BACKEND_REJECTED',message:'original refusal',details:{method:'thread/resume',rpc_code:-32600,rpc_message:'original refusal',rpc_data:data}});return true;
  });
 }
});
test('missing diagnostic fields remain absent and unsupported classification remains stable',async()=>{
 for(const error of [{code:-32601,message:'not supported'},{code:-32600}]){
  const transport=new EventEmitter();transport.send=()=>{};
  const b=new AppServerBackend({transport,capabilityErrors:true});const pending=b.request('fixture/method',{});
  b.received(JSON.stringify({id:1,error}));
  await assert.rejects(pending,e=>{assert.equal(e.code,error.code===-32601?'UNSUPPORTED_CAPABILITY':'BACKEND_REJECTED');assert.equal(Object.hasOwn(e.details,'rpc_data'),false);assert.equal(Object.hasOwn(e.details,'rpc_message'),Object.hasOwn(error,'message'));assert.equal(e.message,error.message??'App Server rejected the request.');return true;});
 }
});
