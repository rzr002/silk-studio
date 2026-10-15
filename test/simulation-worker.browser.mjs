import {LAB_URL} from './lab-url.mjs';
import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright.mjs';
const playwright=loadPlaywright();
const browser=await playwright.chromium.launch({headless:true});
const page=await browser.newPage();
try{
  // Exercise the worker entrypoint without starting a second application loop.
  await page.route('**/app.mjs',route=>route.fulfill({status:200,contentType:'text/javascript',body:''}));
  await page.goto(LAB_URL);
  const report=await page.evaluate(async()=>{
    const {createPatch}=await import('./physics.mjs');
    const worker=new Worker('./simulation-worker.mjs',{type:'module'});
    let ticks=0;const ticker=setInterval(()=>ticks++,1);
    try{
      const result=await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('Worker did not return a fixed step')),10000);
        worker.onerror=e=>{clearTimeout(timeout);reject(new Error(e.message));};
        worker.onmessage=({data})=>{clearTimeout(timeout);data.type==='error'?reject(new Error(data.message)):resolve(data);};
        const model=createPatch({cols:6,rows:8});worker.postMessage({type:'sync',epoch:1,snapshot:model.snapshot()});
        worker.postMessage({type:'step',epoch:1,pose:0,gravity:true,collider:false,selfCollision:false,continuousCollision:false,quality:'standard',grabbed:null});
      });
      if(!(result.positions instanceof Float64Array)||!result.positions.every(Number.isFinite))throw new Error('Invalid transferred result');
      return {type:result.type,epoch:result.epoch,vertices:result.positions.length/3,lambdas:result.lambdas.length,mainThreadTicks:ticks};
    }finally{clearInterval(ticker);worker.terminate();}
  });
  assert.equal(report.type,'result');assert.equal(report.epoch,1);assert.equal(report.vertices,48);assert.ok(report.mainThreadTicks>0);
  console.log(JSON.stringify(report));
}finally{await browser.close();}
