import test from 'node:test';
import assert from 'node:assert/strict';
import {serverVersion} from '../src/protocol-compatibility.js';
test('extract runtime versions from desktop and CLI user agents',()=>{
 for(const [agent,version] of [
  ['Codex Desktop/0.167.0 (Ubuntu 24.4.0; x86_64) WindowsTerminal (app-server-tools; 0.6.12-candidate)','0.167.0'],
  ['codex_cli_rs/0.166.0 (Linux)','0.166.0'],
  ['Codex Desktop/0.168.0-candidate.1','0.168.0-candidate.1'],
  ['Codex Desktop/0.167','invalid'],
  ['Codex Desktop/0.167.0garbage','invalid'],
  ['unrecognized prefix Codex Desktop/0.167.0','invalid'],
  [undefined,'invalid']
 ]) assert.equal(serverVersion(agent),version==='invalid'?null:version);
});
