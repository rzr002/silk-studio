#!/usr/bin/env node
// Construct a reproducible next stateless request from an accepted reference
// result. Body arrays use the app's actual geometry, not a second Python proxy.
import fs from 'node:fs';
import {bodyGeometryData} from '../dist/garment-geometry.mjs';
const [inputPath,resultPath,targetText,outputPath]=process.argv.slice(2),targetPose=Number(targetText);
if(!inputPath||!resultPath||!outputPath||!Number.isFinite(targetPose)||targetPose<0||targetPose>55)throw new Error('usage: node scripts/ipc-cloth-next.mjs request.json accepted.json targetPose output.json');
const request=JSON.parse(fs.readFileSync(inputPath,'utf8')),result=JSON.parse(fs.readFileSync(resultPath,'utf8'));
if(!result.committed||!result.converged||!result.diagnostics.collisionFree)throw new Error('Only a fully accepted state may become the next source');
request.snapshot.positions=result.positions;request.snapshot.velocities=result.velocities;
request.snapshot.constraints.forEach((c,i)=>c.lambda=result.lambdas[i]);
request.snapshot.collisionStats=result.collisionStats;request.snapshot.grabForceN=result.grabForceN;
request.requestId++;request.baseStateId=typeof request.baseStateId==='number'?request.baseStateId+1:`${request.baseStateId}:accepted`;
request.context={pose:result.pose,bodyDimensions:request.step.bodyDimensions};
request.step.pose=targetPose;
request.body.previousPositions=[...bodyGeometryData({pose:result.pose,dimensions:request.context.bodyDimensions}).positions];
request.body.targetPositions=[...bodyGeometryData({pose:targetPose,dimensions:request.step.bodyDimensions}).positions];
request.body.referencePositions??=[...bodyGeometryData({pose:0,dimensions:request.context.bodyDimensions}).positions];
fs.writeFileSync(outputPath,JSON.stringify(request));
