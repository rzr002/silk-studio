import test from 'node:test';import assert from 'node:assert/strict';
import {createPatch,restoreModel} from '../dist/physics.mjs';
const api=await import('../dist/collision.mjs').catch(()=>({}));
function cloth(z=.001){return {positions:Float64Array.from([-1,-1,0,1,-1,0,0,1,0,0,0,z,3,3,.1,4,3,.1]),triangles:[0,1,2,3,4,5],active:new Uint8Array(6).fill(1),inverseMass:Float64Array.from([0,0,0,1,0,0]),pins:new Set([0,1,2,4,5])};}
function solve(m,options={}){assert.equal(typeof api.solveSelfCollision,'function');return api.solveSelfCollision(m,{thickness:.01,...options});}
test('nonadjacent vertex-triangle contact separates a near folded layer',()=>{const m=cloth();const r=solve(m);assert.ok(r.contacts>0);assert.ok(m.positions[11]>=.009999);assert.ok(r.candidates>0);});
test('incident and one-ring triangles do not self repel',()=>{const m=cloth();m.triangles=[0,1,3,1,2,3];const before=[...m.positions];const r=solve(m);assert.equal(r.contacts,0);assert.deepEqual([...m.positions],before);});
test('static endpoint mode reports that a fast crossing is missed',()=>{const m=cloth(-.3),previous=new Float64Array(m.positions);previous[11]=.3;const r=solve(m,{continuous:false,previousPositions:previous});assert.equal(r.continuousContacts,0);assert.equal(m.positions[11],-.3);});
test('segment against a stationary nonadjacent triangle catches a fast crossing',()=>{const m=cloth(-.3),previous=new Float64Array(m.positions);previous[11]=.3;const r=solve(m,{continuous:true,previousPositions:previous});assert.equal(r.continuousContacts,1);assert.ok(m.positions[11]>=.009999);assert.equal(r.continuousAlgorithm,'moving-vertex-static-triangle');});
test('continuous crossing wins over endpoint repulsion when the endpoint is just behind the surface',()=>{const m=cloth(-.001),previous=new Float64Array(m.positions);previous[11]=.3;const r=solve(m,{continuous:true,previousPositions:previous});assert.equal(r.continuousContacts,1);assert.ok(m.positions[11]>=.009999,'must preserve incoming side, not push deeper behind the triangle');});
test('moving triangle CCD is explicitly unsupported rather than reported as covered',()=>{const m=cloth(-.3),previous=new Float64Array(m.positions);previous[11]=.3;previous[2]=-.2;const r=solve(m,{continuous:true,previousPositions:previous});assert.ok(r.movingTrianglesSkipped>0);assert.equal(r.continuousContacts,0);});
test('inverse-mass reaction shares displacement with an unpinned target triangle',()=>{const m=cloth();m.pins.clear();m.inverseMass.fill(1);solve(m);assert.ok(m.positions[11]>.001);assert.ok(m.positions[2]<0||m.positions[5]<0||m.positions[8]<0);assert.ok(m.positions.every(Number.isFinite));});
test('cloth step executes enabled self contact and persists its explicit mode',()=>{
 const m=createPatch({cols:3,rows:3});m.positions.set(cloth().positions);m.rest.set(m.positions);m.triangles=[0,1,2,3,4,5];m.constraints=[];m.pins.clear();m.pinTargets.clear();m._rebuildTopology();for(const i of [0,1,2,4,5])m.pin(i,true);
 assert.equal(typeof m.setSelfCollision,'function');m.setSelfCollision({thickness:.01,continuous:false});m.step(1/60,{gravity:[0,0,0]});
 assert.ok(m.positions[11]>=.009999);assert.ok(m.stats().collision.contacts>0);assert.equal(restoreModel(m.snapshot()).selfCollision.thickness,.01);
});
test('body mesh segment contact blocks a fast moving cloth vertex against a static face',()=>{
 assert.equal(typeof api.solveMeshCollision,'function');const m=cloth(-.3),previous=new Float64Array(m.positions);previous[11]=.3;
 const mesh={positions:Float64Array.from([-1,-1,0,1,-1,0,0,1,0]),indices:[0,1,2]};
 const r=api.solveMeshCollision(m,mesh,{thickness:.01,continuous:true,previousPositions:previous});assert.ok(r.continuousContacts>0);assert.ok(m.positions[11]>=.009999);
});
test('cloth step collisionMesh option prevents endpoint tunnelling through a static body face',()=>{
 const m=createPatch({cols:4,rows:4});for(const i of [...m.pins])m.pin(i,false);for(let i=0;i<m.positions.length/3;i++){m.positions[i*3+2]=.3;m.velocities[i*3+2]=-50;}
 const mesh={positions:Float64Array.from([-2,-1,0,2,-1,0,0,3,0]),indices:[0,1,2]};
 m.step(1/60,{gravity:[0,0,0],collisionMesh:mesh,collisionThickness:.002,continuousCollision:true});
 for(let i=0;i<m.positions.length/3;i++)assert.ok(m.positions[i*3+2]>=.00199);assert.ok(m.stats().collision.continuousContacts>0);
});
test('surface contact resolves a face crossing a body even when every cloth vertex is clear',()=>{
 assert.equal(typeof api.solveSurfaceCollision,'function');
 const m={positions:Float64Array.from([-.2,-.1,.08,.2,-.1,.08,0,.2,.08]),triangles:[0,1,2],inverseMass:Float64Array.from([1,1,1]),pins:new Set()};
 const sphere=(x,y,z)=>{const len=Math.hypot(x,y,z);return len<.1-1e-10?[x*.1/len,y*.1/len,z*.1/len]:null;};
 for(let i=0;i<3;i++)assert.equal(sphere(...m.positions.slice(i*3,i*3+3)),null);
 const result=api.solveSurfaceCollision(m,sphere,{passes:2});assert.ok(result.contacts>0);const centroid=[0,1,2].map(k=>(m.positions[k]+m.positions[3+k]+m.positions[6+k])/3);assert.equal(sphere(...centroid),null);assert.equal(result.fullCCD,false);
});

test('a moving cloth face cannot cross a stationary body vertex between clear endpoints',()=>{
  assert.equal(typeof api.solveBodyVertexContacts,'function');
  const m={positions:Float64Array.from([-1,-1,-.2,1,-1,-.2,0,1,-.2]),triangles:[0,1,2],inverseMass:Float64Array.from([1,1,1]),pins:new Set()},previous=Float64Array.from([-1,-1,.2,1,-1,.2,0,1,.2]);
  const r=api.solveBodyVertexContacts(m,{positions:Float64Array.from([0,0,0])},{previousPositions:previous,thickness:.01,continuous:true});
  assert.equal(r.continuousContacts,1);
  const plane=(m.positions[2]+m.positions[5]+2*m.positions[8])/4;
  assert.ok(plane>=.009999,'triangle must remain on the incoming exterior side of the rigid point');
  assert.equal(r.edgeEdgeCCD,false);
});

test('body-vertex cloth-face contact supports relative motion and either incoming side',()=>{
  assert.equal(typeof api.solveBodyVertexContacts,'function');
  for(const side of [-1,1]){
    const m={positions:Float64Array.from([-1,-1,0,1,-1,0,0,1,0]),triangles:[0,1,2],inverseMass:Float64Array.from([1,1,1]),pins:new Set()};
    const r=api.solveBodyVertexContacts(m,{positions:Float64Array.from([0,0,.2*side]),previousPositions:Float64Array.from([0,0,-.2*side])},{previousPositions:Float64Array.from(m.positions),thickness:.01,continuous:true});
    assert.equal(r.continuousContacts,1);
    const plane=(m.positions[2]+m.positions[5]+2*m.positions[8])/4;
    assert.ok(side*plane>=.209999);
  }
});

test('self contact excludes nearby material neighbours on a finely tessellated flat patch',()=>{
  const m=createPatch({cols:8,rows:8,width:.01,height:.01}),before=[...m.positions];
  m.pins.clear();m.pinTargets.clear();
  const result=solve(m,{thickness:.003});
  assert.equal(result.contacts,0,'finite thickness must not inflate adjacent material merely because its grid is fine');
  assert.deepEqual([...m.positions],before);
});

test('continuous body-point mode can omit endpoint repulsion and only preserve actual crossings',()=>{
  const m={positions:Float64Array.from([-1,-1,.001,1,-1,.001,0,1,.001]),triangles:[0,1,2],inverseMass:Float64Array.from([1,1,1]),pins:new Set()},before=[...m.positions];
  const r=api.solveBodyVertexContacts(m,{positions:Float64Array.from([0,0,0])},{previousPositions:Float64Array.from(m.positions),thickness:.01,continuous:true,discrete:false});
  assert.equal(r.contacts,0);assert.deepEqual([...m.positions],before);
});
