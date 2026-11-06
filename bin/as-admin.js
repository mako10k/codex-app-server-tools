#!/usr/bin/env node
// R: Execute one bounded management request under the caller-acquired kernel writer lease.
import {managementControlLocked} from '../src/local-management.js';
import {errorResult,requireValue} from '../src/errors.js';
try{let input='';for await(const chunk of process.stdin){input+=chunk;requireValue(Buffer.byteLength(input)<=131072,'INVALID_REQUEST','Management request too large.');}const {dir,config,request}=JSON.parse(input);console.log(JSON.stringify(await managementControlLocked(dir,config,request)));}catch(e){console.log(JSON.stringify({error:errorResult(e)}));}
