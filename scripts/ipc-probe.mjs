// Export one real proposed UI step for the native IPC research probe.
// This does not modify the browser's design or replace the product solver.
import {writeFile} from 'node:fs/promises';
import {DesignDocument} from '../dist/design-document.mjs';
import {SimulationEngine} from '../dist/simulation.mjs';
import {bodyGeometryData,fitStocking} from '../dist/garment-geometry.mjs';

const document=new DesignDocument(),engine=new SimulationEngine(),margin=process.argv[3]===undefined?.003:Number(process.argv[3]);
fitStocking(document.model,{pose:0,dimensions:document.bodyDimensions,margin});
const initial=[...document.model.positions];
const body0=bodyGeometryData({pose:0,dimensions:document.bodyDimensions});
engine.sync(document.model.snapshot(),1,{pose:0,bodyDimensions:document.bodyDimensions});
const result=engine.step({epoch:1,pose:.7,bodyDimensions:document.bodyDimensions,gravity:true,collider:true,selfCollision:true,continuousCollision:true,quality:'standard',dt:1/60});
const body1=bodyGeometryData({pose:.7,dimensions:document.bodyDimensions});
const output=process.argv[2]||'/tmp/silk-ipc-candidate.json';
await writeFile(output,JSON.stringify({
  cloth:{positions0:initial,positions1:[...result.positions],triangles:engine.model.triangles},
  body:{positions0:body0.positions,positions1:body1.positions,triangles:body0.indices},
  metadata:{pose0:0,pose1:.7,dt:1/60,fitMargin:margin,source:'existing JavaScript SimulationEngine proposed complete step',manufacturing:'unverified'}
}));
console.log(JSON.stringify({output,clothVertices:initial.length/3,bodyVertices:body0.positions.length/3,proposedStepMs:result.ms}));
