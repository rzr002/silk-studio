import {LAB_URL} from './lab-url.mjs';
import assert from 'node:assert/strict';
import {loadPlaywright} from './playwright.mjs';
import {createHash} from 'node:crypto';
import {mkdir,rename,writeFile} from 'node:fs/promises';

const playwright=loadPlaywright();
const url=LAB_URL;
const timeout=Number(process.env.NATIVE_MOTION_TIMEOUT_MS||7200000);
assert.ok(Number.isFinite(timeout)&&timeout>0,'NATIVE_MOTION_TIMEOUT_MS must be positive');
const started=Date.now(),report={date:new Date().toISOString(),status:'running',completed:false,url,timeoutMs:timeout,health:null,checks:[],progress:[],requests:[],pageErrors:[],consoleErrors:[],contactReference:{hash:null,missing:0},static:null,motion:null,unsupportedMaterial:null,componentNegativeDt:null,failure:null,
  limits:'Actual UI and accepted HTTP states for one declared numerical configuration. Sampled geometry audits do not prove complete surface enclosure. IPC solver paths and straight rendered-frame interpolation are recorded separately. No physical material calibration, friction validation or manufacturing verification.'};
await mkdir('evidence',{recursive:true});
let stopRequested=false,liveWrite=Promise.resolve(),lastCheckpointSteps=-1;
const onSigint=()=>{stopRequested=true;report.stopRequested={signal:'SIGINT',date:new Date().toISOString()};console.log('CANCEL requested: saving accepted state and closing the browser');};
process.on('SIGINT',onSigint);
function checkStop(){if(stopRequested){const error=new Error('Native motion test cancelled by SIGINT; no completion is claimed');error.name='TestCancelledError';error.code='CANCELLED';throw error;}}
function flushLive(){
  report.wallMs=Date.now()-started;const encoded=JSON.stringify(report,null,2);
  liveWrite=liveWrite.then(async()=>{await writeFile('evidence/.native-motion-browser-report.tmp',encoded);await rename('evidence/.native-motion-browser-report.tmp','evidence/native-motion-browser-report.json');});
  return liveWrite;
}
const browser=await playwright.chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),responseReads=new Set();
let scope='static',protocolFailure=null;
const inspect=()=>page.evaluate(()=>workbench.inspect());
const summary=()=>page.evaluate(()=>{const s=workbench.inspect();return {pose:s.pose,targetPose:s.targetPose,steps:s.steps,computing:s.computing,playing:s.playing,solverError:s.solverError};});
const pass=name=>{report.checks.push(name);console.log('PASS',name);};
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const near=(a,b,message)=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<1e-10,message||`${a} != ${b}`);
async function openDetails(id){if(await page.locator(id).evaluate(el=>el.tagName==='DETAILS'&&!el.open))await page.locator(`${id}>summary`).click();}
const noPageErrors=()=>{assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);};
function validateRuntime(runtime){
  assert.equal(runtime?.solverSourceHash,report.health.solverSourceHash,'each HTTP result must identify the loaded solver source');
  for(const field of ['ipctkVersion','numpyVersion','scipyVersion'])assert.equal(runtime[field],report.health[field],`runtime ${field} must match health`);
}
function validateAccepted(record){
  const {request:q,result:r}=record;
  assert.equal(record.httpStatus,200);for(const key of ['version','epoch','requestId','designRevision','baseStateId'])assert.equal(r[key],q[key],`response identity ${key}`);
  assert.equal(r.designId,q.designId);assert.equal(r.committed,true,`native step refused: ${r.status}: ${r.message}`);assert.equal(r.converged,true,'accepted native steps must actually converge');
  near(r.advancedTime,q.dt,'accepted native step must advance its complete requested dt');near(r.pose,q.targetPose,'accepted native step must reach its complete requested body pose');
  assert.equal(r.diagnostics?.collisionFree,true);assert.equal(r.diagnostics?.bodyTargetReached,true);validateRuntime(r.runtime);
  assert.equal(r.diagnostics.physicsValidated,false);assert.equal(r.diagnostics.manufacturingVerified,false);
  const reference=r.diagnostics.contactReferenceHash;
  if(reference===undefined||reference===null){report.contactReference.missing++;}
  else {assert.equal(typeof reference,'string');assert.ok(reference.length>0);if(report.contactReference.hash!==null)assert.equal(reference,report.contactReference.hash,'contact reference metrics must remain fixed across HTTP steps');else report.contactReference.hash=reference;}
}
function validateLedger(){
  const accepted=report.requests.filter(x=>['static','motion'].includes(x.scope)).sort((a,b)=>a.request.requestId-b.request.requestId);
  for(let i=1;i<accepted.length;i++){
    const previous=accepted[i-1],current=accepted[i];near(current.request.acceptedPoseBefore,previous.result.pose,'each request must start at the preceding accepted body pose');assert.equal(current.request.baseStateId,previous.request.baseStateId+1);assert.equal(current.request.designId,previous.request.designId);assert.equal(current.request.designRevision,previous.request.designRevision);
  }
  return accepted;
}
page.on('pageerror',error=>report.pageErrors.push(error.message));
page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
page.on('response',response=>{
  if(new URL(response.url()).pathname!=='/api/reference-step'||response.request().method()!=='POST')return;
  const responseScope=scope;
  const read=(async()=>{
    const payload=response.request().postDataJSON(),record={scope:responseScope,httpStatus:response.status(),request:{version:payload.version,epoch:payload.epoch,requestId:payload.requestId,designId:payload.designId,designRevision:payload.designRevision,baseStateId:payload.baseStateId,acceptedPoseBefore:payload.context.pose,targetPose:payload.step.pose,dt:payload.step.dt,quality:payload.step.quality}};
    report.requests.push(record);
    try{
      const result=await response.json();
      record.result={version:result.version,epoch:result.epoch,requestId:result.requestId,designId:result.designId,designRevision:result.designRevision,baseStateId:result.baseStateId,committed:result.committed,converged:result.converged,status:result.status,pose:result.pose,advancedTime:result.advancedTime,ms:result.ms,message:result.message,runtime:result.runtime,diagnostics:result.diagnostics,collisionStats:result.collisionStats};
      if(['static','motion'].includes(responseScope))validateAccepted(record);
      else if(responseScope==='unsupported-material'){
        assert.equal(record.httpStatus,200);assert.equal(result.committed,false);assert.equal(result.converged,false);assert.equal(result.status,'unsupported');near(result.advancedTime,0);near(result.pose,payload.context.pose);validateRuntime(result.runtime);
      }
    }catch(error){record.validationFailure=error.message;protocolFailure||=error;}
    await flushLive();
  })();
  responseReads.add(read);void read.finally(()=>responseReads.delete(read)).catch(error=>{protocolFailure||=error;});
});
async function drain(){while(responseReads.size)await Promise.allSettled([...responseReads]);if(protocolFailure)throw protocolFailure;}
async function checkpoint({force=false}={}){
  const s=await inspect();if(!force&&s.steps<lastCheckpointSteps+5)return;
  await writeFile('evidence/native-motion-latest-accepted-state.json',JSON.stringify(s.snapshot));
  lastCheckpointSteps=s.steps;report.latestCheckpoint={date:new Date().toISOString(),phase:scope,acceptedPose:s.pose,targetPose:s.targetPose,steps:s.steps,computing:s.computing,positionsHash:sha(s.positions),file:'native-motion-latest-accepted-state.json'};
  await writeFile('evidence/native-motion-checkpoint.json',JSON.stringify(report.latestCheckpoint,null,2));await flushLive();
}
async function waitForAccepted(predicate,label){
  const begin=Date.now();let nextLog=begin;
  while(Date.now()-begin<timeout){
    checkStop();
    const s=await summary();
    if(protocolFailure)throw protocolFailure;
    if(s.solverError)throw new Error(`${label}: ${s.solverError}`);
    noPageErrors();
    if(scope==='motion'&&s.steps>=lastCheckpointSteps+5)await checkpoint();
    if(predicate(s))return s;
    if(Date.now()>=nextLog){
      const progress={phase:label,wallMs:Date.now()-started,phaseWaitMs:Date.now()-begin,...s};report.progress.push(progress);console.log('PROGRESS',JSON.stringify(progress));await writeFile('evidence/native-motion-progress.json',JSON.stringify(report.progress,null,2));await flushLive();nextLog=Date.now()+30000;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`${label} timed out after ${timeout} ms`);
}
async function geometryAudit(){
  return page.evaluate(async()=>{
    const s=workbench.inspect(),saved=s.snapshot.design.model;
    const [{bodyProjection,auditBodyIntersections},{stockingToeCoverage},{restoreModel}]=await Promise.all([import('/contact.mjs'),import('/garment-geometry.mjs'),import('/physics.mjs')]);
    const model=restoreModel(saved),options={pose:s.pose,dimensions:s.snapshot.design.bodyDimensions,margin:0};
    let vertexPenetrations=0,surfacePenetrations=0,maxDepth=0,pinMaxError=0;
    const depth=p=>{const q=bodyProjection(...p,options);return q?Math.hypot(...p.map((x,k)=>x-q[k])):0;};
    for(let i=0;i<saved.positions.length;i+=3){const d=depth(saved.positions.slice(i,i+3));if(d>1e-7)vertexPenetrations++;maxDepth=Math.max(maxDepth,d);}
    const weights=[[1/3,1/3,1/3],[.5,.5,0],[0,.5,.5],[.5,0,.5],[.6,.2,.2],[.2,.6,.2],[.2,.2,.6]];
    for(let f=0;f<saved.triangles.length;f+=3){const ids=saved.triangles.slice(f,f+3);for(const w of weights){const p=[0,1,2].map(k=>ids.reduce((sum,id,a)=>sum+saved.positions[id*3+k]*w[a],0)),d=depth(p);if(d>1e-7)surfacePenetrations++;maxDepth=Math.max(maxDepth,d);}}
    for(const [index,target] of saved.pinTargets)pinMaxError=Math.max(pinMaxError,Math.hypot(...target.map((x,k)=>x-saved.positions[index*3+k])));
    return {pose:s.pose,vertices:saved.positions.length/3,faces:saved.triangles.length/3,finite:saved.positions.every(Number.isFinite)&&saved.velocities.every(Number.isFinite),pins:saved.pins.length,pinMaxError,vertexPenetrations,surfacePenetrations,samplesPerFace:7,maxDepth,
      toeAtBody:stockingToeCoverage(model,{...options,probeOffsetM:0}),toeWithHalfMillimeterClearance:stockingToeCoverage(model,options),intersections:auditBodyIntersections(model,options)};
  });
}
function requireClear(audit){
  assert.equal(audit.finite,true);assert.ok(audit.pins>0);assert.ok(audit.pinMaxError<1e-12,'all fixed cuff vertices must remain fixed');
  assert.equal(audit.intersections.pairCount,0,'actual cloth/body triangle crossings must be zero');assert.equal(audit.vertexPenetrations,0);assert.equal(audit.samplesPerFace,7);assert.equal(audit.surfacePenetrations,0,'seven interior/edge samples per face must all clear the analytic body');
  for(const [name,toe] of [['actual body tip',audit.toeAtBody],['extra 0.5 mm clearance',audit.toeWithHalfMillimeterClearance]]){assert.equal(toe.applicable,true);assert.equal(toe.probes,17);assert.equal(toe.uncoveredProbes,0,`${name} exposure`);assert.equal(toe.covered,true,`${name} coverage`);}
  near(audit.toeAtBody.probeOffsetM,0);near(audit.toeWithHalfMillimeterClearance.probeOffsetM,.0005);
}

try{
  checkStop();
  await page.goto(url);await page.waitForFunction(()=>window.workbench?.inspect);
  report.health=await page.evaluate(async()=>{const r=await fetch('/api/health');return {httpStatus:r.status,...await r.json()};});
  assert.equal(report.health.httpStatus,200);assert.equal(report.health.referenceAvailable,true);assert.match(report.health.solverSourceHash,/^[a-f0-9]{64}$/);for(const key of ['ipctkVersion','numpyVersion','scipyVersion'])assert.equal(typeof report.health[key],'string');assert.equal(report.health.manufacturing,'unverified');
  pass('real native health reports its loaded solver hash and library runtime versions');
  await openDetails('#solver-controls');await page.waitForFunction(()=>!document.querySelector('#solver-backend option[value=native]').disabled);await page.locator('#solver-backend').selectOption('native');
  assert.equal((await inspect()).settings.backend,'native');assert.match(await page.locator('#prepare-reference').textContent(),/6\s*mm/);await page.locator('#prepare-reference').click();
  const prepared=await inspect();assert.equal(prepared.kind,'stocking');near(prepared.pose,0);near(prepared.targetPose,0);assert.equal(prepared.playing,false);requireClear(await geometryAudit());
  await writeFile('evidence/native-motion-prepared-state.json',JSON.stringify(prepared.snapshot));report.design={id:prepared.designId,revision:prepared.revision};pass('the actual visible 6 mm refit prepares the complete stocking at zero degrees');
  console.log('RUN native static acceptance before motion');await page.locator('#step-button').click();await waitForAccepted(s=>!s.computing&&s.steps===prepared.steps+1,'static prerequisite');await drain();
  const stationary=await inspect();report.static={steps:stationary.steps,pose:stationary.pose,frameMs:stationary.frameMs,contact:await geometryAudit()};requireClear(report.static.contact);
  await writeFile('evidence/native-motion-static-accepted-state.json',JSON.stringify(stationary.snapshot));await writeFile('evidence/native-motion-static-accepted-audit.json',JSON.stringify(report.static,null,2));await page.screenshot({path:'evidence/native-motion-static-accepted.png',fullPage:true});await checkpoint({force:true});
  pass('one real static full-stocking native step is committed and geometrically clear');await flushLive();checkStop();

  scope='motion';const motionStart=Date.now();await page.locator('#pose').focus();await page.keyboard.press('End');console.log('RUN actual native UI motion from 0 to 55 degrees');
  await waitForAccepted(s=>s.pose>=55-1e-10,'native 0 → 55°');
  if((await summary()).playing)await page.locator('#play-button').click();
  await waitForAccepted(s=>!s.computing,'last in-flight accepted step');await drain();
  const final=await inspect(),contact=await geometryAudit();
  report.motion={wallMs:Date.now()-motionStart,acceptedPose:final.pose,targetPose:final.targetPose,stepsBefore:stationary.steps,stepsAfter:final.steps,simulatedSeconds:(final.steps-stationary.steps)/60,frameMs:final.frameMs,positionsHash:sha(final.positions),settings:final.settings,stats:final.stats,contact};
  await writeFile('evidence/native-motion-final-state.json',JSON.stringify(final.snapshot));await writeFile('evidence/native-motion-final-audit.json',JSON.stringify(report.motion,null,2));await page.screenshot({path:'evidence/native-motion-55.png',fullPage:true});
  near(final.pose,55);near(final.targetPose,55);assert.equal(final.playing,false);assert.ok(final.steps>stationary.steps);await checkpoint({force:true});
  for(const [index,target] of prepared.snapshot.design.model.pinTargets)assert.ok(Math.hypot(...target.map((x,k)=>x-final.positions[index*3+k]))<1e-12,'the initial prepared cuff anchors must remain unchanged');
  requireClear(contact);pass('actual native motion reaches accepted 55 degrees with finite state, fixed pins, zero crossings, all surface samples clear and both 17-point toe audits covered');
  const accepted=validateLedger();assert.equal(accepted.length,final.steps-prepared.steps,'every displayed accepted step must have exactly one real HTTP acceptance');pass('every native HTTP acceptance is converged, advances a complete dt and reaches the complete requested pose');

  // Preserve the successful motion artifacts before changing any source data.
  checkStop();scope='unsupported-material';await openDetails('#material-data-controls');await page.locator('#material-source-type').selectOption('synthetic');await page.locator('#material-template').click();await page.waitForFunction(()=>workbench.inspect().material?.sourceType==='synthetic');
  const materialBefore=await inspect();assert.ok(materialBefore.revision>final.revision);assert.equal(materialBefore.steps,final.steps);const negativesBefore=report.requests.filter(x=>x.scope==='unsupported-material').length;
  await page.locator('#step-button').click();await page.waitForFunction(()=>{const s=workbench.inspect();return !s.computing&&!!s.solverError;},null,{timeout:30000});await drain();const materialAfter=await inspect();
  report.unsupportedMaterial={scope:'actual UI material-template import and native single-step rejection',sourceType:materialBefore.material.sourceType,revisionBefore:materialBefore.revision,revisionAfter:materialAfter.revision,poseBefore:materialBefore.pose,poseAfter:materialAfter.pose,stepsBefore:materialBefore.steps,stepsAfter:materialAfter.steps,error:materialAfter.solverError,positionsUnchanged:sha(materialBefore.positions)===sha(materialAfter.positions),velocitiesUnchanged:sha(materialBefore.snapshot.design.model.velocities)===sha(materialAfter.snapshot.design.model.velocities)};
  assert.equal(report.requests.filter(x=>x.scope==='unsupported-material').length,negativesBefore+1);assert.match(materialAfter.solverError,/Nonlinear|material|材料|本构/i);assert.deepEqual(materialAfter.positions,materialBefore.positions);assert.deepEqual(materialAfter.snapshot.design.model.velocities,materialBefore.snapshot.design.model.velocities);assert.equal(materialAfter.pose,materialBefore.pose);assert.equal(materialAfter.revision,materialBefore.revision);assert.equal(materialAfter.steps,materialBefore.steps);assert.equal(materialAfter.playing,false);
  await page.waitForTimeout(500);const settled=await inspect();assert.equal(settled.steps,materialBefore.steps);assert.deepEqual(settled.positions,materialBefore.positions);
  await writeFile('evidence/native-motion-unsupported-material-report.json',JSON.stringify(report.unsupportedMaterial,null,2));await writeFile('evidence/native-motion-unsupported-material-state.json',JSON.stringify(materialAfter.snapshot));await page.screenshot({path:'evidence/native-motion-unsupported-material.png',fullPage:true});pass('after a real UI material import, unsupported nonlinear native physics is refused without changing accepted positions, pose, revision or time');

  report.componentNegativeDt=await page.evaluate(async()=>{
    const {NativeSimulationController}=await import('/native-simulation.mjs'),s=workbench.inspect(),c=new NativeSimulationController(),messages=[];
    c.onmessage=({data})=>messages.push({type:data.type,message:data.message});await c.postMessage({type:'sync',epoch:1,pose:s.pose,bodyDimensions:s.snapshot.design.bodyDimensions,snapshot:s.snapshot.design.model,designId:'component-negative-dt',designRevision:s.revision});const before=JSON.stringify({snapshot:c.snapshot,context:c.context,baseStateId:c.baseStateId});await c.postMessage({type:'step',epoch:1,pose:s.pose,dt:-1,gravity:true,collider:true,selfCollision:true,continuousCollision:true,quality:'reference',grabbed:null});return {scope:'isolated controller component check, not a UI route',messages,unchanged:before===JSON.stringify({snapshot:c.snapshot,context:c.context,baseStateId:c.baseStateId})};
  });
  assert.equal(report.componentNegativeDt.unchanged,true);assert.equal(report.componentNegativeDt.messages.at(-1).type,'error');pass('the separately labelled controller component rejects a negative dt atomically');noPageErrors();
  report.status='passed';report.completed=true;report.wallMs=Date.now()-started;
}catch(error){
  report.status=stopRequested?'cancelled':'failed';report.completed=false;report.failure={code:stopRequested?'CANCELLED':error.code||'FAILED',message:stopRequested?`Cancelled by SIGINT: ${error.message}`:error.message,stack:error.stack};report.cancelled=stopRequested;console.log(stopRequested?'CANCEL native motion:':'FAIL native motion:',error.message);
  try{if((await summary()).playing)await page.locator('#play-button').click();const stopped=await inspect();report.stopped={pose:stopped.pose,targetPose:stopped.targetPose,steps:stopped.steps,computing:stopped.computing,solverError:stopped.solverError};await writeFile('evidence/native-motion-failure-state.json',JSON.stringify(stopped.snapshot));await checkpoint({force:true});}catch{}
  await page.screenshot({path:'evidence/native-motion-failure.png',fullPage:true}).catch(()=>{});if(stopRequested)process.exitCode=130;else throw error;
}finally{
  try{const current=await inspect();await writeFile('evidence/native-motion-current-state.json',JSON.stringify(current.snapshot));report.currentState={date:new Date().toISOString(),pose:current.pose,targetPose:current.targetPose,steps:current.steps,computing:current.computing,file:'native-motion-current-state.json'};}catch(error){report.currentStateSaveError=error.message;}
  await browser.close();await Promise.allSettled([...responseReads]);await flushLive();process.off('SIGINT',onSigint);
}
