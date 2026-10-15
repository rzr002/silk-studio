import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../dist/vendor/three.module.js';
const api=await import('../dist/workshop-props.mjs').catch(()=>({}));
function create(options){assert.equal(typeof api.createWorkshopProps,'function');return api.createWorkshopProps(options);}
test('workshop props build independently in Node with inspectable mechanisms and procedural material maps',()=>{
  const props=create();assert.ok(props.group.isGroup);
  props.group.updateMatrixWorld(true);props.group.traverse(object=>assert.ok(object.matrixWorld.elements.every(Number.isFinite),`finite transform for ${object.name}`));
  for(const [section,parts]of Object.entries({machine:['root','driveGear','pulley','rollers','cam','feeder'],seam:['root','needle','presser','feedWheel'],vat:['root','surface','ripple','steam','gauge'],room:['root','workLamp','wearBackdrop']}))for(const name of parts)assert.ok(props.refs[section][name],`${section}.${name}`);
  assert.deepEqual(props.refs.machine.root.position.toArray(),[-.12,.98,.16]);assert.deepEqual(props.refs.seam.root.position.toArray(),[.38,.98,.49]);
  const maps=new Set();props.group.traverse(object=>{for(const material of [].concat(object.material||[]))if(material.map)maps.add(material.map);});assert.ok(maps.size>=3);assert.ok([...maps].every(map=>map.isDataTexture));assert.ok(props.refs.tools.children.length>=6);props.dispose();
});
test('repeated screws, scale ticks and stored yarn use instancing with a bounded render budget',()=>{
  const props=create(),instances=[];props.group.traverse(object=>{if(object.isInstancedMesh)instances.push(object);});
  assert.ok(instances.some(object=>/fastener/i.test(object.name)&&object.count>=32));assert.ok(instances.some(object=>/scale/i.test(object.name)&&object.count>=24));assert.ok(instances.some(object=>/yarn/i.test(object.name)&&object.count>=12));
  assert.ok(props.stats.drawCalls<165,`${props.stats.drawCalls} draw calls`);assert.ok(props.stats.triangles<65000,`${props.stats.triangles} triangles`);assert.ok(props.stats.instances>=100);props.dispose();
});
test('opaque decoration leaves the spindle, guides, wheel and toe jaws visible from the working side',()=>{
  const props=create();props.group.updateMatrixWorld(true);
  const targets=[[-.70,1.04,.16],[-.643,1.17,.06],[-.453,1.26,-.05],[-.083,1.14,.08],[-.40,.925,.395],[.347,.98,.49],[.413,.98,.49]];
  const meshes=[];props.group.traverse(object=>{let shown=true;for(let p=object;p;p=p.parent)shown&&=p.visible;if(shown&&object.isMesh&&!object.material.transparent)meshes.push(object);});
  for(const point of targets){const target=new THREE.Vector3(...point),origin=target.clone().add(new THREE.Vector3(.25,.7,2)),ray=new THREE.Raycaster(origin,target.clone().sub(origin).normalize(),0,origin.distanceTo(target)-.012);assert.equal(ray.intersectObjects(meshes,false).length,0,`decoration obscures ${point}`);}props.dispose();
});
test('wear station removes working clutter while retaining its separate display backdrop and light',()=>{
  const props=create();assert.equal(props.setStation('wear'),true);for(const section of ['machine','seam','vat'])assert.equal(props.refs[section].root.visible,false);assert.equal(props.refs.tools.visible,false);assert.equal(props.refs.room.root.visible,false);assert.equal(props.refs.room.wearBackdrop.visible,true);assert.equal(props.refs.room.workLamp.visible,false);assert.equal(props.setStation('wear'),false);props.setStation('yarn');assert.equal(props.refs.machine.root.visible,true);assert.equal(props.refs.room.root.visible,true);assert.equal(props.refs.room.wearBackdrop.visible,false);props.dispose();
});
test('motion drives preallocated mechanisms, liquid and steam without changing channel data or resource ownership',()=>{
  const props=create(),channels={wheelAngle:.7,spindleAngle:.4,feedPhase:.3,sewingNeedle:.8,sewingWheel:.9,dyeRipple:.7,dyeMix:.5,steam:.8,heatGlow:.4},before=structuredClone(channels),steamGeometry=props.refs.vat.steam.geometry,positions=steamGeometry.attributes.position.array,rippleMaterial=props.refs.vat.ripple.material,initial=[...positions];
  assert.equal(props.applyMotion(channels,1),true);assert.notEqual(props.refs.machine.driveGear.rotation.z,0);assert.notEqual(props.refs.seam.needle.position.y,props.refs.seam.needle.userData.restY);assert.ok(props.refs.vat.steam.visible);assert.ok(props.refs.vat.steam.material.opacity>0);assert.notDeepEqual([...positions],initial);
  assert.equal(props.applyMotion(channels,1.1),true);assert.equal(props.refs.vat.steam.geometry,steamGeometry);assert.equal(props.refs.vat.steam.geometry.attributes.position.array,positions);assert.equal(props.refs.vat.ripple.material,rippleMaterial);assert.deepEqual(channels,before);props.dispose();
});
test('idle motion stops updating when only wall time changes and rejects nonfinite inputs atomically',()=>{
  const props=create();props.applyMotion({},0);assert.equal(props.applyMotion({},20),false);assert.equal(props.refs.vat.steam.visible,false);assert.equal(props.refs.vat.ripple.visible,false);
  props.applyMotion({wheelAngle:1},20);const angle=props.refs.machine.driveGear.rotation.z;assert.throws(()=>props.applyMotion({wheelAngle:2,steam:NaN},21),/finite/i);assert.equal(props.refs.machine.driveGear.rotation.z,angle);assert.throws(()=>props.applyMotion({},Infinity),/finite/i);props.dispose();
});
test('disposing owns each internal resource once and never releases caller material or texture',()=>{
  const externalTexture=new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1),externalMaterial=new THREE.MeshStandardMaterial({map:externalTexture}),props=create({materials:{steel:externalMaterial}}),parent=new THREE.Group();parent.add(props.group);
  const resources=new Set([externalMaterial,externalTexture]),counts=new Map();props.group.traverse(object=>{if(object.geometry)resources.add(object.geometry);for(const material of [].concat(object.material||[])){resources.add(material);for(const key of ['map','bumpMap','roughnessMap','alphaMap'])if(material[key])resources.add(material[key]);}});for(const resource of resources){counts.set(resource,0);resource.addEventListener('dispose',()=>counts.set(resource,counts.get(resource)+1));}
  props.dispose();props.dispose();assert.equal(props.group.parent,null);assert.equal(counts.get(externalMaterial),0);assert.equal(counts.get(externalTexture),0);for(const resource of resources)if(resource!==externalMaterial&&resource!==externalTexture)assert.equal(counts.get(resource),1,resource.type||resource.constructor.name);assert.equal(props.stats.disposed,true);assert.equal(props.applyMotion({steam:1},1),false);
});
