import {LAB_URL} from './lab-url.mjs';
import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright.mjs';
import {mkdir,writeFile} from 'node:fs/promises';

const playwright=loadPlaywright();
const url=LAB_URL;
const timeout=Number(process.env.NATIVE_TIMEOUT_MS||180000);
const report={date:new Date().toISOString(),url,checks:[],pageErrors:[],consoleErrors:[],requests:[],health:null,static:null,unsupportedMaterial:null,failure:null,
  limits:'One static full-stocking step with a declared 6 mm numerical fitting margin; no material calibration, manufacturing verification, sustained-motion or general collision-free guarantee.'};
await mkdir('evidence',{recursive:true});
const browser=await playwright.chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),responses=[];
page.on('pageerror',error=>report.pageErrors.push(error.message));
page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
page.on('response',response=>{
  if(new URL(response.url()).pathname!=='/api/reference-step'||response.request().method()!=='POST')return;
  responses.push((async()=>{
    const request=response.request().postDataJSON(),result=await response.json();
    report.requests.push({httpStatus:response.status(),version:request.version,epoch:request.epoch,requestId:request.requestId,designId:request.designId,designRevision:request.designRevision,baseStateId:request.baseStateId,acceptedPoseBefore:request.context.pose,targetPose:request.step.pose,dt:request.step.dt,
      result:{committed:result.committed,converged:result.converged,status:result.status,pose:result.pose,advancedTime:result.advancedTime,ms:result.ms,message:result.message,runtime:result.runtime,diagnostics:result.diagnostics,collisionStats:result.collisionStats}});
  })());
});
const inspect=()=>page.evaluate(()=>workbench.inspect());
const pass=name=>{report.checks.push(name);console.log('PASS',name);};
let staticFailure=null;
async function openDetails(id){if(await page.locator(id).evaluate(el=>el.tagName==='DETAILS'&&!el.open))await page.locator(`${id}>summary`).click();}
async function audit(){
  return page.evaluate(async()=>{
    const s=workbench.inspect(),saved=s.snapshot.design.model;
    const [{bodyProjection,auditBodyIntersections},{stockingToeCoverage},{restoreModel}]=await Promise.all([import('/contact.mjs'),import('/garment-geometry.mjs'),import('/physics.mjs')]);
    const model=restoreModel(saved),options={pose:s.pose,dimensions:s.snapshot.design.bodyDimensions,margin:0};
    let vertexPenetrations=0,surfacePenetrations=0,maxDepth=0,pinMaxError=0;
    const inside=p=>{const projected=bodyProjection(...p,options);if(!projected)return 0;return Math.hypot(...p.map((x,k)=>x-projected[k]));};
    for(let i=0;i<saved.positions.length;i+=3){const depth=inside(saved.positions.slice(i,i+3));if(depth>1e-7)vertexPenetrations++;maxDepth=Math.max(maxDepth,depth);}
    const weights=[[1/3,1/3,1/3],[.5,.5,0],[0,.5,.5],[.5,0,.5],[.6,.2,.2],[.2,.6,.2],[.2,.2,.6]];
    for(let j=0;j<saved.triangles.length;j+=3){
      const ids=saved.triangles.slice(j,j+3);
      for(const w of weights){const p=[0,1,2].map(k=>ids.reduce((sum,id,a)=>sum+saved.positions[id*3+k]*w[a],0)),depth=inside(p);if(depth>1e-7)surfacePenetrations++;maxDepth=Math.max(maxDepth,depth);}
    }
    for(const [index,target] of saved.pinTargets)pinMaxError=Math.max(pinMaxError,Math.hypot(...target.map((x,k)=>x-saved.positions[index*3+k])));
    return {vertices:saved.positions.length/3,faces:saved.triangles.length/3,finite:saved.positions.every(Number.isFinite)&&saved.velocities.every(Number.isFinite),pins:saved.pins.length,pinMaxError,vertexPenetrations,surfacePenetrations,samplesPerFace:weights.length,maxDepth,
      toe:stockingToeCoverage(model,options),actualToe:stockingToeCoverage(model,{...options,probeOffsetM:0}),intersections:auditBodyIntersections(model,options)};
  });
}
function assertGeometry(contact){
  assert.equal(contact.finite,true,'all actual positions and velocities must be finite');
  assert.ok(contact.pins>0,'the actual default stocking must retain its fixed cuff');
  assert.ok(contact.pinMaxError<1e-12,`fixed vertices moved ${contact.pinMaxError} m`);
  assert.equal(contact.toe.probes,17,'toe coverage must test all 17 volume probes');
  assert.equal(contact.actualToe.probes,17,'actual body tip coverage must test all 17 probes');
  assert.equal(contact.actualToe.probeOffsetM,0);
  assert.equal(contact.actualToe.covered,true,`actual body toe is uncovered at ${contact.actualToe.uncoveredProbes}/17 probes`);
  assert.equal(contact.toe.probeOffsetM,.0005,'the separate clearance gate must retain its declared half-millimetre offset');
  assert.equal(contact.toe.covered,true,`numerical toe clearance is insufficient at ${contact.toe.uncoveredProbes}/17 probes`);
  assert.equal(contact.toe.uncoveredProbes,0);
  assert.equal(contact.intersections.pairCount,0,'actual cloth and body triangles must have zero intersections');
  assert.equal(contact.vertexPenetrations,0,'all vertices must clear the analytic body');
  assert.equal(contact.samplesPerFace,7);
  assert.equal(contact.surfacePenetrations,0,'all seven interior/edge samples of every face must clear the analytic body');
}

try{
  await page.goto(url);await page.waitForFunction(()=>window.workbench?.inspect);
  report.health=await page.evaluate(async()=>{const response=await fetch('/api/health');return {httpStatus:response.status,...await response.json()};});
  assert.equal(report.health.httpStatus,200);assert.equal(report.health.version,1);assert.equal(report.health.referenceAvailable,true,report.health.message||'the real native backend must be installed');
  assert.equal(report.health.manufacturing,'unverified');pass('same-origin health confirms the real native backend is available');
  if((await inspect()).playing)await page.locator('#play-button').click();
  await page.waitForFunction(()=>!workbench.inspect().computing);
  await openDetails('#solver-controls');
  await page.waitForFunction(()=>!document.querySelector('#solver-backend option[value=native]').disabled);
  await page.locator('#solver-backend').selectOption('native');
  assert.equal((await inspect()).settings.backend,'native');
  const prepare=page.locator('#prepare-reference');assert.match(await prepare.textContent(),/6\s*mm/);await prepare.click();
  let prepared=await inspect();assert.equal(prepared.kind,'stocking');assert.equal(prepared.pose,0);assert.equal(prepared.targetPose,0);assert.ok(prepared.history.some(x=>/6mm/.test(x)));assert.equal(prepared.playing,false);
  const preparedAudit=await audit();await writeFile('evidence/native-prepared-state.json',JSON.stringify(prepared.snapshot));await writeFile('evidence/native-prepared-audit.json',JSON.stringify(preparedAudit,null,2));assertGeometry(preparedAudit);
  pass('the visible 6 mm fitting action creates an explicitly prepared, geometrically clear full stocking');
  const start=Date.now(),beforeSteps=prepared.steps;console.log('RUN actual native static full-stocking step');
  await page.locator('#step-button').click();
  await page.waitForFunction(previous=>{const s=workbench.inspect();return !s.computing&&(s.steps>previous||!!s.solverError);},beforeSteps,{timeout});
  const after=await inspect();
  report.static={wallMs:Date.now()-start,stepsBefore:beforeSteps,stepsAfter:after.steps,acceptedPose:after.pose,solverError:after.solverError,frameMs:after.frameMs,settings:after.settings,collisionStats:after.snapshot.design.model.collisionStats,contact:await audit()};
  await writeFile('evidence/native-static-state.json',JSON.stringify(after.snapshot));await writeFile('evidence/native-static-audit.json',JSON.stringify(report.static,null,2));
  try{
    assert.equal(after.solverError,'',`the actual native static step failed: ${after.solverError}`);assert.equal(after.steps,beforeSteps+1);assert.equal(after.pose,prepared.pose);assert.equal(after.playing,false);assert.equal(after.snapshot.design.model.collisionStats.engine,'ipctk-native-reference');
    for(const [index,target] of prepared.snapshot.design.model.pinTargets)assert.ok(Math.hypot(...target.map((x,k)=>x-after.positions[index*3+k]))<1e-12);
    assertGeometry(report.static.contact);report.static.passed=true;pass('one actual native static step retains finite state, fixed vertices, 17/17 toe coverage and zero full-surface penetration');
  }catch(error){
    staticFailure=error;report.static.passed=false;report.static.validationFailure=error.message;console.log('FAIL native static gate:',error.message);
    if(after.solverError){assert.deepEqual(after.positions,prepared.positions,'a rejected static step must not change positions');assert.deepEqual(after.snapshot.design.model.velocities,prepared.snapshot.design.model.velocities);assert.equal(after.steps,prepared.steps);assert.equal(after.pose,prepared.pose);pass('a failed static native solve preserves the accepted state');}
  }
  await page.screenshot({path:'evidence/native-static.png',fullPage:true});

  // Preserve the static result before changing source data. If static failed,
  // its gate stays fatal while the independent refusal path is still checked.
  if(staticFailure)await prepare.click();
  await openDetails('#material-data-controls');await page.locator('#material-source-type').selectOption('synthetic');await page.locator('#material-file').setInputFiles('dist/data/synthetic-material.csv');
  await page.waitForFunction(()=>workbench.inspect().material?.sourceType==='synthetic');
  const beforeUnsupported=await inspect();assert.ok(beforeUnsupported.revision>after.revision,'actual CSV import must update the source revision');
  await page.locator('#step-button').click();
  await page.waitForFunction(()=>{const s=workbench.inspect();return !s.computing&&!!s.solverError;},null,{timeout});
  await Promise.allSettled(responses);
  const rejected=await inspect();report.unsupportedMaterial={scope:'actual UI synthetic CSV upload, then native single-step refusal',basis:staticFailure?'explicit refit after failed static gate':'accepted static state',revisionBefore:beforeUnsupported.revision,revisionAfter:rejected.revision,acceptedPoseBefore:beforeUnsupported.pose,acceptedPoseAfter:rejected.pose,stepsBefore:beforeUnsupported.steps,stepsAfter:rejected.steps,error:rejected.solverError,positionsUnchanged:JSON.stringify(rejected.positions)===JSON.stringify(beforeUnsupported.positions),velocitiesUnchanged:JSON.stringify(rejected.snapshot.design.model.velocities)===JSON.stringify(beforeUnsupported.snapshot.design.model.velocities)};
  await writeFile('evidence/native-unsupported-material-state.json',JSON.stringify(rejected.snapshot));await writeFile('evidence/native-unsupported-material-report.json',JSON.stringify(report.unsupportedMaterial,null,2));
  const refusal=report.requests.at(-1)?.result;assert.equal(refusal?.committed,false);assert.equal(refusal?.converged,false);assert.equal(refusal?.status,'unsupported');assert.equal(refusal?.advancedTime,0);
  assert.match(rejected.solverError,/Nonlinear|material|材料|本构/i);assert.equal(rejected.pose,beforeUnsupported.pose);assert.equal(rejected.snapshot.design.pose,beforeUnsupported.snapshot.design.pose);assert.equal(rejected.revision,beforeUnsupported.revision);assert.equal(rejected.steps,beforeUnsupported.steps);assert.deepEqual(rejected.positions,beforeUnsupported.positions);assert.deepEqual(rejected.snapshot.design.model.velocities,beforeUnsupported.snapshot.design.model.velocities);assert.equal(rejected.playing,false);
  await page.waitForTimeout(500);const settled=await inspect();assert.equal(settled.steps,beforeUnsupported.steps);assert.deepEqual(settled.positions,beforeUnsupported.positions);assert.equal(settled.pose,beforeUnsupported.pose);assert.equal(settled.revision,beforeUnsupported.revision);pass('unsupported nonlinear material is refused after actual UI CSV import without changing positions, velocity, accepted pose, revision or time');
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);pass('the actual page emits no uncaught or console errors');await page.screenshot({path:'evidence/native-final.png',fullPage:true});
  if(staticFailure)throw staticFailure;
}catch(error){
  report.failure={message:error.message,stack:error.stack};await page.screenshot({path:'evidence/native-failure.png',fullPage:true}).catch(()=>{});throw error;
}finally{
  await Promise.allSettled(responses);await writeFile('evidence/native-browser-report.json',JSON.stringify(report,null,2));await browser.close();
}
