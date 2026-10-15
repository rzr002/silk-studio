import * as THREE from './vendor/three.module.js';
import {legPoint,legProjection} from './contact.mjs';
import {bodyGeometryData,DEFAULT_BODY_DIMENSIONS} from './garment-geometry.mjs';
import {computeDeformation,opticalResponse} from './deformation.mjs';
export {legPoint,legProjection};

const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const mix = (a,b,t) => a+(b-a)*t;

const periodic=model=>model.kind==='tube'||model.kind==='stocking';
const chartPoint=(u,v)=>[(u-.5)*.62,.18+v*.86,0];
function unwrap(values){
  if(Math.max(...values)-Math.min(...values)<=.5)return [...values];
  const sorted=[...values].sort((a,b)=>a-b);let gap=-1,start=sorted[0];
  for(let i=0;i<sorted.length;i++){const next=i===sorted.length-1?sorted[0]+1:sorted[i+1],d=next-sorted[i];if(d>gap){gap=d;start=i===sorted.length-1?sorted[0]:sorted[i+1];}}
  return values.map(u=>u<start-1e-10?u+1:u);
}
export function renderMeshData(model,{flat=false}={}) {
  const n=model.positions.length/3,vertexMap=Array.from({length:n},(_,i)=>i),uv=[...model.uv];
  const copies=new Map();
  if(periodic(model))for(let r=0;r<model.rows;r++){const i=r*model.cols;if(i>=n)break;copies.set(`${i}:1`,vertexMap.length);vertexMap.push(i);uv.push(model.uv[i*2]+1,model.uv[i*2+1]);}
  const indices=[];
  for(let j=0;j<model.triangles.length;j+=3){const face=model.triangles.slice(j,j+3),base=face.map(i=>model.uv[i*2]),u=periodic(model)?unwrap(base):base;for(let k=0;k<3;k++){const shift=Math.round(u[k]-base[k]),i=face[k];if(!shift){indices.push(i);continue;}const key=`${i}:${shift}`;if(!copies.has(key)){copies.set(key,vertexMap.length);vertexMap.push(i);uv.push(u[k],model.uv[i*2+1]);}indices.push(copies.get(key));}}
  const positions=vertexMap.flatMap((i,j)=>flat?chartPoint(uv[j*2],uv[j*2+1]):[...model.positions.slice(i*3,i*3+3)]);
  return {vertexMap,positions,uv,indices};
}

const lookups=new WeakMap();
function surfaceLookup(model){
  const cached=lookups.get(model);if(cached&&cached.n===model.positions.length&&cached.faces===model.triangles.length)return cached;
  const cells=new Map(),records=[];
  for(let j=0;j<model.triangles.length;j+=3){const ids=model.triangles.slice(j,j+3),base=ids.map(i=>model.uv[i*2]),u=periodic(model)?unwrap(base):base,v=ids.map(i=>model.uv[i*2+1]);const det=(u[1]-u[0])*(v[2]-v[0])-(u[2]-u[0])*(v[1]-v[0]);if(Math.abs(det)<1e-12)continue;const record={ids,u,v,det};records.push(record);for(let x=Math.floor(Math.min(...u)*64);x<=Math.floor(Math.max(...u)*64);x++)for(let y=Math.floor(Math.min(...v)*64);y<=Math.floor(Math.max(...v)*64);y++){const key=`${x},${y}`;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(record);}}
  const lookup={cells,records,n:model.positions.length,faces:model.triangles.length};lookups.set(model,lookup);return lookup;
}
function surfaceReference(model,u,v,lookup=surfaceLookup(model)){
  if(periodic(model))u=((u%1)+1)%1;else u=clamp(u,0,1);v=clamp(v,0,1);
  for(const targetU of periodic(model)?[u,u+1,u-1]:[u])for(const record of lookup.cells.get(`${Math.floor(targetU*64)},${Math.floor(v*64)}`)||[]){const {ids,u:a,v:b,det}=record,s=((targetU-a[0])*(b[2]-b[0])-(v-b[0])*(a[2]-a[0]))/det,t=((v-b[0])*(a[1]-a[0])-(targetU-a[0])*(b[1]-b[0]))/det;if(s>=-1e-7&&t>=-1e-7&&s+t<=1+1e-7)return {ids,weights:[1-s-t,s,t],valid:true};}
  let index=0,best=Infinity;for(let i=0;i<model.active.length;i++){if(!model.active[i])continue;let du=Math.abs(model.uv[i*2]-u);if(periodic(model))du=Math.min(du,1-du);const d=du*du+(model.uv[i*2+1]-v)**2;if(d<best){best=d;index=i;}}return {ids:[index,index,index],weights:[1,0,0],valid:false};
}
function referencePoint(model,reference){
  const p=model.positions,{ids,weights}=reference,point=[0,0,0];for(let i=0;i<3;i++)for(let k=0;k<3;k++)point[k]+=p[ids[i]*3+k]*weights[i];const a=[0,1,2].map(k=>p[ids[1]*3+k]-p[ids[0]*3+k]),b=[0,1,2].map(k=>p[ids[2]*3+k]-p[ids[0]*3+k]),normal=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],length=Math.hypot(...normal);return {...reference,point,normal:length>1e-12?normal.map(x=>x/length):[0,0,1]};
}
export function sampleSurface(model,u,v){return referencePoint(model,surfaceReference(model,u,v));}
export function renderOpticalData(model,{material={},graph=null,region=null,regions=null}={}){
  const deformation=computeDeformation(model),organization=[],allRegions=Array.isArray(regions)?regions:graph&&region?[{bounds:region.bounds||region,graph}]:[];
  for(const item of allRegions){const bounds=item.bounds||item,g=item.graph;if(!g||!bounds)continue;
    const nodes=new Map(g.nodes.map(n=>[`${n.row},${n.col}`,n]));
    for(let i=0;i<model.positions.length/3;i++){const u=model.uv[i*2],v=model.uv[i*2+1];if(u<bounds.u0||u>bounds.u1||v<bounds.v0||v>bounds.v1)continue;const col=clamp(Math.round(((u-bounds.u0)/(bounds.u1-bounds.u0)-.5)*g.cols/.9+(g.cols-1)/2),0,g.cols-1),row=clamp(Math.round(((v-bounds.v0)/(bounds.v1-bounds.v0)-.5)*g.rows/.9+(g.rows-1)/2),0,g.rows-1);organization[i]=nodes.get(`${row},${col}`)?.type||'eyelet';}
  }
  return {deformation,optical:opticalResponse(deformation,material||{},organization)};
}
function sourceNormals(geometry,vertexMap){
  geometry.computeVertexNormals();const normals=geometry.attributes.normal.array,sums=new Float64Array((Math.max(...vertexMap)+1)*3);
  for(let i=0;i<vertexMap.length;i++)for(let k=0;k<3;k++)sums[vertexMap[i]*3+k]+=normals[i*3+k];
  for(let i=0;i<vertexMap.length;i++){const offset=vertexMap[i]*3,length=Math.hypot(sums[offset],sums[offset+1],sums[offset+2])||1;for(let k=0;k<3;k++)normals[i*3+k]=sums[offset+k]/length;}
  geometry.attributes.normal.needsUpdate=true;
}

function bodyGeometry(angle,dimensions) {
  const source=bodyGeometryData({pose:angle,dimensions}),data=renderMeshData({...source,triangles:source.indices,kind:'stocking'});
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(data.uv,2));g.setIndex(data.indices);sourceNormals(g,data.vertexMap);g.userData.bodyVertexMap=data.vertexMap;g.userData.bodySourceCount=source.positions.length;return g;
}
function textileTexture() {
  const c=document.createElement('canvas');c.width=128;c.height=128;const ctx=c.getContext('2d');
  ctx.fillStyle='#c9c5bc';ctx.fillRect(0,0,128,128);
  for(let col=-1;col<3;col++)for(let row=-1;row<3;row++){
    const x=col*64+32,y=row*64+32;
    ctx.strokeStyle='#e1ded7';ctx.lineWidth=8;ctx.lineCap='round';ctx.beginPath();
    ctx.moveTo(x-26,y+29);ctx.bezierCurveTo(x+7,y+10,x-28,y-28,x,y-30);
    ctx.bezierCurveTo(x+28,y-28,x-7,y+10,x+26,y+29);ctx.stroke();
    ctx.strokeStyle='#d2cec4';ctx.lineWidth=3;ctx.stroke();
  }
  const tex=new THREE.CanvasTexture(c);tex.wrapS=tex.wrapT=THREE.RepeatWrapping;tex.colorSpace=THREE.SRGBColorSpace;return tex;
}
function bodyTexture(){
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;const context=canvas.getContext('2d');
  context.fillStyle='#c8b7a3';context.fillRect(0,0,256,256);
  for(let i=0;i<2600;i++){const x=(i*73.13)%256,y=(i*37.71)%256;context.fillStyle=i%2?'rgba(86,66,51,.055)':'rgba(255,238,217,.09)';context.fillRect(x,y,1.2,1.2);}
  // Subtle reference markings make changing fabric coverage observable.
  context.strokeStyle='rgba(76,71,65,.12)';context.lineWidth=.75;
  for(let i=0;i<=8;i++){context.beginPath();context.moveTo(i*32,0);context.lineTo(i*32,256);context.stroke();context.beginPath();context.moveTo(0,i*32);context.lineTo(256,i*32);context.stroke();}
  const texture=new THREE.CanvasTexture(canvas);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.colorSpace=THREE.SRGBColorSpace;return texture;
}
export function createFabricMaterial({stocking=true,texture=null}={}) {
  texture?.repeat.set(stocking?42:32,stocking?96:45);
  const m=new THREE.MeshPhysicalMaterial({color:stocking?'#39312f':'#b8aa94',map:texture,bumpMap:texture,bumpScale:.00025,roughness:.63,metalness:0,sheen:.6,sheenColor:new THREE.Color('#e8d9c4'),sheenRoughness:.46,side:THREE.DoubleSide,transparent:true,opacity:1,depthWrite:false});
  m.forceSinglePass=true;
  m.userData.strainUniform={value:false};
  m.onBeforeCompile=shader=>{
    shader.uniforms.uStrainView=m.userData.strainUniform;
    shader.vertexShader='attribute float strain; attribute float opticalOpacity; attribute float opticalRoughness; varying float vStrain; varying float vOpticalOpacity; varying float vOpticalRoughness;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvStrain=strain;vOpticalOpacity=opticalOpacity;vOpticalRoughness=opticalRoughness;');
    shader.fragmentShader='uniform bool uStrainView; varying float vStrain; varying float vOpticalOpacity; varying float vOpticalRoughness;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      diffuseColor.a=clamp(vOpticalOpacity,0.01,1.0);
      if (uStrainView) {
        float s=clamp(vStrain*3.0,0.0,1.0);
        diffuseColor.rgb=mix(vec3(.16,.38,.35),vec3(.88,.25,.11),s);
        diffuseColor.a=1.0;
      }`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=clamp(vOpticalRoughness,0.05,1.0);');
  };
  return m;
}

export class PhysicsScene {
  constructor(container,onInteraction) {
    this.container=container;this.onInteraction=onInteraction;this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#e9e7e0');
    this.camera=new THREE.PerspectiveCamera(34,1,.01,20);this.target=new THREE.Vector3(0,.57,0);this.angle=.07;this.elevation=.07;this.distance=1.65;
    this.renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.2;
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;container.append(this.renderer.domElement);
    this.scene.add(new THREE.HemisphereLight('#fff6e6','#9da7a0',2.2));
    const key=new THREE.DirectionalLight('#fff1dc',3.1);key.position.set(-1.5,2.5,2);key.castShadow=true;key.shadow.mapSize.set(1024,1024);Object.assign(key.shadow.camera,{left:-1,right:1,top:1.5,bottom:-.5,near:.1,far:6});key.shadow.bias=-.0002;this.scene.add(key);
    const fill=new THREE.DirectionalLight('#dce8f0',1.4);fill.position.set(1.5,1,-1);this.scene.add(fill);
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(20,20),new THREE.MeshStandardMaterial({color:'#e0ded6',roughness:.94}));floor.rotation.x=-Math.PI/2;floor.position.y=.015;floor.receiveShadow=true;this.scene.add(floor);
    const grid=new THREE.GridHelper(2.4,24,'#babcb4','#cfd0c8');grid.position.y=.016;grid.material.transparent=true;grid.material.opacity=.3;this.scene.add(grid);
    this.objectGroup=new THREE.Group();this.scene.add(this.objectGroup);this.overlay=new THREE.Group();this.scene.add(this.overlay);
    this.raycaster=new THREE.Raycaster();this.pointer=new THREE.Vector2();this.plane=new THREE.Plane();this.dragVector=new THREE.Vector3();this.sewFirst=null;
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(container);this.resize();this.bindPointers();
  }
  invalidate(){(this._renderState??={requests:0,draws:0,skipped:0,dirty:true}).dirty=true;}
  get renderStats(){return Object.freeze({...this._renderState||{requests:0,draws:0,skipped:0,dirty:true}});}
  resize(){const w=this.container.clientWidth,h=this.container.clientHeight;this.renderer.setSize(w,h,false);this.camera.aspect=w/Math.max(1,h);this.camera.updateProjectionMatrix();this.cameraUpdate();this.invalidate();}
  cameraUpdate(){
    // These public values can also be changed by callers, outside pointer handlers.
    const state=[this.angle,this.elevation,this.distance,this.target.x,this.target.y,this.target.z,this.camera.fov,this.camera.aspect,this.camera.near,this.camera.far,this.camera.zoom];
    if(this._cameraState&&state.every((value,i)=>value===this._cameraState[i]))return;
    this._cameraState=state;this.camera.position.set(this.target.x+Math.sin(this.angle)*this.distance,this.target.y+this.elevation,Math.cos(this.angle)*this.distance);this.camera.lookAt(this.target);this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld();this.invalidate();
  }
  clearGroup(group){for(const o of [...group.children]){group.remove(o);o.traverse(c=>{c.geometry?.dispose();if(c.material){for(const m of [].concat(c.material)){m.map?.dispose();m.dispose();}}});}this.invalidate();}
  setModel(model,kind,graph=null,options={}){
    const resetCamera=this.kind!==kind||!this.model;
    this.model=model;this.kind=kind;this.graph=graph||options.region?.graph||null;this.region=options.region?.bounds||options.region||null;this.regions=Array.isArray(options.regions)?options.regions:null;this.materialProfile=options.material||{};this.bodyDimensions=options.bodyDimensions||DEFAULT_BODY_DIMENSIONS;
    this.sewFirst=null;this.clearGroup(this.objectGroup);this.clearGroup(this.overlay);this.yarn=null;this.yarnRest=null;this.yarnReferences=null;this.seamLines=null;this.regionOutline=null;this.strokeLine=null;this.selectedIndex=null;this.body=null;
    lookups.delete(model);this.lookup=surfaceLookup(model);
    const g=this.buildGeometry();
    this.material=createFabricMaterial({stocking:kind!=='lab',texture:textileTexture()});this.mesh=new THREE.Mesh(g,this.material);this.mesh.castShadow=kind==='lab';this.mesh.receiveShadow=true;this.objectGroup.add(this.mesh);
    this.wire=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:'#292f2b',wireframe:true,transparent:true,opacity:.16,depthWrite:false}));this.wire.visible=this.showWire||false;this.objectGroup.add(this.wire);
    this.pinMesh=new THREE.InstancedMesh(new THREE.SphereGeometry(.0045,8,6),new THREE.MeshStandardMaterial({color:'#365e4d',roughness:.5}),model.positions.length/3);this.overlay.add(this.pinMesh);
    this.selection=new THREE.Mesh(new THREE.SphereGeometry(.008,16,12),new THREE.MeshBasicMaterial({color:'#c57342',depthTest:false}));this.selection.visible=false;this.overlay.add(this.selection);
    const skin=bodyTexture(),ceramic=new THREE.MeshPhysicalMaterial({color:'#f0e2d0',map:skin,bumpMap:skin,bumpScale:.00008,roughness:.54,clearcoat:.08});
    if(kind==='stocking'||kind==='knit'){this.body=new THREE.Mesh(bodyGeometry(this.pose||0,this.bodyDimensions),ceramic);this.body.castShadow=true;this.body.receiveShadow=true;this.objectGroup.add(this.body);this.bodyGeometryKey=JSON.stringify([this.pose||0,this.bodyDimensions]);}
    else if(kind==='lab'){this.body=new THREE.Mesh(new THREE.SphereGeometry(.135,48,32),ceramic);this.body.position.set(0,.49,-.10);this.body.castShadow=true;this.body.receiveShadow=true;this.objectGroup.add(this.body);}
    else ceramic.dispose();
    if(resetCamera){
      if(kind==='stocking'){this.target.set(.12,.47,.08);this.distance=1.8;this.elevation=.08;this.angle=.22;}
      else if(kind==='knit'&&this.region){this.sample((this.region.u0+this.region.u1)/2,(this.region.v0+this.region.v1)/2,this.target);this.distance=.72;this.elevation=.025;this.angle=(this.region.u0+this.region.u1)*Math.PI;}
      else {this.target.set(0,.61,0);this.distance=kind==='patch'?1.85:1.6;this.elevation=.035;this.angle=.025;}
    }
    this.cameraUpdate();
    if(kind==='knit'&&this.graph)this.buildYarn(this.graph);
    this.setCollider(this.colliderEnabled!==false);this.buildRegionOutline();
    this.setStrain(this.showStrain||false);this.update();
  }
  buildGeometry(){
    const data=renderMeshData(this.model,{flat:this.kind==='patch'});this.vertexMap=data.vertexMap;
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(data.uv,2));
    for(const key of ['strain','opticalOpacity','opticalRoughness'])g.setAttribute(key,new THREE.Float32BufferAttribute(new Float32Array(data.vertexMap.length),1));
    g.setIndex(data.indices);sourceNormals(g,data.vertexMap);g.computeBoundingSphere();this.geometry=g;return g;
  }
  buildYarn(graph){
    this.invalidate();
    if(this.yarn){this.objectGroup.remove(this.yarn);this.yarn.geometry.dispose();this.yarn.material.dispose();}
    const path=graph.yarnPaths()[0];if(!path?.points.length)return;
    const curve=new THREE.CatmullRomCurve3(path.points.map(p=>new THREE.Vector3(...p)),false,'centripetal');
    const g=new THREE.TubeGeometry(curve,Math.min(1800,path.points.length*2),.004,6,false);
    this.yarnRest=Float32Array.from(g.attributes.position.array);
    g.setAttribute('color',new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count*3).fill(1),3));
    const m=new THREE.MeshPhysicalMaterial({vertexColors:true,color:'#c2b39b',roughness:.48,metalness:0,sheen:.65,sheenColor:new THREE.Color('#f6e6c4'),sheenRoughness:.35});
    this.yarn=new THREE.Mesh(g,m);this.yarn.castShadow=true;this.yarn.receiveShadow=true;this.objectGroup.add(this.yarn);
    const b=this.region||{u0:0,u1:1,v0:0,v1:1};
    const width=this.sample(b.u0,(b.v0+b.v1)/2).distanceTo(this.sample(b.u1,(b.v0+b.v1)/2)),height=this.sample((b.u0+b.u1)/2,b.v0).distanceTo(this.sample((b.u0+b.u1)/2,b.v1));
    this.yarnScale=Math.max(.01,(width+height)/2);this.yarnReferences=[];
    for(let i=0;i<this.yarnRest.length;i+=3){const u=b.u0+(this.yarnRest[i]+.5)*(b.u1-b.u0),v=b.v0+(this.yarnRest[i+1]+.5)*(b.v1-b.v0);this.yarnReferences.push(surfaceReference(this.model,u,v,this.lookup));}
  }
  sample(u,v,out=new THREE.Vector3()){
    return out.fromArray(referencePoint(this.model,surfaceReference(this.model,u,v,this.lookup)).point);
  }
  viewPoint(index){return this.kind==='patch'?chartPoint(this.model.uv[index*2],this.model.uv[index*2+1]):[...this.model.positions.slice(index*3,index*3+3)];}
  topologyChanged(){
    lookups.delete(this.model);this.lookup=surfaceLookup(this.model);const previous=this.geometry;this.buildGeometry();this.mesh.geometry=this.geometry;this.wire.geometry=this.geometry;previous.dispose();
    if(this.pinMesh.instanceMatrix.count<this.model.positions.length/3){this.overlay.remove(this.pinMesh);this.pinMesh.geometry.dispose();this.pinMesh.material.dispose();this.pinMesh=new THREE.InstancedMesh(new THREE.SphereGeometry(.0045,8,6),new THREE.MeshStandardMaterial({color:'#365e4d',roughness:.5}),this.model.positions.length/3);this.overlay.add(this.pinMesh);}
    if(this.yarn&&this.graph)this.buildYarn(this.graph);this.update();
  }
  setPose(angle,dimensions=this.bodyDimensions){
    this.pose=angle;this.bodyDimensions=dimensions||DEFAULT_BODY_DIMENSIONS;if(!this.body||!['stocking','knit'].includes(this.kind))return;
    const key=JSON.stringify([angle,this.bodyDimensions]);if(key===this.bodyGeometryKey)return;
    const source=bodyGeometryData({pose:angle,dimensions:this.bodyDimensions}),g=this.body.geometry,map=g.userData.bodyVertexMap;
    if(map&&g.userData.bodySourceCount===source.positions.length){const positions=g.attributes.position.array;for(let i=0;i<map.length;i++)for(let k=0;k<3;k++)positions[i*3+k]=source.positions[map[i]*3+k];g.attributes.position.needsUpdate=true;sourceNormals(g,map);g.computeBoundingSphere();g.computeBoundingBox();}
    else {g.dispose();this.body.geometry=bodyGeometry(angle,this.bodyDimensions);}
    this.bodyGeometryKey=key;this.invalidate();
  }
  setWire(on){this.showWire=on;if(this.wire)this.wire.visible=on;this.invalidate();}
  setStrain(on){this.showStrain=on;if(this.material)this.material.userData.strainUniform.value=on;if(this.yarn)this.yarn.material.color.set(on?'#ffffff':'#c2b39b');this.updateYarnColors();this.invalidate();}
  setCollider(on){this.colliderEnabled=on;if(this.body)this.body.visible=on&&this.kind!=='patch';this.invalidate();}
  select(index){this.selectedIndex=index;this.selection.visible=index!=null;if(index!=null&&this.model.active[index])this.selection.position.fromArray(this.viewPoint(index));this.invalidate();}
  buildRegionOutline(){
    if(!this.region)return;const points=new Float32Array(64*3),g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(points,3));
    this.regionOutline=new THREE.LineLoop(g,new THREE.LineBasicMaterial({color:'#bd8054',transparent:true,opacity:.85,depthTest:this.kind!=='patch'}));this.regionOutline.renderOrder=3;this.overlay.add(this.regionOutline);this.invalidate();
  }
  updateRegionOutline(){
    if(!this.regionOutline)return;const b=this.region,points=this.regionOutline.geometry.attributes.position.array;
    for(let i=0;i<64;i++){const edge=Math.floor(i/16),t=(i%16)/16,u=edge===0?mix(b.u0,b.u1,t):edge===1?b.u1:edge===2?mix(b.u1,b.u0,t):b.u0,v=edge===0?b.v0:edge===1?mix(b.v0,b.v1,t):edge===2?b.v1:mix(b.v1,b.v0,t);let p;if(this.kind==='patch')p=chartPoint(u,v).map((x,k)=>x+(k===2?.002:0));else{const q=referencePoint(this.model,surfaceReference(this.model,u,v,this.lookup));p=q.point.map((x,k)=>x+q.normal[k]*.002);}points.set(p,i*3);}
    this.regionOutline.geometry.attributes.position.needsUpdate=true;this.regionOutline.geometry.computeBoundingSphere();this.invalidate();
  }
  update(){
    if(!this.model)return;const m=this.model,p=this.geometry.attributes.position.array,uv=this.geometry.attributes.uv.array;
    for(let i=0;i<this.vertexMap.length;i++){const k=this.vertexMap[i]*3;if(this.kind==='patch')p.set(chartPoint(uv[i*2],uv[i*2+1]),i*3);else {p[i*3]=m.positions[k];p[i*3+1]=m.positions[k+1];p[i*3+2]=m.positions[k+2];}}this.geometry.attributes.position.needsUpdate=true;
    const result=renderOpticalData(m,{material:this.materialProfile,graph:this.graph,region:this.region,regions:this.regions});this.deformation=result.deformation;this.optical=this.optics=result.optical;
    const opacity=this.geometry.attributes.opticalOpacity.array,roughness=this.geometry.attributes.opticalRoughness.array,s=this.geometry.attributes.strain.array;
    let minOpacity=1,maxOpacity=0,minRoughness=1,maxRoughness=0;for(let i=0;i<s.length;i++){const source=this.vertexMap[i];s[i]=m.vertexStrain(source);opacity[i]=this.optical.opacity[source];roughness[i]=this.optical.roughness[source];minOpacity=Math.min(minOpacity,opacity[i]);maxOpacity=Math.max(maxOpacity,opacity[i]);minRoughness=Math.min(minRoughness,roughness[i]);maxRoughness=Math.max(maxRoughness,roughness[i]);}
    this.opticalSummary={source:this.optical.source,status:this.optical.status,minOpacity,maxOpacity,minRoughness,maxRoughness,extrapolated:this.optical.extrapolated.reduce((a,b)=>a+b,0)};
    for(const name of ['strain','opticalOpacity','opticalRoughness'])this.geometry.attributes[name].needsUpdate=true;sourceNormals(this.geometry,this.vertexMap);this.geometry.computeBoundingSphere();
    const mat=new THREE.Matrix4();let n=0;for(const i of m.pins){if(!m.active[i])continue;mat.makeTranslation(...this.viewPoint(i));this.pinMesh.setMatrixAt(n++,mat);}this.pinMesh.count=n;this.pinMesh.instanceMatrix.needsUpdate=true;
    if(this.selectedIndex!=null&&m.active[this.selectedIndex])this.selection.position.fromArray(this.viewPoint(this.selectedIndex));
    if(this.yarn){const pos=this.yarn.geometry.attributes.position.array;
      for(let i=0;i<pos.length;i+=3){const reference=this.yarnReferences[i/3],q=referencePoint(m,reference),offset=this.yarnRest[i+2]*this.yarnScale+.0007;for(let k=0;k<3;k++)pos[i+k]=q.point[k]+q.normal[k]*offset;}
      this.updateYarnColors();this.yarn.geometry.attributes.position.needsUpdate=true;this.yarn.geometry.computeVertexNormals();this.yarn.geometry.computeBoundingSphere();}
    this.updateSeams();this.updateRegionOutline();this.invalidate();
  }
  updateYarnColors(){
    if(!this.yarn||!this.yarnReferences)return;const colors=this.yarn.geometry.attributes.color.array;
    for(let i=0;i<colors.length;i+=3){const reference=this.yarnReferences[i/3],strain=this.showStrain?clamp(reference.ids.reduce((value,id,k)=>value+this.model.vertexStrain(id)*reference.weights[k],0)*3,0,1):0;colors[i]=this.showStrain?mix(.16,.88,strain):1;colors[i+1]=this.showStrain?mix(.38,.25,strain):1;colors[i+2]=this.showStrain?mix(.35,.11,strain):1;}
    this.yarn.geometry.attributes.color.needsUpdate=true;this.invalidate();
  }
  updateSeams(){
    this.invalidate();
    const points=[];for(const c of this.model.constraints)if(c.kind==='seam')points.push(...this.viewPoint(c.a),...this.viewPoint(c.b));
    if(this.seamLines&&this.seamLines.geometry.attributes.position.array.length===points.length){this.seamLines.geometry.attributes.position.array.set(points);this.seamLines.geometry.attributes.position.needsUpdate=true;this.seamLines.geometry.computeBoundingSphere();return;}
    if(this.seamLines){this.overlay.remove(this.seamLines);this.seamLines.geometry.dispose();this.seamLines.material.dispose();this.seamLines=null;}
    if(points.length){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(points,3));this.seamLines=new THREE.LineSegments(g,new THREE.LineBasicMaterial({color:'#b55e35',depthTest:false}));this.overlay.add(this.seamLines);}
  }
  render(){
    this.cameraUpdate();const state=this._renderState;state.requests++;
    if(!state.dirty){state.skipped++;return false;}
    this.renderer.render(this.scene,this.camera);state.draws++;state.dirty=false;return true;
  }
  pointerRay(e){this.cameraUpdate();const r=this.renderer.domElement.getBoundingClientRect();this.pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);this.raycaster.setFromCamera(this.pointer,this.camera);return this.raycaster;}
  pick(e,boundary=false){
    const hit=this.pointerRay(e).intersectObject(this.mesh)[0];if(!hit)return null;
    const choices=boundary?[...this.model.boundary]:[hit.face.a,hit.face.b,hit.face.c].map(i=>this.vertexMap[i]);let index=null,best=Infinity;
    for(const i of choices){if(!this.model.active[i])continue;const d=hit.point.distanceToSquared(new THREE.Vector3(...this.viewPoint(i)));if(d<best){best=d;index=i;}}
    if(index==null||boundary&&best>.012**2)return null;
    const g=this.geometry.attributes.position,ids=[hit.face.a,hit.face.b,hit.face.c],vertices=ids.map(i=>new THREE.Vector3().fromBufferAttribute(g,i)),weights=THREE.Triangle.getBarycoord(hit.point,...vertices,new THREE.Vector3()),physical=[0,0,0];
    for(let k=0;k<3;k++)for(let axis=0;axis<3;axis++)physical[axis]+=this.model.positions[this.vertexMap[ids[k]]*3+axis]*weights.getComponent(k);
    return {index,point:physical,viewPoint:hit.point.toArray(),uv:[periodic(this.model)?((hit.uv.x%1)+1)%1:clamp(hit.uv.x,0,1),clamp(hit.uv.y,0,1)]};
  }
  bindPointers(){
    const canvas=this.renderer.domElement;canvas.style.touchAction='none';canvas.addEventListener('contextmenu',e=>e.preventDefault());
    canvas.addEventListener('webglcontextrestored',()=>this.invalidate());
    canvas.addEventListener('pointerdown',e=>{
      canvas.setPointerCapture(e.pointerId);const orbit=e.button===2||e.altKey||this.tool==='orbit';this.drag={orbit,x:e.clientX,y:e.clientY};
      if(orbit)return;const hit=this.pick(e,this.tool==='sew');if(!hit){this.drag=null;return;}
      this.select(hit.index);this.drag.hit=hit;this.plane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()),new THREE.Vector3(...hit.viewPoint));this.onInteraction({type:'start',tool:this.tool,hit,event:e});
    });
    canvas.addEventListener('pointermove',e=>{
      if(!this.drag)return;
      if(this.drag.orbit){this.angle-=(e.clientX-this.drag.x)*.007;this.elevation=clamp(this.elevation+(e.clientY-this.drag.y)*.001,-.45,.6);this.drag.x=e.clientX;this.drag.y=e.clientY;this.cameraUpdate();return;}
      const hit=this.pick(e);if(!this.pointerRay(e).ray.intersectPlane(this.plane,this.dragVector))return;this.onInteraction({type:'move',tool:this.tool,hit,point:this.dragVector.toArray(),viewPoint:this.dragVector.toArray(),physicalPoint:hit?.point||null,start:this.drag.hit,event:e});
    });
    const end=e=>{if(!this.drag)return;if(!this.drag.orbit)this.onInteraction({type:'end',tool:this.tool,hit:this.pick(e),start:this.drag.hit,event:e});this.drag=null;};
    canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);canvas.addEventListener('lostpointercapture',()=>{if(this.drag&&!this.drag.orbit)this.onInteraction({type:'cancel',tool:this.tool});this.drag=null;});
    canvas.addEventListener('wheel',e=>{e.preventDefault();this.distance=clamp(this.distance+e.deltaY*.0012,.6,3);this.cameraUpdate();},{passive:false});
  }
  projectUV(u,v){return this.projectPoint(this.kind==='patch'?new THREE.Vector3(...chartPoint(u,v)):this.sample(u,v));}
  projectVertex(index){return this.projectPoint(new THREE.Vector3(...this.viewPoint(index)));}
  projectPoint(point){this.cameraUpdate();const p=point.clone().project(this.camera),r=this.renderer.domElement.getBoundingClientRect();return {x:r.left+(p.x+1)*r.width/2,y:r.top+(1-p.y)*r.height/2};}
  capture(){this.render();return this.renderer.domElement.toDataURL('image/png');}
}
