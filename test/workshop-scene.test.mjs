import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStocking} from '../dist/garment-geometry.mjs';
import * as THREE from '../dist/vendor/three.module.js';
const api=await import('../dist/workshop-scene.mjs').catch(()=>({}));
const model=createStocking();
const build=(options={})=>{assert.equal(typeof api.buildCourseBlank,'function');return api.buildCourseBlank(model,{totalCourses:48,producedCourses:0,toeClosed:false,...options});};
function boundary(data){const edges=new Map();for(let j=0;j<data.indices.length;j+=3){const f=data.indices.slice(j,j+3);for(let k=0;k<3;k++){const a=f[k],b=f[(k+1)%3],key=a<b?`${a},${b}`:`${b},${a}`;edges.set(key,(edges.get(key)||0)+1);}}return [...edges].filter(([,n])=>n===1).map(([key])=>key.split(',').map(Number));}
test('zero production has no stocking vertices, faces or feed-front yarn',()=>{
  const data=build();assert.deepEqual(data.positions,[]);assert.deepEqual(data.indices,[]);assert.deepEqual(data.frontier.positions,[]);assert.equal(data.frontierV,null);
});
test('first course is only one cuff yarn ring, with no fabric faces',()=>{
  const data=build({producedCourses:1});assert.equal(data.positions.length/3,model.cols);assert.equal(data.indices.length,0);assert.equal(data.frontier.positions.length,model.cols);assert.equal(data.frontierV,1);assert.ok(data.uv.filter((_,i)=>i%2).every(v=>v===1));
});
test('each produced course adds actual fabric and frontier interpolates between canonical rows',()=>{
  const a=build({producedCourses:2,totalCourses:94}),b=build({producedCourses:3,totalCourses:94});
  assert.ok(a.indices.length>0);assert.ok(b.indices.length>a.indices.length);assert.ok(Math.abs(a.frontierV-(1-1/93))<1e-12);assert.ok(a.uv.filter((_,i)=>i%2).every(v=>v>=a.frontierV-1e-12));
  assert.ok(a.sourceRefs.some(ref=>ref.ids.length===2),'an intermediate course uses real canonical edge interpolation');
  assert.ok(a.positions.every(Number.isFinite));assert.ok(a.frontier.positions.flat().every(Number.isFinite));
});
test('full unfinished blank has two open boundaries and no toe cap auxiliary particles',()=>{
  const data=build({producedCourses:48});assert.equal(data.capFaces,0);assert.equal(boundary(data).length,model.cols*2);assert.ok(data.sourceRefs.every(ref=>ref.ids.every(i=>i<model.gridVertexCount)));
});
test('sealing adds exactly the declared canonical cap and leaves only the cuff open',()=>{
  const data=build({producedCourses:48,toeClosed:true});assert.equal(data.capFaces,160);assert.equal(boundary(data).length,model.cols);assert.equal(data.positions.length,model.rest.length);assert.deepEqual(data.indices,model.triangles);
  for(let i=0;i<data.sourceRefs.length;i++){const ref=data.sourceRefs[i];assert.deepEqual(ref.weights,[1]);assert.deepEqual(data.positions.slice(i*3,i*3+3),[...model.rest.slice(ref.ids[0]*3,ref.ids[0]*3+3)]);}
});
test('finished display can use accepted canonical positions without changing the source model',()=>{
  const before=model.snapshot(),changed=createStocking();changed.positions[0]+=.025;
  const data=api.buildCourseBlank(changed,{producedCourses:48,totalCourses:48,toeClosed:true,useCurrentPositions:true}),index=data.sourceRefs.findIndex(ref=>ref.ids.length===1&&ref.ids[0]===0);
  assert.equal(data.positions[index*3],changed.positions[0]);assert.deepEqual(model.snapshot(),before);
});
test('unwoven closures and invalid course counters are rejected',()=>{
  for(const options of [{producedCourses:10,toeClosed:true},{producedCourses:-1},{producedCourses:49},{producedCourses:1.5},{totalCourses:1},{totalCourses:NaN}])assert.throws(()=>build(options),/course|closure|production/i);
});
test('render scene exposes disposal and canvas-local object projection without importing a domain session',()=>{
  assert.equal(typeof api.WorkshopScene,'function');for(const method of ['setWorkshop','render','capture','resize','dispose','projectObject'])assert.equal(typeof api.WorkshopScene.prototype[method],'function');
});
test('dye processing changes only the garment color, not unprocessed spool or sample yarn',()=>{
  assert.equal(typeof api.workshopColors,'function');
  const state={recipe:{yarnId:'nylon-fine'},finish:{color:'#45384a',dyeProgress:0}},before=api.workshopColors(state);
  state.finish.dyeProgress=1;const after=api.workshopColors(state);
  assert.equal(before.yarn,after.yarn);assert.notEqual(before.blank,after.blank);assert.equal(after.blank,'#45384a');
});
test('woven organization reads immutable production cells before the unworked recipe',()=>{
  assert.equal(typeof api.workshopOrganization,'function');const cells=Array(1920).fill('miss'),state={recipe:{program:{cols:40,rows:48,cells}},production:{courses:[{row:0,cells:Array(40).fill('tuck')}]}};
  const organization=api.workshopOrganization(model,state);assert.equal(organization[47*40+5],'tuck');assert.equal(organization[46*40+5],'miss');
});
test('sample pulling visibly extends width and old trial geometry retains its own pull and loop length',()=>{
  assert.equal(typeof api.sampleLayout,'function');const natural=api.sampleLayout({courses:8,pull:0,loopLengthMm:3}),pulled=api.sampleLayout({courses:8,pull:.5,loopLengthMm:3});
  assert.ok(Math.abs(pulled.width/natural.width-1.5)<1e-12);assert.equal(pulled.height,natural.height);const archived=api.sampleLayout({courses:8,pull:.2,loopLengthMm:4});assert.ok(archived.height>natural.height);assert.ok(archived.width<pulled.width);
});
test('active circular yarn path gives misses floats and tucks visibly longer held loops',()=>{
  assert.equal(typeof api.buildCourseYarn,'function');const blank=build({producedCourses:2}),knit=api.buildCourseYarn(blank,Array(40).fill('knit')),miss=api.buildCourseYarn(blank,Array(40).fill('miss')),tuck=api.buildCourseYarn(blank,Array(40).fill('tuck'));
  assert.ok(knit.points.length>miss.points.length);assert.ok(tuck.yarnLength>knit.yarnLength);assert.ok(tuck.points.flat().every(Number.isFinite));assert.equal(miss.stitches.miss,40);
});
test('station framing keeps all guide handles inside a narrow canvas above its task card',()=>{
  assert.equal(typeof api.frameStationPoints,'function');const points=[[-.82,.94,-.19],[-.70,1.04,.16],[-.66,1.17,.06],[-.47,1.26,-.05],[-.10,1.14,.08]],width=390,height=480;
  const frame=api.frameStationPoints(points,{width,height,top:65,bottom:125}),camera=new THREE.PerspectiveCamera(35,width/height,.05,15),target=new THREE.Vector3(...frame.target);
  camera.position.set(target.x+Math.sin(frame.angle)*frame.distance,target.y+frame.elevation,target.z+Math.cos(frame.angle)*frame.distance);camera.lookAt(target);camera.setViewOffset(width,height,0,frame.offsetY,width,height);camera.updateMatrixWorld();
  for(const point of points){const p=new THREE.Vector3(...point).project(camera),x=(p.x+1)*width/2,y=(1-p.y)*height/2;assert.ok(x>=24&&x<=width-24);assert.ok(y>=65&&y<=height-125);}
});
test('misaligned seam feedback distorts only the toe and unpicking restores its source shape',()=>{
  assert.equal(typeof api.processDisplayPositions,'function');const data=build({producedCourses:48}),original=[...data.positions],state={stage:'seam',seam:{alignment:.7,feed:.8},finish:{boarded:false}};
  const distorted=api.processDisplayPositions(data,state);assert.notDeepEqual(distorted,original);
  for(let i=0;i<data.uv.length/2;i++)if(data.uv[i*2+1]>.1)assert.deepEqual(distorted.slice(i*3,i*3+3),original.slice(i*3,i*3+3));
  state.seam.feed=0;assert.deepEqual(api.processDisplayPositions(data,state),original);assert.deepEqual(data.positions,original);
});
test('each smoothing operation removes only its own displayed wrinkles without rewriting canonical geometry',()=>{
  assert.equal(typeof api.processDisplayPositions,'function');const data=build({producedCourses:48,toeClosed:true}),state={stage:'finish',seam:{alignment:0,feed:1},finish:{boarded:true,smoothedZones:[]}};
  const wrinkled=api.processDisplayPositions(data,state);assert.notDeepEqual(wrinkled,data.positions);
  for(const zone of ['cuff','leg','foot']){state.finish.smoothedZones=[zone];const smoothed=api.processDisplayPositions(data,state);let changed=0;for(let i=0;i<data.uv.length/2;i++){const v=data.uv[i*2+1],region=v>.93?'cuff':v<.31?'foot':'leg';if(region===zone){assert.deepEqual(smoothed.slice(i*3,i*3+3),data.positions.slice(i*3,i*3+3));changed++;}else assert.deepEqual(smoothed.slice(i*3,i*3+3),wrinkled.slice(i*3,i*3+3));}assert.ok(changed>0);}
});
test('a dragged grip follows the pointer in world space while source object and buffers remain intact',()=>{
  assert.equal(typeof api.WorkshopScene.prototype.beginGrip,'function');const scene=Object.create(api.WorkshopScene.prototype),group=new THREE.Group(),source=new THREE.Mesh(new THREE.BoxGeometry(.1,.2,.1),new THREE.MeshStandardMaterial());source.position.set(-.7,1,.2);group.add(source);group.updateMatrixWorld(true);let sourceDisposed=0;source.geometry.addEventListener('dispose',()=>sourceDisposed++);
  Object.assign(scene,{scene:group,objects:new Map([['yarn-test',{object:source}]]),gripMaterial:new THREE.MeshBasicMaterial(),sharedMaterials:new Set()});scene.sharedMaterials.add(scene.gripMaterial);
  scene.beginGrip({objectId:'yarn-test',point:[-.7,1,.2]});scene.followGrip([-.4,1.1,.25]);assert.deepEqual(source.position.toArray(),[-.7,1,.2]);assert.ok(Math.abs(scene.grip.clone.position.x+.4)<1e-12);assert.notEqual(scene.grip.clone.geometry,source.geometry);scene.endGrip();assert.equal(sourceDisposed,0);assert.equal(scene.grip,null);
});
