import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../dist/edge-contact.mjs').catch(()=>({}));
const edge=(a,b)=>[a,b];
const a0=edge([-1,0,0],[1,0,0]),a1=edge([-1,0,0],[1,0,0]);
const b0=edge([0,-1,1],[0,1,1]),b1=edge([0,-1,-1],[0,1,-1]);
function ccd(a=a0,b=a1,c=b0,d=b1,options){assert.equal(typeof api.sweptEdgeEdge,'function');return api.sweptEdgeEdge(a,b,c,d,options);}
const near=(a,b,eps=1e-7)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
test('two linearly moving edges find the first genuine interior crossing',()=>{const r=ccd();assert.equal(r.hit,true);near(r.toi,.5);near(r.s,.5);near(r.t,.5);assert.ok(r.normal[2]<-.99,'normal points from incoming B toward A');assert.equal(r.status,'isolated-root');assert.equal(r.fullGuarantee,false);});
test('coplanarity outside the segments is rejected and endpoint contact is retained',()=>{const clear=ccd(a0,a1,edge([3,-1,1],[3,1,1]),edge([3,-1,-1],[3,1,-1]));assert.equal(clear.hit,false);const endpoint=ccd(a0,a1,edge([1,-1,1],[1,1,1]),edge([1,-1,-1],[1,1,-1]));assert.equal(endpoint.hit,true);near(endpoint.s,1);near(endpoint.toi,.5);});
test('repeated-root tangency is found without requiring a polynomial sign change',()=>{const r=ccd(a0,a1,edge([0,-1,-.5],[0,.5,.5]),edge([0,-1,.5],[0,1.5,-.5]));assert.equal(r.hit,true);near(r.toi,.5,1e-5);assert.equal(r.tangential,true);});
test('persistent coplanarity and parallel degeneracy are explicitly unsupported',()=>{const r=ccd(a0,a1,edge([0,-1,0],[0,1,0]),edge([0,-1,0],[0,1,0]));assert.equal(r.hit,false);assert.equal(r.status,'unsupported-coplanar');assert.equal(r.coplanarCovered,false);const p=ccd(a0,a1,edge([-1,0,1],[1,0,1]),edge([-1,0,-1],[1,0,-1]));assert.equal(p.status,'unsupported-coplanar');assert.ok(p.parallel);});
function bodyCase(){return {model:{positions:Float64Array.from([0,-1,-1,0,1,-1,2,0,-1]),triangles:[0,1,2],inverseMass:Float64Array.of(1,3,1),active:Uint8Array.of(1,1,1),pins:new Set(),grabbed:null},previous:Float64Array.from([0,-1,1,0,1,1,2,0,1]),body:{positions:Float64Array.from([-1,0,0,1,0,0,0,-3,0]),indices:Uint32Array.from([0,1,2]),revision:1}};}
test('body-edge crossing applies incoming-side barycentric inverse-mass correction with fixed body',()=>{assert.equal(typeof api.solveEdgeContact,'function');const {model,previous,body}=bodyCase(),beforeBody=[...body.positions],r=api.solveEdgeContact(model,{previousPositions:previous,bodyMesh:body,previousBodyPositions:body.positions,thickness:.001,continuous:true,self:false});assert.ok(r.continuousContacts>0);assert.ok(model.positions[2]>-1);assert.ok(model.positions[5]>model.positions[2],'higher inverse mass receives greater correction');assert.deepEqual([...body.positions],beforeBody);assert.equal(r.edgeEdgeCCD,true);assert.equal(r.coplanarCovered,false);assert.equal(r.fullGuarantee,false);});
test('kinematic cloth edges are reported as conflicts rather than moving anchors',()=>{const {model,previous,body}=bodyCase();model.pins=new Set([0,1,2]);const before=[...model.positions],r=api.solveEdgeContact(model,{previousPositions:previous,bodyMesh:body,self:false});assert.deepEqual([...model.positions],before);assert.ok(r.kinematicConflicts>0);});
test('self broadphase excludes shared endpoints and one-ring neighbors',()=>{const positions=Float64Array.from([0,0,0,1,0,0,0,1,0,1,1,0]),model={positions,triangles:[0,1,2,1,3,2],inverseMass:Float64Array.of(1,1,1,1),pins:new Set(),active:Uint8Array.of(1,1,1,1)};const r=api.solveEdgeContact(model,{previousPositions:Float64Array.from(positions),self:true});assert.equal(r.candidates,0);assert.ok(r.excludedPairs>0);});
test('swept spatial hash catches the crossing but does not test distant edge neighborhoods',()=>{const {model,previous,body}=bodyCase();const old=[...body.positions],ids=[...body.indices];for(let i=0;i<20;i++){const offset=old.length/3;old.push(50+i,0,0,50+i,1,0,51+i,0,0);ids.push(offset,offset+1,offset+2);}body.positions=Float64Array.from(old);body.indices=Uint32Array.from(ids);const r=api.solveEdgeContact(model,{previousPositions:previous,bodyMesh:body,cellSize:.2,self:false});assert.ok(r.contacts>0);assert.ok(r.candidates<3*63);assert.equal(r.broadphaseOverflow,false);});
test('invalid arrays and candidate limits are bounded and explicit',()=>{assert.throws(()=>ccd(edge([NaN,0,0],[1,0,0])));const {model,previous,body}=bodyCase();assert.throws(()=>api.solveEdgeContact(model,{previousPositions:previous.slice(0,3),bodyMesh:body}));const r=api.solveEdgeContact(model,{previousPositions:previous,bodyMesh:body,maxCandidates:1});assert.equal(r.broadphaseOverflow,true);assert.equal(r.fullGuarantee,false);});
test('multiple isolated roots return the first segment crossing and skip an earlier off-segment root',()=>{
  const both=ccd(a0,a1,edge([0,-1,-.25],[0,.5,.3125]),edge([0,-1,.75],[0,1.5,-.9375]));near(both.toi,.25);
  const later=ccd(a0,a1,edge([0,-1,-.25],[0,-.5,.0625]),edge([0,-1,.75],[0,.5,-.1875]));near(later.toi,.75);
});
test('incoming normal follows local TOI geometry when frame-start endpoint orientation is opposite',()=>{
  const ap=[[-.07966842874884605,-1.1470912816002965,-1.1712338421493769],[.9331681998446584,-1.2578816786408424,1.4431322431191802]],ac=[[-1.3587501551955938,-.657805054448545,-.0139840729534626],[.10523902904242277,1.9390887301415205,-1.3871892942115664]],bp=[[1.6843243837356567,.9891094854101539,-1.5895257722586393],[-.4417969202622771,-1.0744276754558086,1.2177838115021586]],bc=[[.5431125219911337,1.3149391831830144,-1.9118404015898705],[-1.2001844877377152,-.1401797290891409,.280709789134562]],r=ccd(ap,ac,bp,bc);
  near(r.toi,.70487089574317,1e-8);assert.ok(r.normal[0]>.79&&r.normal[1]<-.56);
  assert.ok(ap[0].reduce((sum,v,k)=>sum+(v-bp[0][k])*r.normal[k],0)<0,'a frame-start endpoint would choose the wrong sign');
});
test('isolated crossing is translation and scale invariant across ordinary numerical ranges',()=>{
  for(const scale of [1e-6,1,1e6]){const transform=e=>e.map(p=>p.map(x=>x*scale+12*scale)),r=ccd(transform(a0),transform(a1),transform(b0),transform(b1));assert.equal(r.hit,true);near(r.toi,.5);assert.ok(r.normal[2]<-.99);}
  const translate=e=>e.map(p=>p.map(x=>x+1e6));near(ccd(translate(a0),translate(a1),translate(b0),translate(b1)).toi,.5);
});
test('existing intersection has no invented incoming side',()=>{const r=ccd(a0,a1,edge([0,-1,0],[0,1,0]),b1);assert.equal(r.hit,false);assert.equal(r.status,'initial-intersection');near(r.toi,0);});
test('self response moves disjoint dynamic edges with equal and opposite total displacement',()=>{
  const positions=Float64Array.from([-1,0,0,1,0,0,0,-3,0,0,-1,-1,0,1,-1,2,0,-1]),previous=Float64Array.from(positions);for(let i=3;i<6;i++)previous[i*3+2]=1;
  const model={positions,triangles:[0,1,2,3,4,5],inverseMass:Float64Array.from({length:6},()=>1),pins:new Set()},before=[0,1,2].map(k=>positions.reduce((sum,v,i)=>sum+(i%3===k?v:0),0));
  const r=api.solveEdgeContact(model,{previousPositions:previous,self:true});assert.ok(r.contacts>0);
  for(let k=0;k<3;k++)near(positions.reduce((sum,v,i)=>sum+(i%3===k?v:0),0),before[k]);
});
test('body swept hash reuses within a revision and invalidates when in-place coordinates receive a new revision',()=>{
  const {model,previous,body}=bodyCase(),initial=Float64Array.from(model.positions),call=()=>{model.positions.set(initial);return api.solveEdgeContact(model,{previousPositions:previous,bodyMesh:body,cellSize:.2});};
  assert.equal(call().bodyHashReused,false);assert.equal(call().bodyHashReused,true);
  for(let i=0;i<body.positions.length;i+=3)body.positions[i]+=100;body.revision++;
  const moved=call();assert.equal(moved.bodyHashReused,false);assert.equal(moved.candidates,0);
  for(let i=0;i<body.positions.length;i+=3)body.positions[i]-=100;body.revision++;
  assert.ok(call().continuousContacts>0);
});
test('swept hash overflow remains explicit even when its fallback still finds a crossing',()=>{
  const {model,previous,body}=bodyCase(),r=api.solveEdgeContact(model,{previousPositions:previous,bodyMesh:body,cellSize:.001});assert.equal(r.broadphaseOverflow,true);assert.ok(r.continuousContacts>0);assert.equal(r.fullGuarantee,false);
});
test('grabbed endpoints stay fixed and unsupported modes or malformed body data never silently mutate cloth',()=>{
  const {model,previous,body}=bodyCase();model.grabbed={index:0,target:[0,-1,-1]};api.solveEdgeContact(model,{previousPositions:previous,bodyMesh:body});near(model.positions[2],-1);
  const before=[...model.positions];assert.throws(()=>api.solveEdgeContact(model,{previousPositions:previous,bodyMesh:body,continuous:'true'}));assert.deepEqual([...model.positions],before);
  assert.throws(()=>api.solveEdgeContact(model,{previousPositions:previous,bodyMesh:body,previousBodyPositions:Float64Array.of(0,0,0)}));assert.deepEqual([...model.positions],before);
  const r=api.solveEdgeContact(model,{previousPositions:previous,bodyMesh:body,continuous:false,discrete:true});assert.equal(r.discreteCovered,false);assert.equal(r.discreteUnsupported,true);assert.equal(r.contacts,0);
});
test('zero-length edges report degeneracy instead of inventing a collision normal',()=>{
  const p=edge([0,0,0],[0,0,0]),r=ccd(p,p,b0,b1);assert.equal(r.hit,false);assert.equal(r.status,'unsupported-degenerate');assert.equal(r.normal,undefined);
});
test('endpoint-plane response explicitly remains unvalidated over the whole corrected trajectory',()=>{
  const {model,previous,body}=bodyCase(),r=api.solveEdgeContact(model,{previousPositions:previous,bodyMesh:body});assert.equal(r.trajectoryValidated,false);assert.equal(r.response,'incoming-toi-plane-projection');assert.equal(r.alreadyOnIncomingSide,r.unresolvedTemporalContacts);
});
