import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('./lab-url.mjs').catch(()=>({}));
const resolve=env=>{assert.equal(typeof api.resolveLabURL,'function');return api.resolveLabURL(env);};
test('legacy browser suites default explicitly to the lab page',()=>assert.equal(resolve({}),'http://127.0.0.1:4197/lab.html'));
test('DEMO_URL changes the origin without redirecting legacy tests into the workshop',()=>{assert.equal(resolve({DEMO_URL:'http://127.0.0.1:4198'}),'http://127.0.0.1:4198/lab.html');assert.equal(resolve({DEMO_URL:'http://localhost:4197/index.html?theme=workshop'}),'http://localhost:4197/lab.html');});
test('explicit LAB_URL takes priority and preserves its requested query',()=>assert.equal(resolve({LAB_URL:'http://localhost:4200/lab.html?fixture=1',DEMO_URL:'http://127.0.0.1:4198'}),'http://localhost:4200/lab.html?fixture=1'));
