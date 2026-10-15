// Generates one locked mesh and runs the browser solver without rendering.
// Python consumes this exact geometry and masses; no claim of full constitutive
// equivalence is made from matching three infinitesimal affine energy modes.
import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import os from 'node:os';
import {createPatch} from '../dist/physics.mjs';
const config={cols:12,rows:16,width:.5,height:.65,density:.12,dt:1/60,substeps:3,iterations:8,frames:90,gravity:[0,-9.81,0],damping:0};
const base=createPatch(config);for(const i of [...base.pins])if(i%base.cols!==0&&i%base.cols!==base.cols-1)base.pin(i,false);
const area=config.width*config.height,epsilon=1e-5;
function affineEnergy(mode){let e=0;for(const c of base.constraints){const p=[c.a,c.b].map(i=>[...base.rest.slice(i*3,i*3+3)]);for(const v of p){if(mode==='weft')v[0]*=1+epsilon;if(mode==='warp')v[1]*=1+epsilon;if(mode==='shear')v[0]+=epsilon*v[1];}const d=Math.hypot(...p[0].map((v,k)=>v-p[1][k]))-c.restLength;e+=.5*d*d/c.compliance;}return 2*e/(area*epsilon*epsilon);}
const input={config,snapshot:base.snapshot(),masses:[...base.inverseMass].map(w=>w?1/w:0),area,infinitesimalAffineModuliNPerM:Object.fromEntries(['weft','warp','shear'].map(d=>[d,affineEnergy(d)])),caveats:['Affine energy mapping matches three pure infinitesimal modes only.','XPBD diagonal springs introduce coupling absent from the selected triangle anisotropic law.','Two-hop distance bending and Style3D curvature bending are not matched.','Both test cases disable contact, nonlinear measured laws and rendering.']};
function metrics(m){const p=m.positions,extensions=m.constraints.filter(c=>['weft','warp','shear'].includes(c.kind)).map(c=>Math.abs(Math.hypot(...[0,1,2].map(k=>p[c.a*3+k]-p[c.b*3+k]))/c.restLength-1));let anchorError=0;for(const i of base.pins)anchorError=Math.max(anchorError,Math.hypot(...[0,1,2].map(k=>p[i*3+k]-base.rest[i*3+k])));return {finite:p.every(Number.isFinite),anchorMaxErrorM:anchorError,maxEdgeStrain:Math.max(...extensions),meanEdgeStrain:extensions.reduce((s,x)=>s+x,0)/extensions.length,bottomMid:[...p.slice(Math.floor(config.cols/2)*3,Math.floor(config.cols/2)*3+3)],maxDisplacementM:Math.max(...Array.from({length:p.length/3},(_,i)=>Math.hypot(...[0,1,2].map(k=>p[i*3+k]-base.rest[i*3+k]))))};}
const output={backend:'project-javascript-xpbd',node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,config,cases:[]};
for(const name of ['gravity','displacement']){
 const m=createPatch(config);for(const i of [...m.pins])if(!base.pins.has(i))m.pin(i,false);
 const grasp=Math.floor(config.cols/2),start=[...m.positions.slice(grasp*3,grasp*3+3)],times=[];
 if(name==='displacement')m.grab(grasp,start);
 for(let frame=0;frame<config.frames;frame++){const f=Math.min(1,(frame+1)/60);if(name==='displacement')m.moveGrab([start[0]+.1*f,start[1]-.09*f,start[2]]);const t=performance.now();m.step(config.dt,{gravity:config.gravity,substeps:config.substeps,iterations:config.iterations,damping:config.damping});times.push(performance.now()-t);if(!m.positions.every(Number.isFinite))throw new Error(`${name} became nonfinite at frame ${frame}`);}
 const warm=times.slice(10),ordered=[...warm].sort((a,b)=>a-b);output.cases.push({name,...metrics(m),meanStepMs:warm.reduce((s,t)=>s+t,0)/warm.length,medianStepMs:ordered[Math.floor(ordered.length/2)],warmupFrames:10,frames:config.frames,finalPositions:[...m.positions]});
}
await mkdir(new URL('../evidence/',import.meta.url),{recursive:true});
await writeFile(new URL('../evidence/backend-input.json',import.meta.url),JSON.stringify(input,null,2));
await writeFile(new URL('../evidence/backend-xpbd.json',import.meta.url),JSON.stringify(output,null,2));
console.log(JSON.stringify({...output,cases:output.cases.map(({finalPositions,...c})=>c),affineModuli:input.infinitesimalAffineModuliNPerM},null,2));
