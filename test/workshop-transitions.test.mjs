import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../dist/vendor/three.module.js';
import {WorkshopScene} from '../dist/workshop-scene.mjs';
import {createStocking,DEFAULT_BODY_DIMENSIONS} from '../dist/garment-geometry.mjs';

// Exercise the actual setWorkshop and buildBlank implementations without a
// WebGL context. Renderer/camera framing are outside these mesh-lifetime tests.
function fixture({stage='finish',camera=false}={}){
  const scene=Object.create(WorkshopScene.prototype),model=createStocking();
  const state={id:'travel-fixture',revision:0,name:'piece',events:[],stage,recipe:{yarnId:'nylon-fine',loopLengthMm:3,program:{cols:40,rows:48,cells:Array(1920).fill('knit')}},threading:{mounted:false,path:[]},sample:{courses:0,pull:0,trials:[]},production:{producedCourses:48,totalCourses:48,running:false,courses:[]},seam:{alignment:0,feed:stage==='seam'?.9:1,closed:stage!=='seam'},finish:{color:'#594844',dyeProgress:stage==='seam'?0:.25,boarded:false,smoothedZones:[]},wear:{dressed:false,pose:0}};
  const materials=Array.from({length:5},()=>new THREE.MeshPhysicalMaterial());
  Object.assign(scene,{scene:new THREE.Group(),objects:new Map(),sharedMaterials:new Set(materials),parts:Object.fromEntries(['spool','thread','sample','blank'].map(key=>[key,new THREE.Group()])),yarnMaterial:materials[0],blankYarnMaterial:materials[1],fabricMaterial:materials[2],sampleMaterial:materials[3],linkMaterial:materials[4],spindle:new THREE.Group(),sampleAnchor:new THREE.Group(),seamJaws:[new THREE.Group(),new THREE.Group()],liquid:{material:new THREE.MeshStandardMaterial()},smoothObjects:new Map(),needles:new THREE.InstancedMesh(new THREE.BoxGeometry(),materials[0],40),needleHooks:new THREE.InstancedMesh(new THREE.BoxGeometry(),materials[0],40),renderer:{shadowMap:{}},bodyKey:JSON.stringify([0,DEFAULT_BODY_DIMENSIONS]),applyStationVisibility(){}});
  scene.fabricMaterial.userData.revealUniform={value:-1};
  if(camera){
    const rect={left:0,top:0,right:1000,bottom:600,width:1000,height:600};
    Object.assign(scene,{container:{clientWidth:1000,clientHeight:600,parentElement:{querySelector:()=>null}},camera:new THREE.PerspectiveCamera(35,1000/600,.05,15),target:new THREE.Vector3(.38,.87,.49),station:stage,manualCamera:false,angle:.22,distance:1.5,elevation:.52});
    scene.renderer.domElement={getBoundingClientRect:()=>rect};
    for(const part of Object.values(scene.parts))scene.scene.add(part);
    for(const [id,position]of [['toe-left',[.347,.98,.49]],['toe-right',[.413,.98,.49]],['sewing-pedal',[.42,.72,.53]]]){const object=new THREE.Group();object.position.fromArray(position);scene.scene.add(object);scene.register(id,'seam',object);}
  }
  scene.setWorkshop({session:state,model});
  const blank=scene.objects.get('blank').object,target={position:blank.position.clone(),quaternion:blank.quaternion.clone()},from={position:new THREE.Vector3(.26,1.047,.56),quaternion:new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI)};
  blank.position.lerpVectors(from.position,target.position,.35);blank.quaternion.slerpQuaternions(from.quaternion,target.quaternion,.35);
  scene._blankTravel={object:blank,from,to:target,startMs:100};
  function dispose(){const geometries=new Set(),allMaterials=new Set(materials);for(const object of [...Object.values(scene.parts),scene.needles,scene.needleHooks])object.traverse(child=>{if(child.geometry)geometries.add(child.geometry);if(child.material)allMaterials.add(child.material);});allMaterials.add(scene.liquid.material);for(const geometry of geometries)geometry.dispose();for(const material of allMaterials)material.dispose();}
  return {scene,model,state,blank,target,from,dispose};
}

test('a source update that reuses the blank keeps its original travel destination and clock',()=>{
  const {scene,model,state,blank,target,from,dispose}=fixture();
  try{
    const destination=target.position.toArray(),next={...state,revision:1,name:'renamed during travel'};
    scene.setWorkshop({session:next,model});
    assert.equal(scene.objects.get('blank').object,blank,'renaming/source refresh does not rebuild the garment');
    assert.equal(scene._blankTravel.object,blank);
    assert.deepEqual(scene._blankTravel.to.position.toArray(),destination,'the current interpolated position must not replace the destination');
    assert.deepEqual(scene._blankTravel.from.position.toArray(),from.position.toArray());
    assert.equal(scene._blankTravel.startMs,100);
  }finally{dispose();}
});

test('an explicit station change preserves the current camera until its real camera tween starts',()=>{
  const {scene,model,state,dispose}=fixture({stage:'seam',camera:true});
  try{
    const before=scene.cameraFrame(),next={...state,revision:1,stage:'finish',seam:{...state.seam,feed:1,closed:true}};
    scene.setWorkshop({session:next,model,fitCamera:false});
    assert.deepEqual(scene.cameraFrame(),before,'source replacement must not first snap to a reframed previous station');
    scene.setStation('finish');
    assert.deepEqual(scene._cameraTween.from,before,'the 560ms transition starts at the actually displayed camera');
    assert.notDeepEqual(scene._cameraTween.to,before,'the requested finish station still receives a new framing target');
  }finally{dispose();}
});

test('ordinary source updates retain default automatic camera framing',()=>{
  const {scene,model,state,dispose}=fixture({stage:'seam',camera:true});
  try{
    const before=scene.cameraFrame(),next={...state,revision:1,stage:'finish',seam:{...state.seam,feed:1,closed:true}};
    scene.setWorkshop({session:next,model});
    assert.notDeepEqual(scene.cameraFrame(),before,'default fitCamera keeps existing auto-fit behavior for callers without a following station change');
    assert.equal(scene._cameraTween,undefined);
  }finally{dispose();}
});

test('a real blank rebuild rebinds ongoing travel to the new mesh and target while retaining its clock',()=>{
  const {scene,model,state,blank,from,dispose}=fixture();
  try{
    const next={...state,revision:1,finish:{...state.finish,dyeProgress:.50}};
    scene.setWorkshop({session:next,model});
    const rebuilt=scene.objects.get('blank').object;
    assert.notEqual(rebuilt,blank,'dye processing rebuilds the canonical display mesh');
    assert.equal(scene._blankTravel.object,rebuilt,'the animation must never retain a disposed old mesh');
    assert.ok(scene._blankTravel.to.position.distanceTo(new THREE.Vector3(.60,-.0275,.59))<1e-12,'target follows the new dye placement');
    assert.deepEqual(scene._blankTravel.to.quaternion.toArray(),rebuilt.quaternion.toArray());
    assert.deepEqual(scene._blankTravel.from.position.toArray(),from.position.toArray());
    assert.equal(scene._blankTravel.startMs,100,'mesh replacement does not restart the travel');
  }finally{dispose();}
});
