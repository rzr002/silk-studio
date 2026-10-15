#!/usr/bin/env node
// Reads accepted browser artifacts only; never advances or mutates the solver.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {restoreModel} from '../dist/physics.mjs';
import {bodyProjection,auditBodyIntersections} from '../dist/contact.mjs';
import {stockingToeCoverage} from '../dist/garment-geometry.mjs';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function auditAcceptedCheckpoint(state,checkpoint,baseline){
  const positionsHash=sha(state.design.model.positions);
  if(positionsHash!==checkpoint.positionsHash||state.pose!==checkpoint.acceptedPose)throw Error('Checkpoint/state identity or positions hash does not match; retry the read');
  const model=restoreModel(state.design.model),ref=model.collisionStats.reference||{},oldRef=baseline.design.model.collisionStats.reference||{},options={pose:state.pose,dimensions:state.design.bodyDimensions,margin:0};
  let penetratingVertices=0,penetratingFaceSamples=0,maxPenetrationM=0,anchorDisplacementM=0,currentAnchorTargetErrorM=0;
  const depth=p=>{const q=bodyProjection(...p,options);return q?Math.hypot(...p.map((v,k)=>v-q[k])):0;};
  for(let j=0;j<model.positions.length;j+=3){const d=depth([...model.positions.slice(j,j+3)]);if(d>1e-7)penetratingVertices++;maxPenetrationM=Math.max(maxPenetrationM,d);}
  const weights=[[1/3,1/3,1/3],[.5,.5,0],[.5,0,.5],[0,.5,.5],[.6,.2,.2],[.2,.6,.2],[.2,.2,.6]];
  for(let j=0;j<model.triangles.length;j+=3){const p=model.triangles.slice(j,j+3).map(i=>model.positions.slice(i*3,i*3+3));for(const w of weights){const q=[0,1,2].map(k=>p.reduce((s,v,i)=>s+v[k]*w[i],0)),d=depth(q);if(d>1e-7)penetratingFaceSamples++;maxPenetrationM=Math.max(maxPenetrationM,d);}}
  const beforeTargets=new Map(baseline.design.model.pinTargets),beforePins=baseline.design.model.pins;
  let pinTargetsStable=JSON.stringify([...model.pins].sort((a,b)=>a-b))===JSON.stringify([...beforePins].sort((a,b)=>a-b));
  for(const i of model.pins){const old=baseline.design.model.positions.slice(i*3,i*3+3),p=[...model.positions.slice(i*3,i*3+3)],target=model.pinTargets.get(i);anchorDisplacementM=Math.max(anchorDisplacementM,Math.hypot(...p.map((v,k)=>v-old[k])));currentAnchorTargetErrorM=Math.max(currentAnchorTargetErrorM,Math.hypot(...p.map((v,k)=>v-target[k])));if(JSON.stringify(beforeTargets.get(i))!==JSON.stringify(target))pinTargetsStable=false;}
  const constraints=model.constraints.map((c,index)=>{const current=Math.hypot(...[0,1,2].map(k=>model.positions[c.a*3+k]-model.positions[c.b*3+k]));return {index,kind:c.kind,a:c.a,b:c.b,restLengthM:c.restLength,currentLengthM:current,engineeringStrain:current/c.restLength-1};}).sort((a,b)=>b.engineeringStrain-a.engineeringStrain);
  const bodyToeCoverage=stockingToeCoverage(model,{...options,probeOffsetM:0}),clearanceToeCoverage=stockingToeCoverage(model,{...options,probeOffsetM:.0005}),intersections=auditBodyIntersections(model,options),finite=model.positions.every(Number.isFinite)&&model.velocities.every(Number.isFinite);
  const identityMatches=ref.designId===state.design.id&&ref.designRevision===state.design.revision&&ref.acceptedPose===checkpoint.acceptedPose&&state.design.pose===checkpoint.acceptedPose&&baseline.design.id===state.design.id&&baseline.design.revision===state.design.revision;
  const solverSourceHashStable=!!ref.runtime?.solverSourceHash&&ref.runtime.solverSourceHash===oldRef.runtime?.solverSourceHash,contactReferenceHashStable=!!ref.diagnostics?.contactReferenceHash&&ref.diagnostics.contactReferenceHash===oldRef.diagnostics?.contactReferenceHash;
  const failures=[];
  for(const [code,ok] of [['identity',identityMatches],['solver-source',solverSourceHashStable],['contact-reference',contactReferenceHashStable],['finite',finite],['anchors',pinTargetsStable&&anchorDisplacementM===0&&currentAnchorTargetErrorM===0],['body-vertex-contact',penetratingVertices===0],['body-face-samples',penetratingFaceSamples===0],['triangle-crossings',intersections.pairCount===0],['body-toe-coverage',bodyToeCoverage.covered===true],['toe-clearance',clearanceToeCoverage.covered===true],['strain-sanity',(constraints[0]?.engineeringStrain??Infinity)<5],['accepted-protocol',ref.converged===true&&ref.diagnostics?.bodyTargetReached===true&&ref.diagnostics?.collisionFree===true]])if(!ok)failures.push(code);
  return {auditedAt:new Date().toISOString(),checkpoint,identityMatches,designId:state.design.id,designRevision:state.design.revision,acceptedPose:state.pose,positionsHash,solverSourceHash:ref.runtime?.solverSourceHash,contactReferenceHash:ref.diagnostics?.contactReferenceHash,solverSourceHashStable,contactReferenceHashStable,passed:failures.length===0,failures,finite,pins:model.pins.size,pinTargetsStable,anchorDisplacementM,currentAnchorTargetErrorM,vertices:model.positions.length/3,faces:model.triangles.length/3,faceSamples:model.triangles.length/3*7,penetratingVertices,penetratingFaceSamples,maxPenetrationM,bodyToeCoverage,clearanceToeCoverage,intersections,maxStrain:constraints[0]?.engineeringStrain,worstConstraints:constraints.slice(0,3),physicsValidated:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [statePath='evidence/native-motion-latest-accepted-state.json',checkpointPath='evidence/native-motion-checkpoint.json',outputPath='evidence/native-checkpoint-audits.json',baselinePath='evidence/native-motion-static-accepted-state.json']=process.argv.slice(2);
  const first=fs.readFileSync(checkpointPath,'utf8'),state=JSON.parse(fs.readFileSync(statePath,'utf8')),second=fs.readFileSync(checkpointPath,'utf8');
  if(first!==second)throw Error('Checkpoint changed during read; retry');
  const checkpoint=JSON.parse(first),ledger=fs.existsSync(outputPath)?JSON.parse(fs.readFileSync(outputPath,'utf8')):{schema:'silk-independent-native-checkpoint-audits',version:1,audits:[]};
  if(ledger.audits.some(x=>x.positionsHash===checkpoint.positionsHash&&x.checkpoint.steps===checkpoint.steps&&x.checkpoint.phase===checkpoint.phase))console.log(JSON.stringify({status:'already-audited',acceptedPose:checkpoint.acceptedPose,steps:checkpoint.steps,positionsHash:checkpoint.positionsHash,passed:ledger.latest.passed}));
  else{const audit=auditAcceptedCheckpoint(state,checkpoint,JSON.parse(fs.readFileSync(baselinePath,'utf8')));ledger.audits.push(audit);ledger.latest=audit;fs.writeFileSync(outputPath+'.tmp',JSON.stringify(ledger,null,2));fs.renameSync(outputPath+'.tmp',outputPath);console.log(JSON.stringify(audit));if(!audit.passed)process.exitCode=1;}
}
