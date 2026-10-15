import test from 'node:test';
import assert from 'node:assert/strict';
import { createPatch, restoreModel } from '../dist/physics.mjs';

test('incision duplicates edge vertices without removing faces, area or mass', () => {
  const m=createPatch({cols:9,rows:9});const before=m.stats();
  m.setRegion({u0:0,v0:0,u1:1,v1:1},{weft:2.5});
  assert.equal(typeof m.incisionSegmentUV,'function');
  const result=m.incisionSegmentUV([0,.5],[1,.5]);
  assert.equal(result.ok,true);assert.ok(result.addedVertices>0);
  assert.equal(m.stats().faces,before.faces);assert.ok(Math.abs(m.stats().mass-before.mass)<1e-12);
  assert.equal(result.removedFaces,0);assert.equal(result.removedMass,0);
  assert.equal(m.positions.length/3,81+result.addedVertices);
  assert.equal(m.sourceVertices.length,m.positions.length/3);
  assert.equal(new Set(m.vertexIds).size,m.vertexIds.length);
  assert.ok(m.constraints.filter(c=>c.kind==='weft').every(c=>c.stiffness===2.5));
});

test('a boundary to boundary incision disconnects the two physical sides', () => {
  const m=createPatch({cols:9,rows:9});assert.equal(typeof m.incisionSegmentUV,'function');
  const cut=m.incisionSegmentUV([0,.5],[1,.5]);
  const index=cut.pathB[4],other=cut.pathA[4];
  assert.notEqual(index,other);assert.deepEqual([...m.rest.slice(index*3,index*3+3)],[...m.rest.slice(other*3,other*3+3)]);
  for(let frame=0;frame<50;frame++)m.step(1/60);
  const dy=Math.abs(m.positions[index*3+1]-m.positions[other*3+1]);assert.ok(dy>.1,`separated only ${dy}`);
  assert.ok(m.positions.every(Number.isFinite));
});

test('incision preserves pin destinations and a full edited topology snapshot', () => {
  const m=createPatch({cols:9,rows:9});assert.equal(typeof m.incisionSegmentUV,'function');
  const oldIds=[...m.vertexIds],oldPins=[...m.pins];m.incisionSegmentUV([.5,0],[.5,1]);
  for(const i of oldPins){assert.ok(m.pins.has(i));assert.deepEqual(m.pinTargets.get(i),[...m.rest.slice(i*3,i*3+3)]);}
  assert.deepEqual(m.vertexIds.slice(0,81),oldIds);assert.equal(m.gridVertexCount,81);
  const saved=JSON.parse(JSON.stringify(m.snapshot()));const restored=restoreModel(saved);
  assert.deepEqual(restored.snapshot(),saved);assert.equal(restored.layout,'edited-grid');
});

test('sewPaths pairs an entire incision and unstitch removes exactly that seam group', () => {
  const m=createPatch({cols:9,rows:9});assert.equal(typeof m.incisionSegmentUV,'function');
  const cut=m.incisionSegmentUV([0,.5],[1,.5]);
  assert.equal(typeof m.sewPaths,'function');assert.equal(typeof m.unstitch,'function');
  for(let frame=0;frame<15;frame++)m.step(1/60);
  const seam=m.sewPaths(cut.pathA,cut.pathB);assert.equal(seam.ok,true);assert.ok(seam.pairs.length>=8);
  assert.equal(m.constraints.filter(c=>c.seamId===seam.seamId).length,seam.pairs.length);
  for(let frame=0;frame<50;frame++)m.step(1/60);
  const i=cut.pathA[4],j=cut.pathB[4];assert.ok(Math.hypot(...[0,1,2].map(k=>m.positions[i*3+k]-m.positions[j*3+k]))<.04);
  const before=m.constraints.length;const removed=m.unstitch(seam.seamId);assert.equal(removed.removed,seam.pairs.length);
  assert.equal(m.constraints.length,before-seam.pairs.length);
});

test('invalid seam paths refuse non-boundary jumps without changing structure', () => {
  const m=createPatch({cols:9,rows:9});assert.equal(typeof m.sewPaths,'function');
  const n=m.constraints.length;assert.equal(m.sewPaths([0,80],[8,72]).ok,false);assert.equal(m.constraints.length,n);
});
test('an interior diagonal slit retains both crack tips and exposes continuous sewable sides',()=>{
 const m=createPatch({cols:9,rows:9}),mass=m.mass,cut=m.incisionSegmentUV([.125,.125],[.875,.875]);assert.equal(cut.ok,true);assert.equal(cut.pathA[0],cut.pathB[0]);assert.equal(cut.pathA.at(-1),cut.pathB.at(-1));assert.ok(Math.abs(m.mass-mass)<1e-12);assert.equal(m.sewPaths(cut.pathA,cut.pathB).ok,true);
});
test('garment metadata roundtrips together with edited material-preserving topology',()=>{
 const m=createPatch({cols:9,rows:9});m.kind='stocking';m.garment={type:'single-leg-stocking',dimensions:{footLength:.22}};const saved=m.snapshot();assert.deepEqual(restoreModel(saved).garment,m.garment);
});
test('edited snapshots require complete stable-ID and original-vertex maps',()=>{
 const m=createPatch({cols:9,rows:9});m.incisionSegmentUV([0,.5],[1,.5]);for(const field of ['sourceVertices','vertexIds']){const saved=m.snapshot();delete saved[field];assert.throws(()=>restoreModel(saved),/快照/);}
});
