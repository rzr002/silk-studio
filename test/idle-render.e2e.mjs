import {LAB_URL} from './lab-url.mjs';
import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';

const playwright=loadPlaywright();
const browser=await playwright.chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
const report={date:new Date().toISOString(),checks:[],errors:[]};
page.on('pageerror',error=>report.errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());});

// Count calls to the actual WebGL drawing APIs, independently of scene diagnostics.
await page.addInitScript(()=>{
  window.__webglDraws=0;
  for(const api of [window.WebGLRenderingContext,window.WebGL2RenderingContext]){
    if(!api)continue;
    for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']){
      if(!Object.hasOwn(api.prototype,name))continue;
      const original=api.prototype[name];
      api.prototype[name]=function(...args){window.__webglDraws++;return original.apply(this,args);};
    }
  }
});
const counters=()=>page.evaluate(()=>({rendering:workbench.inspect().rendering,webglDraws:window.__webglDraws}));
const canvasImage=()=>page.locator('#viewport canvas').evaluate(canvas=>canvas.toDataURL('image/png'));
async function settled(){await page.waitForFunction(()=>workbench.inspect().rendering?.dirty===false);await page.waitForTimeout(100);}
async function idle(label,duration=800){
  await settled();const before=await counters();await page.waitForTimeout(duration);const after=await counters();
  assert.ok(after.rendering.requests>before.rendering.requests,'animation loop remains responsive');
  assert.equal(after.rendering.draws,before.rendering.draws,`${label}: no scene redraw while stationary`);
  assert.equal(after.webglDraws,before.webglDraws,`${label}: no actual WebGL draw calls while stationary`);
  report.checks.push({label,before,after});return after;
}
async function visibleChange(label,action){
  await settled();const before=await counters(),beforeImage=await canvasImage();await action();
  await page.waitForFunction(n=>workbench.inspect().rendering.draws>n,before.rendering.draws);
  await settled();const after=await counters();
  assert.ok(after.webglDraws>before.webglDraws,`${label}: actual drawing must resume`);
  assert.notEqual(await canvasImage(),beforeImage,`${label}: rendered pixels must change`);
  report.checks.push({label,before,after});return after;
}

try{
  await mkdir('evidence',{recursive:true});
  await page.goto(LAB_URL);
  await page.waitForFunction(()=>window.workbench?.inspect);
  if(await page.evaluate(()=>workbench.inspect().playing))await page.locator('#play-button').click();
  await page.waitForFunction(()=>!workbench.inspect().computing);
  assert.ok((await counters()).rendering,'workbench exposes readonly scene rendering diagnostics');
  await idle('initial stationary stocking',2000);

  await page.locator('[data-tool=orbit]').click();
  const projectionBefore=await page.evaluate(()=>workbench.projectUV(.25,.4));
  await visibleChange('orbit',async()=>{
    const box=await page.locator('#viewport').boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+90,y+35,{steps:5});await page.mouse.up();
  });
  const projectionAfter=await page.evaluate(()=>workbench.projectUV(.25,.4));
  assert.ok(Math.hypot(projectionBefore.x-projectionAfter.x,projectionBefore.y-projectionAfter.y)>5);
  await idle('after orbit');
  await visibleChange('wheel zoom',()=>page.mouse.wheel(0,-160));
  await idle('after zoom');

  await visibleChange('wire display',()=>page.locator('#wireframe').check());
  await visibleChange('strain display',()=>page.locator('#strain-view').check());
  await page.locator('#wireframe').uncheck();await page.locator('#strain-view').uncheck();
  await visibleChange('knit region view',()=>page.locator('[data-scene=knit]').click());
  await visibleChange('paused yarn strain on',()=>page.locator('#strain-view').check());
  await visibleChange('paused yarn strain off',()=>page.locator('#strain-view').uncheck());
  await idle('paused knit region');
  await visibleChange('UV chart view',()=>page.locator('[data-scene=patch]').click());
  await page.locator('[data-tool=pin]').click();
  const oldPins=await page.evaluate(()=>workbench.inspect().snapshot.design.model.pins);
  await visibleChange('persistent pin edit',async()=>{const p=await page.evaluate(()=>workbench.projectUV(.65,.6));await page.mouse.click(p.x,p.y);});
  const edited=await page.evaluate(()=>workbench.inspect());
  assert.notDeepEqual(edited.snapshot.design.model.pins,oldPins);
  assert.ok(edited.operations.some(op=>op.type==='pin'));
  await idle('after visible edit');
  await visibleChange('viewport resize',()=>page.setViewportSize({width:1320,height:920}));
  await idle('after resize');

  // Hold only the transport, so this checks the actual UI waiting state without
  // launching a long solver run or treating a synthetic response as physics.
  const solverPanel=page.locator('#solver-controls');
  if(!await solverPanel.evaluate(element=>element.open))await solverPanel.locator('summary').click();
  await page.locator('#solver-backend').selectOption('native');
  let pendingRoute;
  await page.route('**/api/reference-step',route=>{pendingRoute=route;});
  const beforeWaiting=await page.evaluate(()=>{const s=workbench.inspect();return {steps:s.steps,positions:s.positions};});
  await page.locator('#step-button').click();await page.waitForFunction(()=>workbench.inspect().computing);
  assert.ok(pendingRoute,'the actual UI submitted a native request');
  await idle('UI waiting for native transport (intercepted; no solver result)',1000);
  const payload=pendingRoute.request().postDataJSON();
  await pendingRoute.fulfill({status:200,contentType:'application/json',body:JSON.stringify({version:1,epoch:payload.epoch,requestId:payload.requestId,designRevision:payload.designRevision,baseStateId:payload.baseStateId,committed:false,status:'nonconverged',message:'Renderer-only delayed transport test; no physical solve.'})});
  await page.waitForFunction(()=>!workbench.inspect().computing);
  const afterWaiting=await page.evaluate(()=>{const s=workbench.inspect();return {steps:s.steps,positions:s.positions};});
  assert.deepEqual(afterWaiting,beforeWaiting,'renderer waiting test must not commit fabricated physical state');
  await page.unroute('**/api/reference-step');await settled();

  const beforeCapture=await counters(),downloadPromise=page.waitForEvent('download');
  await page.locator('#snapshot-button').click();const download=await downloadPromise;
  const path='evidence/idle-render-export.png';await download.saveAs(path);const png=await readFile(path);
  assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  const pixels=await page.evaluate(async url=>{
    const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,64,64);const rgba=ctx.getImageData(0,0,64,64).data;let opaque=0;const colors=new Set();
    for(let i=0;i<rgba.length;i+=4){if(rgba[i+3]===255)opaque++;colors.add(`${rgba[i]},${rgba[i+1]},${rgba[i+2]},${rgba[i+3]}`);}
    return {width:image.width,height:image.height,opaquePixels:opaque,distinctColors:colors.size};
  },`data:image/png;base64,${png.toString('base64')}`);
  assert.ok(pixels.width>500&&pixels.height>500&&pixels.opaquePixels===4096&&pixels.distinctColors>30,'PNG contains the preserved rendered scene, not an empty canvas');
  const afterCapture=await counters();assert.equal(afterCapture.rendering.draws,beforeCapture.rendering.draws);assert.equal(afterCapture.webglDraws,beforeCapture.webglDraws);
  report.checks.push({label:'idle PNG capture preserves rendered pixels without another draw',pixels,bytes:png.length});
  await page.screenshot({path:'evidence/idle-render-final.png',fullPage:true});
  assert.deepEqual(report.errors,[],'no page or WebGL errors');report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;throw error;}
finally{await writeFile('evidence/idle-render-report.json',JSON.stringify(report,null,2));await browser.close();}
report.checks.forEach(check=>console.log('PASS',check.label));
