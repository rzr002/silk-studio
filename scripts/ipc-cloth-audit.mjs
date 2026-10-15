#!/usr/bin/env node
// Independent JS geometry checks against the same body rendered by the app.
// This script does not run or replace the native solver, and never edits state.
import fs from 'node:fs';
import {restoreModel} from '../dist/physics.mjs';
import {bodyProjection,auditBodyIntersections} from '../dist/contact.mjs';
import {stockingToeCoverage} from '../dist/garment-geometry.mjs';
const [requestPath,resultPath,outputPath]=process.argv.slice(2);
if(!requestPath||!resultPath)throw new Error('usage: node scripts/ipc-cloth-audit.mjs request.json result.json [audit.json]');
const request=JSON.parse(fs.readFileSync(requestPath,'utf8')),result=JSON.parse(fs.readFileSync(resultPath,'utf8'));
const model=restoreModel(request.snapshot);
if(!result.committed)throw new Error(`No committed candidate to audit: ${result.status}: ${result.message}`);
model.positions.set(result.positions);model.velocities.set(result.velocities);
const pose=result.pose,dimensions=request.step.bodyDimensions||request.context.bodyDimensions;
const settings={pose,dimensions,margin:0};
let penetratingVertices=0,penetratingSamples=0,maxPenetrationM=0,anchorDisplacementM=0;
const penetration=point=>{const q=bodyProjection(...point,settings);return q?Math.hypot(...point.map((x,k)=>x-q[k])):0;};
for(let i=0;i<model.positions.length;i+=3){const d=penetration([...model.positions.slice(i,i+3)]);if(d>1e-7)penetratingVertices++;maxPenetrationM=Math.max(maxPenetrationM,d);}
for(let j=0;j<model.triangles.length;j+=3){
  const points=model.triangles.slice(j,j+3).map(i=>model.positions.slice(i*3,i*3+3));
  for(const weights of [[1/3,1/3,1/3],[.5,.5,0],[.5,0,.5],[0,.5,.5],[.6,.2,.2],[.2,.6,.2],[.2,.2,.6]]){
    const point=[0,1,2].map(k=>points.reduce((sum,p,i)=>sum+p[k]*weights[i],0));
    const d=penetration(point);if(d>1e-7)penetratingSamples++;maxPenetrationM=Math.max(maxPenetrationM,d);
  }
}
for(const i of model.pins)anchorDisplacementM=Math.max(anchorDisplacementM,Math.hypot(...[0,1,2].map(k=>model.positions[i*3+k]-request.snapshot.positions[i*3+k])));
const toe=stockingToeCoverage(model,{pose,dimensions}),bodyToeCoverage=stockingToeCoverage(model,{pose,dimensions,probeOffsetM:0}),intersections=auditBodyIntersections(model,{pose,dimensions});
const constraints=model.constraints.map((c,index)=>{const current=Math.hypot(...[0,1,2].map(k=>model.positions[c.a*3+k]-model.positions[c.b*3+k]));return {index,kind:c.kind,a:c.a,b:c.b,restLengthM:c.restLength,currentLengthM:current,engineeringStrain:current/c.restLength-1};}).sort((a,b)=>b.engineeringStrain-a.engineeringStrain);
const finite=result.positions.every(Number.isFinite)&&result.velocities.every(Number.isFinite);
const passed=finite&&result.converged&&result.diagnostics.collisionFree&&toe.covered&&bodyToeCoverage.covered&&intersections.pairCount===0&&penetratingVertices===0&&penetratingSamples===0&&anchorDisplacementM===0&&constraints[0].engineeringStrain<5;
const audit={passed,requestPath,resultPath,pose,dt:result.advancedTime,finite,converged:result.converged,nativeCollisionFree:result.diagnostics.collisionFree,
  penetratingVertices,penetratingSamples,maxPenetrationM,anchorDisplacementM,toe,bodyToeCoverage,intersections,worstConstraints:constraints.slice(0,5),
  solverMs:result.ms,newtonIterations:result.diagnostics.newtonIterations,substepEnergies:result.diagnostics.substepEnergies,
  directSubstepChordCollisionFree:result.diagnostics.directSubstepChordCollisionFree,
  trajectoryModel:result.diagnostics.trajectoryModel||result.diagnostics.trajectoryMode,
  physicsValidated:false,manufacturingVerified:false};
const encoded=JSON.stringify(audit,null,2)+'\n';if(outputPath)fs.writeFileSync(outputPath,encoded);else process.stdout.write(encoded);
process.exitCode=passed?0:1;
