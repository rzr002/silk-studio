import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTube} from '../dist/physics.mjs';
import {createStocking} from '../dist/garment-geometry.mjs';
import {createKnit} from '../dist/knit.mjs';
import * as view from '../dist/scene.mjs';
import * as THREE from '../dist/vendor/three.module.js';

function renderHarness(){
  const scene=Object.create(view.PhysicsScene.prototype);let draws=0;
  Object.assign(scene,{scene:new THREE.Scene(),camera:new THREE.PerspectiveCamera(34,1,.01,20),target:new THREE.Vector3(0,.57,0),angle:.07,elevation:.07,distance:1.65,
    renderer:{render(){draws++;},setSize(){},domElement:{toDataURL(){return `png-after-${draws}-draws`;}}}});
  return {scene,draws:()=>draws};
}

test('stationary render requests preserve the canvas without repeated WebGL draws',()=>{
  const {scene,draws}=renderHarness();
  scene.render();for(let i=0;i<120;i++)scene.render();
  assert.equal(draws(),1,'a stationary scene should draw only once');
  assert.deepEqual(scene.renderStats,{requests:121,draws:1,skipped:120,dirty:false});
  assert.throws(()=>{scene.renderStats.draws=999;},TypeError,'diagnostic counts are read only');
});

test('direct public camera mutations cause a new draw and correct projection matrices',()=>{
  const {scene,draws}=renderHarness();scene.render();
  const mutations=[()=>scene.angle+=.2,()=>scene.elevation+=.03,()=>scene.distance-=.1,()=>scene.target.set(.1,.5,.05),()=>scene.target.x+=.03];
  for(const mutate of mutations){const before=draws();mutate();scene.render();assert.equal(draws(),before+1);scene.render();assert.equal(draws(),before+1);}
  assert.ok(Math.abs(scene.camera.position.x-(scene.target.x+Math.sin(scene.angle)*scene.distance))<1e-10);
});

test('display toggles and selection invalidate the next frame and capture flushes it',()=>{
  const {scene,draws}=renderHarness();scene.model=createTube({cols:8,rows:6});scene.kind='stocking';
  scene.wire=new THREE.Mesh();scene.body=new THREE.Mesh();scene.material=view.createFabricMaterial();scene.selection=new THREE.Mesh();scene.render();
  const mutations=[()=>scene.setWire(true),()=>scene.setStrain(true),()=>scene.setCollider(false),()=>scene.select(12)];
  assert.ok(scene.renderStats,'renderer exposes diagnostic counts');
  for(const mutate of mutations){const before=draws();mutate();assert.equal(scene.renderStats.dirty,true);scene.render();assert.equal(draws(),before+1);}
  assert.deepEqual(scene.selection.position.toArray(),scene.viewPoint(12),'selection marker moves without requiring a physics update');
  scene.setWire(false);const before=draws();assert.equal(scene.capture(),`png-after-${before+1}-draws`);assert.equal(scene.renderStats.dirty,false);
  scene.capture();assert.equal(draws(),before+1,'an unchanged capture can reuse the preserved canvas');
});

test('canonical geometry update, body pose and viewport resize each request a draw',()=>{
  const {scene,draws}=renderHarness(),model=createTube({cols:8,rows:6});
  Object.assign(scene,{model,kind:'stocking',materialProfile:{},overlay:new THREE.Group(),selection:new THREE.Mesh(),pinMesh:new THREE.InstancedMesh(new THREE.SphereGeometry(.004),new THREE.MeshBasicMaterial(),model.positions.length/3),container:{clientWidth:800,clientHeight:600}});
  scene.buildGeometry();scene.render();let before=draws();scene.render();assert.equal(draws(),before);
  model.positions[12]+=.01;scene.update();scene.render();assert.equal(draws(),before+1);scene.render();assert.equal(draws(),before+1);
  scene.body=new THREE.Mesh(new THREE.BufferGeometry());before=draws();scene.setPose(12);scene.render();assert.equal(draws(),before+1);scene.render();assert.equal(draws(),before+1);
  before=draws();scene.resize();scene.render();assert.equal(draws(),before+1);assert.equal(scene.camera.aspect,800/600);scene.render();assert.equal(draws(),before+1);
});

test('paused yarn strain toggles refresh per-vertex colors without a physics update',()=>{
  const {scene}=renderHarness(),model=createTube({cols:8,rows:6});
  for(let i=0;i<model.positions.length;i++)model.positions[i]*=1.3;
  Object.assign(scene,{model,kind:'knit',objectGroup:new THREE.Group(),region:{u0:.1,u1:.4,v0:.2,v1:.7}});
  scene.buildYarn(createKnit({cols:3,rows:3}));scene.setStrain(true);
  const colors=scene.yarn.geometry.attributes.color.array;
  assert.ok([...colors].some(value=>value<.9),'paused strain display must refresh yarn vertex colors immediately');
  scene.setStrain(false);assert.ok([...colors].every(value=>value===1),'disabling strain restores every yarn vertex color immediately');
});
test('periodic display seam duplicates UV without changing physical topology',()=>{
  assert.equal(typeof view.renderMeshData,'function');
  const model=createTube({cols:8,rows:6});
  const d=view.renderMeshData(model);
  assert.equal(d.vertexMap.length,model.positions.length/3+model.rows);
  for(let i=0;i<d.indices.length;i+=3){const u=d.indices.slice(i,i+3).map(n=>d.uv[n*2]);assert.ok(Math.max(...u)-Math.min(...u)<.2);}
  for(let i=0;i<d.vertexMap.length;i++)assert.deepEqual(d.positions.slice(i*3,i*3+3),[...model.positions.slice(d.vertexMap[i]*3,d.vertexMap[i]*3+3)]);
});

test('closed-foot stocking unwraps periodic display triangles at the longitudinal seam',()=>{
  const model=createStocking(),data=view.renderMeshData(model);
  for(let j=0;j<data.indices.length;j+=3){const u=data.indices.slice(j,j+3).map(i=>data.uv[i*2]);assert.ok(Math.max(...u)-Math.min(...u)<=.500001,'no long UV crossing triangle');}
  assert.equal(model.boundary.size,model.cols,'display UV duplication must not open the physical toe');
});

test('cut duplicates remain independent render vertices and do not depend on grid index arithmetic',()=>{
  const model=createStocking(),initialCount=model.positions.length/3,result=model.incisionSegmentUV([.1,.5],[.4,.5]);
  assert.equal(result.ok,true);
  assert.ok(model.positions.length/3>initialCount);
  const added=initialCount;model.positions[added*3+2]+=.03;
  const data=view.renderMeshData(model),copy=data.vertexMap.indexOf(added);
  assert.ok(copy>=0);
  assert.deepEqual(data.positions.slice(copy*3,copy*3+3),[...model.positions.slice(added*3,added*3+3)]);
  for(let j=0;j<data.indices.length;j+=3){const u=data.indices.slice(j,j+3).map(i=>data.uv[i*2]);assert.ok(Math.max(...u)-Math.min(...u)<=.500001);}
});

test('periodic surface sampling interpolates the last-to-first physical column',()=>{
  assert.equal(typeof view.sampleSurface,'function');
  const model=createTube({cols:8,rows:6}),result=view.sampleSurface(model,.99,.4);
  assert.equal(result.valid,true);
  const expected=model.positions[7*3]*.08+model.positions[0]*.92;
  assert.ok(Math.abs(result.point[0]-expected)<1e-10);
  assert.ok(result.point.every(Number.isFinite));
  assert.ok(result.normal.every(Number.isFinite));
});

test('UV chart positions preserve canonical vertex identity and source UV',()=>{
  const model=createStocking(),data=view.renderMeshData(model,{flat:true});
  assert.ok(data.positions.every(Number.isFinite));
  assert.ok(data.positions.filter((_,i)=>i%3===2).every(z=>z===0));
  for(let i=0;i<data.vertexMap.length;i++)assert.ok(Math.abs(data.positions[i*3]-(data.uv[i*2]-.5)*.62)<1e-10);
});

test('display optical attributes change with deformation instead of a fixed alpha',()=>{
  assert.equal(typeof view.renderOpticalData,'function');
  const model=createTube({cols:8,rows:6}),before=view.renderOpticalData(model).optical;
  for(let i=0;i<model.positions.length;i++)model.positions[i]*=2;
  const after=view.renderOpticalData(model).optical;
  assert.ok(after.opacity[12]<before.opacity[12]-.1);
  assert.ok(after.roughness[12]<before.roughness[12]);
});

test('physical fabric shader consumes optical opacity and roughness vertex attributes',()=>{
  assert.equal(typeof view.createFabricMaterial,'function');
  const material=view.createFabricMaterial({texture:null});
  const shader={uniforms:{},vertexShader:'#include <begin_vertex>',fragmentShader:'#include <color_fragment>\n#include <roughnessmap_fragment>'};
  material.onBeforeCompile(shader);
  assert.ok(shader.vertexShader.includes('attribute float opticalOpacity'));
  assert.ok(shader.fragmentShader.includes('vOpticalOpacity'));
  assert.ok(shader.fragmentShader.includes('vOpticalRoughness'));
  assert.equal(material.opacity,1);
});

test('duplicating the UV seam preserves smooth physical surface normals',()=>{
  const model=createStocking(),scene=Object.create(view.PhysicsScene.prototype);scene.model=model;scene.kind='stocking';
  const geometry=scene.buildGeometry(),normal=geometry.attributes.normal.array;
  const first=model.cols*20,copy=scene.vertexMap.indexOf(first,model.positions.length/3);
  assert.ok(copy>=0);
  for(let k=0;k<3;k++)assert.ok(Math.abs(normal[first*3+k]-normal[copy*3+k])<1e-6,'UV seam must not create a lighting crease');
});

test('all garment regions keep their optical mapping when the selected region changes',()=>{
  const model=createTube({cols:12,rows:12}),tuck=createKnit(),miss=createKnit();
  for(const node of [...tuck.nodes])tuck.setStitch(node.row,node.col,'tuck');
  for(const node of [...miss.nodes])miss.setStitch(node.row,node.col,'miss');
  const regions=[{bounds:{u0:.05,u1:.4,v0:.2,v1:.8},graph:tuck},{bounds:{u0:.6,u1:.95,v0:.2,v1:.8},graph:miss}];
  const a=view.renderOpticalData(model,{regions,graph:tuck,region:regions[0]}).optical,b=view.renderOpticalData(model,{regions,graph:miss,region:regions[1]}).optical;
  assert.deepEqual([...a.opacity],[...b.opacity],'selection must not change another region material response');
  const baseline=view.renderOpticalData(model).optical,left=5*model.cols+3,right=5*model.cols+9;
  assert.ok(a.opacity[left]>baseline.opacity[left]*1.1,'tuck remains denser in the left region');
  assert.ok(a.opacity[right]<baseline.opacity[right]*.9,'miss remains more open in the right region');
});
