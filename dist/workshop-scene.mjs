import * as THREE from './vendor/three.module.js';
import {bodyGeometryData,DEFAULT_BODY_DIMENSIONS} from './garment-geometry.mjs';
import {renderMeshData,renderOpticalData,createFabricMaterial} from './scene.mjs';
import {computeDeformation,opticalResponse} from './deformation.mjs';
import {createKnit} from './knit.mjs';
import {WorkshopMotion} from './workshop-motion.mjs';
import {cameraFrameAt} from './workshop-camera.mjs';
import {createWorkshopProps} from './workshop-props.mjs';

const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
const yarns=[{id:'nylon-fine',color:'#d8c3aa'},{id:'nylon-stretch',color:'#594844'},{id:'reinforced',color:'#252a32'}];
const guides=['guide-1','tensioner','feeder'];
const guidePositions=[[-.66,1.17,.06],[-.47,1.26,-.05],[-.10,1.14,.08]];
const point=(positions,index)=>[...positions.slice(index*3,index*3+3)];
const visible=object=>{for(let current=object;current;current=current.parent)if(!current.visible)return false;return true;};
export function workshopColors(session){const yarn=yarns.find(item=>item.id===session.recipe.yarnId)?.color||yarns[0].color;return {yarn,blank:`#${new THREE.Color(yarn).lerp(new THREE.Color(session.finish.color),session.finish.dyeProgress).getHexString()}`};}
const courseCells=(session,row)=>session.production.courses.find(course=>course.row===row)?.cells||session.recipe.program.cells.slice(row*session.recipe.program.cols,(row+1)*session.recipe.program.cols);
export function workshopOrganization(model,session){const {cols,rows}=session.recipe.program;return Array.from({length:model.positions.length/3},(_,i)=>{const row=clamp(Math.round((1-model.uv[i*2+1])*(rows-1)),0,rows-1),col=clamp(Math.floor(model.uv[i*2]*cols),0,cols-1);return courseCells(session,row)[col]||'knit';});}
export function sampleLayout({courses,pull=0,loopLengthMm=3}){return {width:.135*(1+pull),height:.075*(courses-1)/7*loopLengthMm/3};}
export function frameStationPoints(points,{width,height,top=60,bottom=135,angle=.2,elevationRatio=.35}={}){
  width=Math.max(1,width);height=Math.max(1,height);top=Math.min(top,height*.25);bottom=Math.min(bottom,height*.4);
  const bounds=new THREE.Box3().setFromPoints(points.map(p=>new THREE.Vector3(...p))).expandByScalar(.055),target=bounds.getCenter(new THREE.Vector3()),corners=[];
  for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])corners.push(new THREE.Vector3(x,y,z));
  const camera=new THREE.PerspectiveCamera(35,width/height,.05,20),offsetY=(bottom-top)/2;camera.setViewOffset(width,height,0,offsetY,width,height);let distance=1.15;
  for(let step=0;step<35;step++,distance*=1.10){camera.position.set(target.x+Math.sin(angle)*distance,target.y+distance*elevationRatio,target.z+Math.cos(angle)*distance);camera.lookAt(target);camera.updateMatrixWorld();if(corners.every(point=>{const p=point.clone().project(camera),x=(p.x+1)*width/2,y=(1-p.y)*height/2;return x>=24&&x<=width-24&&y>=top&&y<=height-bottom;}))break;}
  return {target:target.toArray(),distance,elevation:distance*elevationRatio,angle,offsetY};
}
/** Visual process feedback, not a solved strain field; canonical arrays stay
 * untouched. The domain owns whether a seam or finishing step is accepted. */
export function processDisplayPositions(data,session){
  const positions=[...data.positions];
  for(let i=0;i<data.uv.length/2;i++){
    const u=data.uv[i*2],v=data.uv[i*2+1],k=i*3;
    if(session.stage==='seam'&&session.seam.feed>0&&Math.abs(session.seam.alignment)>.01&&v<.09){const weight=(1-v/.09)**2*session.seam.feed,angle=session.seam.alignment*.35*weight,x=positions[k]-.12,y=positions[k+1]-.067;positions[k]=.12+x*Math.cos(angle)-y*Math.sin(angle);positions[k+1]=.067+x*Math.sin(angle)+y*Math.cos(angle);positions[k+2]+=.004*Math.sin(u*Math.PI*12)*Math.abs(session.seam.alignment)*weight;}
    if(session.stage==='finish'&&session.finish.boarded){const zone=v>.93?'cuff':v<.31?'foot':'leg';if(!session.finish.smoothedZones.includes(zone)){positions[k]+=.0045*Math.sin(u*Math.PI*12+v*65);positions[k+2]+=.0035*Math.cos(u*Math.PI*10+v*80);}}
  }
  return positions;
}
export function buildCourseYarn(blank,cells,{loopLengthMm=3}={}){
  const ring=blank.frontier.positions,points=[],stitches={knit:0,tuck:0,miss:0};if(!ring.length)return {points,stitches,yarnLength:0};
  const center=ring.reduce((sum,p)=>sum.map((x,k)=>x+p[k]/ring.length),[0,0,0]),count=cells.length||40;
  for(let i=0;i<count;i++){
    const index=Math.floor(i*ring.length/count),p=new THREE.Vector3(...ring[index]),next=new THREE.Vector3(...ring[(index+1)%ring.length]),previous=new THREE.Vector3(...ring[(index+ring.length-1)%ring.length]),tangent=next.clone().sub(previous).normalize(),normal=p.clone().sub(new THREE.Vector3(...center)).normalize(),vertical=new THREE.Vector3().crossVectors(tangent,normal).normalize();
    const type=cells[i]||'knit',pitch=next.distanceTo(previous)*.5*(ring.length/count),height=.003*loopLengthMm/3*(type==='tuck'?1.8:1);stitches[type]=(stitches[type]||0)+1;
    const local=type==='miss'?[[-.45,0,0],[.45,0,0]]:[[-.45,-.25,-.0003],[-.25,.6,.0003],[0,1,.0006],[.25,.6,.0003],[.45,-.25,-.0003]];
    for(const [x,y,z]of local)points.push(p.clone().addScaledVector(tangent,x*pitch).addScaledVector(vertical,y*height).addScaledVector(normal,z).toArray());
  }
  let yarnLength=0;for(let i=0;i<points.length;i++)yarnLength+=Math.hypot(...points[i].map((x,k)=>x-points[(i+1)%points.length][k]));return {points,stitches,yarnLength};
}

/** Display only the fabricated part of the canonical source. Course numbers
 * are display groups; this does not claim a machine has only 48 yarn courses. */
export function buildCourseBlank(model,{producedCourses=0,totalCourses=48,toeClosed=false,useCurrentPositions=false}={}){
  if(!Number.isInteger(totalCourses)||totalCourses<2||totalCourses>10000||!Number.isInteger(producedCourses)||producedCourses<0||producedCourses>totalCourses)throw new RangeError('Invalid production course counters');
  if(toeClosed&&producedCourses!==totalCourses)throw new RangeError('Toe closure requires complete production');
  const data={positions:[],uv:[],indices:[],sourceRefs:[],frontier:{positions:[],uv:[],indices:[]},frontierV:producedCourses?1-(producedCourses-1)/(totalCourses-1):null,producedCourses,totalCourses,toeClosed,capFaces:0};
  if(!producedCourses)return data;
  const positions=useCurrentPositions?model.positions:model.rest,vMin=data.frontierV,lookup=new Map(),aux=new Set(model.metadata?.toeCap?.vertices||[]);
  const vertex=i=>({key:`v:${i}`,id:i,p:point(positions,i),uv:[model.uv[i*2],model.uv[i*2+1]],ref:{ids:[i],weights:[1]}});
  const add=v=>{if(lookup.has(v.key))return lookup.get(v.key);const i=data.positions.length/3;lookup.set(v.key,i);data.positions.push(...v.p);data.uv.push(...v.uv);data.sourceRefs.push(v.ref);return i;};
  const intersect=(a,b)=>{const t=(vMin-a.uv[1])/(b.uv[1]-a.uv[1]);if(t<1e-10)return a;if(t>1-1e-10)return b;let du=b.uv[0]-a.uv[0];if(du>.5)du-=1;if(du<-.5)du+=1;return {key:`e:${Math.min(a.id,b.id)},${Math.max(a.id,b.id)}`,p:a.p.map((x,k)=>x+(b.p[k]-x)*t),uv:[((a.uv[0]+du*t)%1+1)%1,vMin],ref:{ids:[a.id,b.id],weights:[1-t,t]}};};
  if(producedCourses===totalCourses&&toeClosed){
    for(let i=0;i<positions.length/3;i++)add(vertex(i));data.indices=[...model.triangles];
    for(let j=0;j<data.indices.length;j+=3)if(data.indices.slice(j,j+3).some(i=>aux.has(i)))data.capFaces++;
  }else if(producedCourses===1){
    for(let i=0;i<positions.length/3;i++)if(Math.abs(model.uv[i*2+1]-1)<1e-10&&(!model.active||model.active[i]))add(vertex(i));
  }else{
    for(let j=0;j<model.triangles.length;j+=3){
      const ids=model.triangles.slice(j,j+3),isCap=ids.some(i=>aux.has(i));if(isCap&&!toeClosed)continue;
      const face=ids.map(vertex),clipped=[];
      for(let k=0;k<3;k++){const a=face[k],b=face[(k+1)%3],aInside=a.uv[1]>=vMin-1e-12,bInside=b.uv[1]>=vMin-1e-12;if(aInside)clipped.push(a);if(aInside!==bInside)clipped.push(intersect(a,b));}
      for(let k=1;k<clipped.length-1;k++){
        const triangle=[clipped[0],clipped[k],clipped[k+1]],a=triangle[1].p.map((x,i)=>x-triangle[0].p[i]),b=triangle[2].p.map((x,i)=>x-triangle[0].p[i]);
        if(Math.hypot(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])<1e-14)continue;
        data.indices.push(...triangle.map(add));if(isCap)data.capFaces++;
      }
    }
  }
  const frontier=[];for(let i=0;i<data.uv.length/2;i++)if(Math.abs(data.uv[i*2+1]-vMin)<1e-10&&!data.sourceRefs[i].ids.some(id=>aux.has(id)))frontier.push(i);
  frontier.sort((a,b)=>data.uv[a*2]-data.uv[b*2]);
  data.frontier.indices=frontier;data.frontier.positions=frontier.map(i=>point(data.positions,i));data.frontier.uv=frontier.map(i=>data.uv.slice(i*2,i*2+2));return data;
}

function texture(kind){
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;const ctx=canvas.getContext('2d'),image=ctx.createImageData(256,256);
  for(let y=0;y<256;y++)for(let x=0;x<256;x++){
    const noise=Math.sin(x*127.1+y*311.7)*43758.5453%1;
    const warp=Math.sin(x*.018)*.8+Math.sin(x*.07)*.2,wave=kind==='wood'?Math.sin(y*1.2+warp*3)+Math.sin(y*3.4+warp*7)*.3:Math.cos((y+Math.sin(x*.16)*2)*1.8);
    const base=kind==='wood'?[159,141,114]:[224,219,207],strength=kind==='wood'?3.5:10,i=(y*256+x)*4;
    for(let k=0;k<3;k++)image.data[i+k]=clamp(base[k]+wave*strength+noise*3,0,255);image.data[i+3]=255;
  }
  ctx.putImageData(image,0,0);const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;map.wrapS=map.wrapT=THREE.RepeatWrapping;map.repeat.set(kind==='wood'?3:24,kind==='wood'?2:48);return map;
}
function environment(){
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=128;const ctx=canvas.getContext('2d'),gradient=ctx.createLinearGradient(0,0,0,128);
  gradient.addColorStop(0,'#f7f1e6');gradient.addColorStop(.5,'#96988f');gradient.addColorStop(1,'#4e504a');ctx.fillStyle=gradient;ctx.fillRect(0,0,256,128);
  ctx.fillStyle='#fff9ec';ctx.fillRect(25,12,35,45);ctx.fillStyle='#e7ebeb';ctx.fillRect(153,18,28,37);
  const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;map.mapping=THREE.EquirectangularReflectionMapping;return map;
}
function mesh(parent,geometry,material,position=[0,0,0],rotation=[0,0,0]){
  const object=new THREE.Mesh(geometry,material);object.position.fromArray(position);object.rotation.set(...rotation);object.castShadow=true;object.receiveShadow=true;parent.add(object);return object;
}
const box=(parent,dimensions,material,position,rotation)=>mesh(parent,new THREE.BoxGeometry(...dimensions),material,position,rotation);
const cylinder=(parent,radius,height,material,position,rotation=[0,0,0],open=false)=>mesh(parent,new THREE.CylinderGeometry(radius,radius,height,48,1,open),material,position,rotation);
function tube(parent,points,radius,material,closed=false){
  if(points.length<2)return null;const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)),closed,'centripetal');return mesh(parent,new THREE.TubeGeometry(curve,Math.min(1600,Math.max(16,points.length*3)),radius,6,closed),material);
}
function disposeTree(root,keepMaterials=new Set()){
  const geometries=new Set(),materials=new Set();root.traverse(object=>{if(object.geometry)geometries.add(object.geometry);for(const material of [].concat(object.material||[]))if(!keepMaterials.has(material))materials.add(material);});
  for(const geometry of geometries)geometry.dispose();for(const material of materials)material.dispose();
}

export class WorkshopScene {
  constructor(container,callback){
    this.container=container;this.callback=callback;this.objects=new Map();this.listeners=[];this.textures=new Set();this.sharedMaterials=new Set();this._dirty=true;this._counts={requests:0,draws:0,skipped:0};
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#dcded7');this.scene.environment=environment();this.textures.add(this.scene.environment);
    this.camera=new THREE.PerspectiveCamera(35,1,.05,15);this.target=new THREE.Vector3(0,.82,.08);this.angle=.32;this.distance=3.25;this.elevation=1.24;
    this._reducedMotion=!!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;this.motion=new WorkshopMotion({reducedMotion:this._reducedMotion});this._lastDrawMs=-Infinity;this._needleMatrix=new THREE.Matrix4();this._needleVector=new THREE.Vector3();this._needleQuaternion=new THREE.Quaternion();this._unitScale=new THREE.Vector3(1,1,1);
    this.renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio||1,1.5));this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.12;
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;this.renderer.domElement.style.touchAction='none';container.append(this.renderer.domElement);
    this.scene.add(new THREE.HemisphereLight('#fff2dd','#70756b',2.2));const key=new THREE.DirectionalLight('#fff4df',3.3);key.position.set(-2,4,3);key.castShadow=true;key.shadow.mapSize.set(1024,1024);Object.assign(key.shadow.camera,{left:-2,right:2,bottom:-1.5,top:2,near:.1,far:9});key.shadow.bias=-.00025;key.shadow.normalBias=.002;this.scene.add(key);
    const fill=new THREE.DirectionalLight('#d8e2e7',1.3);fill.position.set(3,2,-2);this.scene.add(fill);
    this.staticGroup=new THREE.Group();this.dynamicGroup=new THREE.Group();this.scene.add(this.staticGroup,this.dynamicGroup);this.raycaster=new THREE.Raycaster();this.pointer=new THREE.Vector2();
    this.buildFurniture();this.parts={};for(const name of ['spool','thread','sample','blank']){this.parts[name]=new THREE.Group();this.dynamicGroup.add(this.parts[name]);}
    this.yarnMaterial=this.material({color:yarns[0].color,roughness:.67,map:this.fibre,bumpMap:this.fibre,bumpScale:.0002});this.blankYarnMaterial=this.yarnMaterial.clone();this.sharedMaterials.add(this.blankYarnMaterial);
    this.fabricMaterial=createFabricMaterial({stocking:true,texture:this.fabricTexture});this.fabricMaterial.bumpScale=.00012;this.fabricMaterial.forceSinglePass=false;this.sharedMaterials.add(this.fabricMaterial);
    this.fabricMaterial.userData.revealUniform={value:-1};const fabricCompile=this.fabricMaterial.onBeforeCompile;
    this.fabricMaterial.onBeforeCompile=shader=>{fabricCompile(shader);shader.uniforms.uWorkshopFrontier=this.fabricMaterial.userData.revealUniform;shader.vertexShader='varying float vWorkshopV;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvWorkshopV=uv.y;');shader.fragmentShader='uniform float uWorkshopFrontier; varying float vWorkshopV;\n'+shader.fragmentShader;shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\nif(vWorkshopV+0.00001<uWorkshopFrontier) discard;');};
    this.fabricMaterial.customProgramCacheKey=()=> 'workshop-fabric-frontier-v1';
    this.linkMaterial=new THREE.LineBasicMaterial({color:yarns[0].color});this.sharedMaterials.add(this.linkMaterial);
    this.sampleMaterial=new THREE.MeshPhysicalMaterial({color:yarns[0].color,map:this.fibre,bumpMap:this.fibre,bumpScale:.0002,roughness:.68,sheen:.5,side:THREE.DoubleSide,transparent:true,opacity:.7,depthWrite:false});this.sharedMaterials.add(this.sampleMaterial);
    this.gripMaterial=new THREE.MeshBasicMaterial({color:'#bd9760',transparent:true,opacity:.48,depthWrite:false});this.sharedMaterials.add(this.gripMaterial);
    this.props=createWorkshopProps({materials:{steel:this.steel,brass:this.brass,rubber:this.rubber}});this.scene.add(this.props.group);
    this.renderer.shadowMap.autoUpdate=false;this.renderer.shadowMap.needsUpdate=true;
    this.bindPointers();this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(container);this.resize();
  }
  material(options){const material=new THREE.MeshStandardMaterial(options);this.sharedMaterials.add(material);return material;}
  register(id,station,object,anchor=[0,0,0]){object.userData.workshopId=id;this.objects.set(id,{object,station,anchor:new THREE.Vector3(...anchor)});return object;}
  buildFurniture(){
    const root=this.staticGroup,wood=texture('wood'),fibre=texture('fibre');this.textures.add(wood);this.textures.add(fibre);this.fibre=fibre;this.fabricTexture=fibre.clone();this.textures.add(this.fabricTexture);
    this.wood=this.material({color:'#ddd7ca',map:wood,bumpMap:wood,bumpScale:.0002,roughness:.65});this.steel=this.material({color:'#a8aca5',metalness:.86,roughness:.3});this.iron=this.material({color:'#2f3c36',metalness:.5,roughness:.55});this.brass=this.material({color:'#b89759',metalness:.75,roughness:.32});this.rubber=this.material({color:'#272a27',roughness:.9});this.linen=this.material({color:'#d7ccba',map:fibre,roughness:.85});
    box(root,[8,.04,8],this.material({color:'#d9d7cf',roughness:.95}),[0,-.025,0]);
    for(const [x,w]of [[-.68,.54],[.60,.70]])box(root,[w,.055,.82],this.wood,[x,.82,0]);box(root,[1.9,.055,.28],this.wood,[0,.82,-.27]);
    for(const x of [-.86,.87])for(const z of [-.29,.29]){box(root,[.055,.8,.055],this.iron,[x,.4,z]);box(root,[.075,.018,.075],this.rubber,[x,.012,z]);}
    box(root,[1.78,.035,.035],this.iron,[0,.25,-.29]);
    yarns.forEach((yarn,i)=>{const group=this.spool(yarn.color);group.position.set(-.82+i*.17,.85,-.24);root.add(group);this.register(`yarn-${yarn.id}`,'yarn',group,[0,.09,.045]);});
    this.spindle=new THREE.Group();this.spindle.position.set(-.70,.85,.16);root.add(this.spindle);cylinder(this.spindle,.075,.025,this.iron,[0,.012,0]);cylinder(this.spindle,.007,.22,this.steel,[0,.11,0]);this.register('spindle','yarn',this.spindle,[0,.19,0]);
    this.guideObjects=[];guides.forEach((id,i)=>{const group=new THREE.Group();group.position.fromArray(guidePositions[i]);root.add(group);cylinder(group,.004,guidePositions[i][1]-.85,this.steel,[0,-(guidePositions[i][1]-.85)/2,0]);const eye=mesh(group,new THREE.TorusGeometry(.017,.003,8,24),this.brass);this.guideObjects.push(eye);this.register(id,'yarn',group,[.017,0,0]);});
    this.machine=new THREE.Group();this.machine.position.set(-.12,.98,.16);root.add(this.machine);
    cylinder(this.machine,.155,.04,this.iron,[0,-.035,0],[0,0,0],true);mesh(this.machine,new THREE.RingGeometry(.087,.155,64),this.steel,[0,-.014,0],[-Math.PI/2,0,0]);
    for(let i=0;i<4;i++){const a=i*Math.PI/2+.5;box(this.machine,[.012,.25,.012],this.iron,[Math.sin(a)*.17,-.16,Math.cos(a)*.17]);}
    const needles=new THREE.InstancedMesh(new THREE.CylinderGeometry(.0014,.0014,.084,6),this.steel,40),hooks=new THREE.InstancedMesh(new THREE.TorusGeometry(.004,.0013,5,12,Math.PI),this.steel,40),matrix=new THREE.Matrix4();
    for(let i=0;i<40;i++){const a=i*Math.PI*2/40;matrix.compose(new THREE.Vector3(Math.sin(a)*.091,.027,Math.cos(a)*.091),new THREE.Quaternion(),new THREE.Vector3(1,1,1));needles.setMatrixAt(i,matrix);matrix.compose(new THREE.Vector3(Math.sin(a)*.091,.071,Math.cos(a)*.091),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),a),new THREE.Vector3(1,1,1));hooks.setMatrixAt(i,matrix);}this.machine.add(needles,hooks);this.needles=needles;this.needleHooks=hooks;
    this.wheel=new THREE.Group();this.wheel.position.set(-.34,.88,.37);root.add(this.wheel);mesh(this.wheel,new THREE.TorusGeometry(.085,.009,10,40),this.iron);for(let i=0;i<3;i++)box(this.wheel,[.14,.005,.006],this.steel,[0,0,0],[0,0,i*Math.PI/3]);cylinder(this.wheel,.015,.035,this.brass,[0,0,.02],[Math.PI/2,0,0]);mesh(this.wheel,new THREE.SphereGeometry(.018,12,8),this.wood,[-.06,.045,.02]);this.register('handwheel','knit',this.wheel,[0,0,.025]);
    this.sampleAnchor=new THREE.Group();this.sampleAnchor.position.set(-.55,1.06,.35);root.add(this.sampleAnchor);box(this.sampleAnchor,[.17,.012,.018],this.brass);for(const x of [-.08,.08])cylinder(this.sampleAnchor,.003,.205,this.steel,[x,-.1025,0]);this.register('sample','sample',this.sampleAnchor);
    this.seamJaws=[];for(const [i,id]of ['toe-left','toe-right'].entries()){const group=new THREE.Group();group.position.set(.38+(i?1:-1)*.033,.98,.49);root.add(group);box(group,[.048,.015,.055],this.steel);box(group,[.037,.006,.035],this.rubber,[0,-.011,0]);this.register(id,'seam',group);this.seamJaws.push(group);}
    box(root,[.18,.05,.11],this.iron,[.38,.92,.48]);const pedal=box(root,[.095,.023,.07],this.iron,[.42,.72,.53],[-.12,0,0]);this.register('sewing-pedal','seam',pedal);
    this.vat=new THREE.Group();this.vat.position.set(.72,.06,.66);root.add(this.vat);const glass=this.material({color:'#b7c2b9',metalness:.15,roughness:.3,transparent:true,opacity:.26,side:THREE.DoubleSide,depthWrite:false});
    cylinder(this.vat,.145,.73,glass,[0,.365,0],[0,0,0],true);cylinder(this.vat,.147,.018,this.iron,[0,.008,0]);for(const y of [.06,.68])mesh(this.vat,new THREE.TorusGeometry(.147,.006,8,48),this.steel,[0,y,0],[Math.PI/2,0,0]);
    this.liquid=mesh(this.vat,new THREE.CircleGeometry(.14,48),this.material({color:'#594844',roughness:.2,metalness:.05,transparent:true,opacity:.62,side:THREE.DoubleSide,depthWrite:false}),[0,.69,0],[-Math.PI/2,0,0]);this.register('dye-vat','finish',this.vat,[0,.70,0]);
    this.boardGroup=new THREE.Group();this.boardGroup.position.set(.58,.87,-.22);root.add(this.boardGroup);this.register('board','finish',this.boardGroup,[.03,.42,.04]);
    const shape=new THREE.Shape();shape.moveTo(-.07,.80);shape.lineTo(.07,.80);shape.lineTo(.055,.20);shape.quadraticCurveTo(.055,.09,.19,.085);shape.quadraticCurveTo(.24,.02,.16,.01);shape.lineTo(-.055,.02);shape.lineTo(-.07,.80);
    mesh(this.boardGroup,new THREE.ExtrudeGeometry(shape,{depth:.012,bevelEnabled:true,bevelSegments:2,steps:1,bevelSize:.003,bevelThickness:.002}),this.wood);
    cylinder(this.boardGroup,.006,.85,this.steel,[-.09,.38,-.02]);box(this.boardGroup,[.25,.018,.16],this.iron,[.03,-.008,0]);
    this.smoothObjects=new Map();for(const [zone,y]of [['cuff',.75],['leg',.43],['foot',.08]]){const pad=mesh(this.boardGroup,new THREE.SphereGeometry(.014,12,8),this.material({color:'#ba9e68',metalness:.65,roughness:.4}),[.015,y,.105]);this.register(`smooth-${zone}`,'finish',pad);this.smoothObjects.set(zone,pad);}
    const steam=mesh(root,new THREE.CylinderGeometry(.026,.028,.025,24),this.material({color:'#a85b40',metalness:.2,roughness:.6}),[.89,.88,.23]);this.register('steam-button','finish',steam);
    this.mannequin=new THREE.Group();this.mannequin.position.set(-1.03,.10,.75);this.mannequin.visible=false;root.add(this.mannequin);this.register('mannequin','wear',this.mannequin,[.12,.45,.055]);
    const body=bodyGeometryData(),g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(body.positions,3));g.setIndex(body.indices);g.computeVertexNormals();this.body=mesh(this.mannequin,g,this.material({color:'#c7bcaa',roughness:.53,metalness:.05}));cylinder(this.mannequin,.07,.025,this.iron,[.12,-.015,0]);
  }
  spool(color){
    const group=new THREE.Group(),fibre=new THREE.MeshStandardMaterial({color,map:this.fibre,bumpMap:this.fibre,bumpScale:.0003,roughness:.7});
    cylinder(group,.053,.13,fibre,[0,.075,0]);for(const y of [.006,.143])cylinder(group,.062,.012,this.wood,[0,y,0]);cylinder(group,.01,.17,this.steel,[0,.085,0]);return group;
  }
  setWorkshop({session,model,material={},bodyDimensions=DEFAULT_BODY_DIMENSIONS,fitCamera=true}){
    if(this._disposed)return;const previous=this.state,now=performance.now(),same=previous?.id===session.id,oldBlank=this.objects.get('blank')?.object;
    const oldPlacement=same&&oldBlank?{position:oldBlank.position.clone(),quaternion:oldBlank.quaternion.clone()}:null;
    if(!same){this.motion=new WorkshopMotion({reducedMotion:this._reducedMotion??!!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches});this._blankTravel=null;this._reveal=null;this._manualSamplePull=null;}
    this.motion.setState(session,now);this.state=session;this.model=model;this.materialProfile=material;this.bodyDimensions=bodyDimensions;
    const selected=yarns.find(yarn=>yarn.id===session.recipe.yarnId)||yarns[0],colors=workshopColors(session);this.sourceYarnColor=new THREE.Color(colors.yarn);this.fabricColor=new THREE.Color(colors.blank);
    this.yarnMaterial.color.set(colors.yarn);this.blankYarnMaterial.color.copy(this.fabricColor);this.fabricMaterial.color.copy(this.fabricColor);this.sampleMaterial.color.copy(this.sourceYarnColor);this.linkMaterial.color.copy(this.fabricColor);
    const mountKey=JSON.stringify([session.threading.mounted,selected.id]);if(mountKey!==this.mountKey){this.clearPart('spool');this.register('spindle','yarn',this.spindle,[0,.19,0]);if(session.threading.mounted){const spool=this.spool(selected.color);spool.position.copy(this.spindle.position);this.parts.spool.add(spool);this.register('spindle','yarn',spool,[0,.09,.045]);}this.mountKey=mountKey;this.renderer.shadowMap.needsUpdate=true;}
    const threadKey=JSON.stringify(session.threading);if(threadKey!==this.threadKey){this.clearPart('thread');this.objects.delete('thread-end');this.updateThread(session);this.threadKey=threadKey;}
    const sampleKey=JSON.stringify([session.sample,session.recipe.loopLengthMm,selected.id]);if(sampleKey!==this.sampleKey){this.clearPart('sample');this.register('sample','sample',this.sampleAnchor);this.updateSample(session);this.sampleKey=sampleKey;}
    const blankKey=JSON.stringify([session.stage,session.production.producedCourses,session.production.totalCourses,session.seam,session.finish,session.wear,session.recipe.program.cells]);
    if(this.blankModel!==model||blankKey!==this.blankKey){this.clearPart('blank');this.objects.delete('blank');this.blankData=buildCourseBlank(model,{producedCourses:session.production.producedCourses,totalCourses:session.production.totalCourses,toeClosed:session.seam.closed,useCurrentPositions:session.wear.dressed});this.buildBlank(session);this.blankModel=model;this.blankKey=blankKey;}
    if(same&&session.production.producedCourses>previous.production.producedCourses&&previous.production.producedCourses>0&&!this._reducedMotion)this._reveal={from:1-(previous.production.producedCourses-1)/(session.production.totalCourses-1),to:this.blankData.frontierV,startMs:now,durationMs:380};
    else if(!same||session.production.producedCourses<previous.production.producedCourses){this._reveal=null;this.fabricMaterial.userData.revealUniform.value=-1;}
    const placementChanged=same&&(previous.stage!==session.stage||previous.finish.boarded!==session.finish.boarded||previous.wear.dressed!==session.wear.dressed),nextBlank=this.objects.get('blank')?.object;
    if(oldPlacement&&nextBlank&&placementChanged&&!this._reducedMotion)this._blankTravel={object:nextBlank,from:oldPlacement,to:{position:nextBlank.position.clone(),quaternion:nextBlank.quaternion.clone()},startMs:now};
    else if(!nextBlank)this._blankTravel=null;
    else if(this._blankTravel&&this._blankTravel.object!==nextBlank){this._blankTravel.object=nextBlank;this._blankTravel.to={position:nextBlank.position.clone(),quaternion:nextBlank.quaternion.clone()};}
    const cells=courseCells(session,Math.max(0,session.production.producedCourses-1)),matrix=new THREE.Matrix4();this.needleTypes=cells;
    for(let i=0;i<40;i++){const a=i*Math.PI*2/40,delta=cells[i]==='tuck'?.016:cells[i]==='miss'?-.018:0;matrix.compose(new THREE.Vector3(Math.sin(a)*.091,.027+delta,Math.cos(a)*.091),new THREE.Quaternion(),new THREE.Vector3(1,1,1));this.needles.setMatrixAt(i,matrix);matrix.compose(new THREE.Vector3(Math.sin(a)*.091,.071+delta,Math.cos(a)*.091),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),a),new THREE.Vector3(1,1,1));this.needleHooks.setMatrixAt(i,matrix);}this.needles.instanceMatrix.needsUpdate=true;this.needleHooks.instanceMatrix.needsUpdate=true;
    this.seamJaws[0].position.y=.98+session.seam.alignment*.035;this.seamJaws[1].position.y=.98-session.seam.alignment*.035;
    this.liquid.material.color.set(session.finish.color);for(const [zone,pad]of this.smoothObjects)pad.material.color.set(session.finish.smoothedZones.includes(zone)?'#6d8c69':'#ba9e68');
    const bodyKey=JSON.stringify([session.wear.pose,bodyDimensions]);if(bodyKey!==this.bodyKey){const bodyData=bodyGeometryData({pose:session.wear.pose,dimensions:bodyDimensions}),position=this.body.geometry.attributes.position;if(position.array.length===bodyData.positions.length){position.array.set(bodyData.positions);position.needsUpdate=true;this.body.geometry.computeVertexNormals();this.body.geometry.computeBoundingSphere();}this.bodyKey=bodyKey;this.renderer.shadowMap.needsUpdate=true;}
    this.applyStationVisibility();
    if(fitCamera&&this.station&&!this.manualCamera)this.fitStation();
    this.invalidate();
  }
  clearPart(name){disposeTree(this.parts[name],this.sharedMaterials);this.parts[name].clear();}
  updateThread(session){
    if(!session.threading.mounted)return;const points=[[-.70,1.005,.16]];
    for(const id of session.threading.path){const index=guides.indexOf(id);if(index>=0)points.push(guidePositions[index]);}
    if(session.threading.path.length===3)points.push([-.03,1.05,.16]);
    const last=points.at(-1),end=[last[0]+.04,last[1]-.05,last[2]+.03];points.push(end);tube(this.parts.thread,points,.0017,this.yarnMaterial);this.threadCurve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)));
    this.threadRunner=mesh(this.parts.thread,new THREE.SphereGeometry(.006,8,6),this.brass);this.threadRunner.visible=false;
    const tip=mesh(this.parts.thread,new THREE.SphereGeometry(.012,12,8),this.brass,end);this.register('thread-end','yarn',tip);
  }
  updateSample(session){
    const count=session.sample.courses;this.sampleGroup=null;if(!count)return;const group=new THREE.Group();group.position.copy(this.sampleAnchor.position);this.parts.sample.add(group);this.sampleGroup=group;
    const {height,width}=sampleLayout({courses:count,pull:session.sample.pull,loopLengthMm:session.recipe.loopLengthMm});
    if(count>1){const graph=createKnit({cols:8,rows:count}),g=new THREE.PlaneGeometry(width,height,12,count-1);g.translate(0,-height/2,0);mesh(group,g,this.sampleMaterial,[0,0,.002]).castShadow=false;const yarn=tube(group,graph.yarnPaths()[0].points.map(p=>[p[0]*width,-(p[1]+.5)*height,p[2]*.003+.006]),.0009,this.yarnMaterial);if(yarn)yarn.castShadow=false;}
    else tube(group,[[-width/2,0,.006],[width/2,0,.006]],.0011,this.yarnMaterial);
    this.register('sample','sample',group,[0,-height*.6,.006]);
    const oldTrials=session.sample.trials.filter(trial=>trial.id!==session.sample.activeId);
    for(let i=0;i<Math.min(3,oldTrials.length);i++){const trial=oldTrials[oldTrials.length-1-i],shape=sampleLayout({courses:trial.courses,pull:trial.maxPull,loopLengthMm:trial.loopLengthMm}),g=new THREE.PlaneGeometry(Math.min(.105,shape.width*.48),Math.max(.025,shape.height*.6),6,4);if(trial.damaged){const p=g.attributes.position.array;for(let j=0;j<p.length;j+=3)p[j]+=Math.sin(j)*.004;g.computeVertexNormals();}mesh(this.parts.sample,g,new THREE.MeshStandardMaterial({color:yarns.find(yarn=>yarn.id===trial.yarnId)?.color||'#b4a38e',map:this.fibre,side:THREE.DoubleSide,roughness:.8}),[-.75+i*.115,.856,.30],[-Math.PI/2,0,0]);}
  }
  buildBlank(session){
    const data=this.blankData;if(!data.positions.length)return;const group=new THREE.Group();this.parts.blank.add(group);this.register('blank','knit',group);
    if(data.indices.length){
      if(this.deformationModel!==this.model){this.deformation=computeDeformation(this.model);this.deformationModel=this.model;}
      const displayPositions=processDisplayPositions(data,session),render=renderMeshData({kind:'stocking',rows:0,cols:0,positions:displayPositions,uv:data.uv,triangles:data.indices}),g=new THREE.BufferGeometry(),result={optical:opticalResponse(this.deformation,this.materialProfile,workshopOrganization(this.model,session))};
      g.setAttribute('position',new THREE.Float32BufferAttribute(render.positions,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(render.uv,2));g.setIndex(render.indices);
      for(const [name,values]of [['strain',null],['opticalOpacity',result.optical.opacity],['opticalRoughness',result.optical.roughness]])g.setAttribute(name,new THREE.Float32BufferAttribute(render.vertexMap.map(i=>values?data.sourceRefs[i].ids.reduce((sum,id,k)=>sum+values[id]*data.sourceRefs[i].weights[k],0):0),1));
      g.computeVertexNormals();const normals=g.attributes.normal.array,sums=new Float32Array(data.positions.length);for(let i=0;i<render.vertexMap.length;i++)for(let k=0;k<3;k++)sums[render.vertexMap[i]*3+k]+=normals[i*3+k];for(let i=0;i<render.vertexMap.length;i++){const j=render.vertexMap[i]*3,length=Math.hypot(...sums.slice(j,j+3))||1;for(let k=0;k<3;k++)normals[i*3+k]=sums[j+k]/length;}mesh(group,g,this.fabricMaterial).castShadow=false;
    }
    this.activeYarn=buildCourseYarn(data,courseCells(session,Math.max(0,session.production.producedCourses-1)),{loopLengthMm:session.recipe.loopLengthMm});
    tube(group,this.activeYarn.points,.0009,this.blankYarnMaterial,true);
    if(session.wear.dressed){group.position.copy(this.mannequin.position);}
    else if(session.finish.boarded){group.rotation.y=Math.PI/2;group.position.set(.58,.87,-.22+.12);}
    else if(session.stage==='finish'){group.position.set(.72-.12,-.015-(session.finish.dyeProgress*.025),.66-.07);}
    else{
      const frontier=data.frontier.positions,center=frontier.reduce((sum,p)=>sum.map((x,k)=>x+p[k]/frontier.length),[0,0,0]);group.rotation.x=Math.PI;group.position.set((session.stage==='seam'?.38:-.12)-center[0],.98+center[1],(session.stage==='seam'?.49:.16)+center[2]);
    }
    const bounds=new THREE.Box3().setFromObject(group);this.objects.get('blank').anchor.copy(group.worldToLocal(bounds.getCenter(new THREE.Vector3())));
    if(!data.indices.length)this.objects.get('blank').anchor.fromArray(data.frontier.positions[0]);
    if(session.stage==='knit'){
      group.updateMatrixWorld(true);const links=[];for(let i=0;i<40;i++){const a=i*Math.PI*2/40,p=data.frontier.positions[Math.floor(i*data.frontier.positions.length/40)],end=group.localToWorld(new THREE.Vector3(...p));links.push(new THREE.Vector3(-.12+Math.sin(a)*.091,1.04,.16+Math.cos(a)*.091),end);}
      this.parts.blank.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(links),this.linkMaterial));
    }
    if(session.stage==='seam'&&session.seam.feed>0){const ring=data.frontier.positions,stitches=Math.floor(ring.length/2*session.seam.feed),points=[];for(let i=0;i<stitches;i++){const j=(Math.floor(ring.length/2)-i+Math.round(session.seam.alignment*ring.length/4)+ring.length)%ring.length;points.push(ring[i],ring[j]);}if(points.length){const geometry=new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(...p)));group.add(new THREE.LineSegments(geometry,this.linkMaterial));}}
  }
  setStation(station,{instant=false}={}){
    const views={yarn:[[-.59,1.01,.08],1.8,.64,.18],sample:[[-.42,.96,.25],1.5,.56,.12],knit:[[-.12,.81,.16],1.85,.63,.25],seam:[[.38,.87,.49],1.5,.52,.18],finish:[[.62,1.05,.10],2.0,.75,.30],wear:[[-.84,1.28,-.36],1.7,.22,.18]};
    const view=views[station];if(!view)return;const from=this.cameraFrame();this.station=station;this.manualCamera=false;this.applyStationVisibility();this.props?.setStation(station);if(instant||this._reducedMotion)this._cameraTween=null;this.fitStation({animate:!instant&&!this._reducedMotion,from});this.invalidate();
  }
  applyStationVisibility(){
    const quiet=this.station==='wear',showBody=quiet||(!this.station&&this.state?.wear.dressed);let changed=false;
    for(const object of this.staticGroup.children){const on=object===this.mannequin?showBody:object===this.staticGroup.children[0]||!quiet;if(object.visible!==!!on){object.visible=!!on;changed=true;}}
    for(const name of ['spool','thread','sample'])this.parts[name].visible=!quiet;
    this.parts.blank.visible=quiet?!!this.state?.wear.dressed:!this.station||!this.state?.wear.dressed;
    if(changed)this.renderer.shadowMap.needsUpdate=true;
  }
  fitStation({animate=false,from=null}={}){
    const ids={yarn:[...yarns.map(y=>`yarn-${y.id}`),'spindle',...guides],sample:['sample','handwheel'],knit:['handwheel','feeder'],seam:['toe-left','toe-right','sewing-pedal'],finish:['dye-vat','board','smooth-cuff','smooth-leg','smooth-foot','steam-button'],wear:['mannequin']}[this.station];if(!ids)return;
    this.scene.updateMatrixWorld(true);const points=[];for(const id of ids){const record=this.objects.get(id);if(record)points.push(record.object.localToWorld(record.anchor.clone()).toArray());}
    const boundsIds=this.station==='wear'?['mannequin','blank']:this.station==='knit'||this.station==='finish'?['blank']:[];
    for(const id of boundsIds){const object=this.objects.get(id)?.object;if(!object||!visible(object))continue;const bounds=new THREE.Box3().setFromObject(object);for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])points.push([x,y,z]);}
    if(this.station==='knit')points.push([-.28,.95,0],[.04,1.08,.32]);
    if(this.station==='seam'){const group=this.objects.get('blank')?.object;if(group)for(const p of this.blankData.frontier.positions)points.push(group.localToWorld(new THREE.Vector3(...p)).toArray());}
    if(!points.length)return;const rect=this.renderer.domElement.getBoundingClientRect(),card=this.container.parentElement?.querySelector('.task-card'),bottom=card?Math.max(110,rect.bottom-card.getBoundingClientRect().top+18):30,frame=frameStationPoints(points,{width:rect.width,height:rect.height,top:card?64:30,bottom,angle:this.station==='wear'?-.28:this.station==='yarn'?.12:.22,elevationRatio:this.station==='wear'?.12:this.station==='seam'?.24:.35});
    if(animate){this._cameraTween={from:from||this.cameraFrame(),to:frame,startMs:performance.now(),durationMs:560};this.applyCameraFrame(this._cameraTween.from);}
    else if(this._cameraTween)this._cameraTween.to=frame;
    else this.applyCameraFrame(frame);
  }
  cameraFrame(){return {target:this.target.toArray(),distance:this.distance,elevation:this.elevation,angle:this.angle,offsetY:this.camera.view?.offsetY||0};}
  applyCameraFrame(frame){this.target.fromArray(frame.target);this.distance=frame.distance;this.elevation=frame.elevation;this.angle=frame.angle;const width=Math.max(1,this.container.clientWidth),height=Math.max(1,this.container.clientHeight);this.camera.setViewOffset(width,height,0,frame.offsetY||0,width,height);this.invalidate();}
  resetView(){this.station=null;this.manualCamera=false;this._cameraTween=null;this.props?.setStation(null);this.applyStationVisibility();this.camera.clearViewOffset();this.target.set(0,.82,.08);this.angle=.32;this.distance=3.25;this.elevation=1.24;this.invalidate();}
  setMotionEnabled(enabled){this._reducedMotion=!enabled;const now=performance.now();this.motion.setReducedMotion(!enabled,now);if(!enabled){if(this._cameraTween)this.applyCameraFrame(this._cameraTween.to);this._cameraTween=null;if(this._blankTravel){this._blankTravel.object.position.copy(this._blankTravel.to.position);this._blankTravel.object.quaternion.copy(this._blankTravel.to.quaternion);}this._blankTravel=null;this._reveal=null;this.fabricMaterial.userData.revealUniform.value=-1;}this.invalidate();}
  previewSampleStretch(extension){if(!this.sampleGroup)return;this._manualSamplePull=clamp(extension,0,1);this.invalidate();}
  clearManipulationPreview(){this._manualSamplePull=null;this.invalidate();}
  animate(timeMs){
    const frame=this.motion.sample(timeMs),c=frame.channels;this._lastMotion=frame;
    const moving=frame.active||!!this._cameraTween||!!this._blankTravel||!!this._reveal;
    if(this._cameraTween){const value=cameraFrameAt(this._cameraTween,timeMs);this.applyCameraFrame(value.frame);if(!value.moving)this._cameraTween=null;}
    if(this._blankTravel){const travel=this._blankTravel,t=clamp((timeMs-travel.startMs)/550,0,1),ease=t*t*(3-2*t);travel.object.position.lerpVectors(travel.from.position,travel.to.position,ease);travel.object.quaternion.slerpQuaternions(travel.from.quaternion,travel.to.quaternion,ease);if(t===1)this._blankTravel=null;this.invalidate();}
    if(this._reveal){const t=clamp((timeMs-this._reveal.startMs)/this._reveal.durationMs,0,1);this.fabricMaterial.userData.revealUniform.value=this._reveal.from+(this._reveal.to-this._reveal.from)*t;if(t===1){this._reveal=null;this.fabricMaterial.userData.revealUniform.value=-1;}this.invalidate();}
    const wheel=-c.wheelAngle;if(this.wheel.rotation.z!==wheel){this.wheel.rotation.z=wheel;this.invalidate();}
    const spool=this.parts.spool.children[0];if(spool&&spool.rotation.y!==c.spindleAngle){spool.rotation.y=c.spindleAngle;this.invalidate();}
    if(this._lastNeedlePhase!==c.wheelAngle||this._lastNeedleEnergy!==c.knitEnergy){for(let i=0;i<40;i++){const a=i*Math.PI*2/40,type=this.needleTypes?.[i],delta=(type==='tuck'?.016:type==='miss'?-.018:0)+c.needleLift[i]*.022;this._needleVector.set(Math.sin(a)*.091,.027+delta,Math.cos(a)*.091);this._needleQuaternion.identity();this._needleMatrix.compose(this._needleVector,this._needleQuaternion,this._unitScale);this.needles.setMatrixAt(i,this._needleMatrix);this._needleVector.y=.071+delta;this._needleQuaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP,a);this._needleMatrix.compose(this._needleVector,this._needleQuaternion,this._unitScale);this.needleHooks.setMatrixAt(i,this._needleMatrix);}this.needles.instanceMatrix.needsUpdate=true;this.needleHooks.instanceMatrix.needsUpdate=true;this._lastNeedlePhase=c.wheelAngle;this._lastNeedleEnergy=c.knitEnergy;this.invalidate();}
    if(this.threadRunner){const show=c.knitEnergy>0&&this.state.threading.path.length===3;if(show){this.threadCurve.getPointAt(c.feedPhase,this.threadRunner.position);this.invalidate();}if(this.threadRunner.visible!==show){this.threadRunner.visible=show;this.invalidate();}}
    if(this.sampleGroup){const pull=this._manualSamplePull??c.sampleExtension,scale=(1+pull)/(1+this.state.sample.pull);if(this.sampleGroup.scale.x!==scale){this.sampleGroup.scale.x=scale;this.invalidate();}}
    const color=this._displayDyeColor||(this._displayDyeColor=new THREE.Color());color.copy(this.sourceYarnColor).lerp(this.liquid.material.color,c.dyeMix);if(!this.fabricMaterial.color.equals(color)){this.fabricMaterial.color.copy(color);this.blankYarnMaterial.color.copy(color);this.invalidate();}
    if(this.props.applyMotion(c,timeMs/1000))this.invalidate();
    this._visualActive=moving;
  }
  get motionStats(){const frame=this._lastMotion||{active:false,reducedMotion:this._reducedMotion,channels:{},activity:{}};return {...structuredClone(frame),active:!!this._visualActive,cameraMoving:!!this._cameraTween,clothMoving:!!this._blankTravel||!!this._reveal,props:{...this.props.stats,driveAngle:this.props.refs.machine.driveGear.rotation.z,sewingY:this.props.refs.seam.needle.position.y,rippleVisible:this.props.refs.vat.ripple.visible,steamVisible:this.props.refs.vat.steam.visible,steamSample:Array.from(this.props.refs.vat.steam.geometry.attributes.position.array.slice(0,6)),renderCalls:this.renderer.info.render.calls},camera:this.cameraFrame()};}
  invalidate(){this._dirty=true;}
  get renderStats(){return Object.freeze({...this._counts,dirty:this._dirty,disposed:!!this._disposed});}
  cameraUpdate(){
    const state=[this.angle,this.distance,this.elevation,this.target.x,this.target.y,this.target.z];if(this._cameraState&&state.every((value,i)=>value===this._cameraState[i]))return;this._cameraState=state;
    this.camera.position.set(this.target.x+Math.sin(this.angle)*this.distance,this.target.y+this.elevation,this.target.z+Math.cos(this.angle)*this.distance);this.camera.lookAt(this.target);this.camera.updateMatrixWorld();this.invalidate();
  }
  resize(){if(this._disposed)return;const width=Math.max(1,this.container.clientWidth),height=Math.max(1,this.container.clientHeight);this.renderer.setSize(width,height,false);this.camera.aspect=width/height;this.camera.updateProjectionMatrix();if(this.station&&!this.manualCamera)this.fitStation();this.invalidate();}
  render(timeMs=performance.now(),{force=false}={}){if(this._disposed)return false;this.animate(timeMs);this.cameraUpdate();this._counts.requests++;if(!this._dirty||!force&&this._visualActive&&timeMs-this._lastDrawMs<1000/30){this._counts.skipped++;return false;}this.renderer.render(this.scene,this.camera);this._lastDrawMs=timeMs;this._counts.draws++;this._dirty=false;return true;}
  capture(){this.render(performance.now(),{force:true});return this.renderer.domElement.toDataURL('image/png');}
  projectObject(id){
    const record=this.objects.get(id);if(!record||!visible(record.object))return null;this.cameraUpdate();this.scene.updateMatrixWorld(true);const p=record.object.localToWorld(record.anchor.clone()).project(this.camera),rect=this.renderer.domElement.getBoundingClientRect();return {x:(p.x+1)*rect.width/2,y:(1-p.y)*rect.height/2};
  }
  eventScreen(event){const rect=this.renderer.domElement.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top};}
  pointerRay(event){this.cameraUpdate();const {x,y}=this.eventScreen(event),rect=this.renderer.domElement.getBoundingClientRect();this.pointer.set(x/rect.width*2-1,1-y/rect.height*2);this.scene.updateMatrixWorld(true);this.raycaster.setFromCamera(this.pointer,this.camera);return this.raycaster;}
  pick(event){
    for(const hit of this.pointerRay(event).intersectObjects([...this.objects.values()].map(record=>record.object).filter(visible),true)){let object=hit.object;while(object&&!object.userData.workshopId)object=object.parent;const id=object?.userData.workshopId,record=this.objects.get(id);if(record)return {objectId:id,station:record.station,point:hit.point.toArray()};}return null;
  }
  beginGrip(hit){
    this.endGrip();const record=this.objects.get(hit.objectId);if(!record)return;record.object.updateWorldMatrix(true,true);const clone=record.object.clone(true);
    clone.traverse(object=>{if(object.geometry)object.geometry=object.geometry.clone();if(object.material)object.material=this.gripMaterial;if(object.isLine)object.visible=false;object.castShadow=false;object.receiveShadow=false;});record.object.matrixWorld.decompose(clone.position,clone.quaternion,clone.scale);this.scene.add(clone);
    this.grip={clone,hit,origin:new THREE.Vector3(...hit.point),startPosition:clone.position.clone()};
    if(hit.objectId==='thread-end'){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(6),3));this.grip.line=new THREE.LineSegments(geometry,this.linkMaterial);this.scene.add(this.grip.line);}
    this.updateGripTarget();this.invalidate();
  }
  updateGripTarget(){
    if(!this.grip)return;const id=this.grip.hit.objectId,target=id.startsWith('yarn-')?'spindle':id==='thread-end'?guides[this.state?.threading.path.length||0]:id==='blank'?'dye-vat':null,record=this.objects.get(target);
    if(!record){if(this.grip.halo)this.grip.halo.visible=false;return;}if(!this.grip.halo){this.grip.halo=new THREE.Mesh(new THREE.TorusGeometry(.038,.002,6,32),this.gripMaterial);this.scene.add(this.grip.halo);}this.grip.halo.visible=true;this.grip.halo.position.copy(record.object.localToWorld(record.anchor.clone()));if(this.camera)this.grip.halo.quaternion.copy(this.camera.quaternion);
  }
  followGrip(worldPoint){
    if(!this.grip)return;const p=new THREE.Vector3(...worldPoint);this.grip.clone.position.copy(this.grip.startPosition).add(p.clone().sub(this.grip.origin));
    if(this.grip.line){const start=this.objects.get('thread-end'),origin=start?start.object.localToWorld(start.anchor.clone()):this.grip.origin,position=this.grip.line.geometry.attributes.position;position.array.set([...origin.toArray(),...p.toArray()]);position.needsUpdate=true;this.grip.line.geometry.computeBoundingSphere();}this.updateGripTarget();this.invalidate();
  }
  endGrip(){if(!this.grip)return;for(const object of [this.grip.clone,this.grip.halo,this.grip.line])if(object){this.scene.remove(object);disposeTree(object,this.sharedMaterials);}this.grip=null;this.invalidate();}
  emit(type,hit,event,delta){this.callback?.({type,...hit,screen:this.eventScreen(event),...(delta?{delta}:{} )});}
  bindPointers(){
    const canvas=this.renderer.domElement,on=(type,handler,options)=>{canvas.addEventListener(type,handler,options);this.listeners.push([type,handler,options]);};
    on('contextmenu',event=>event.preventDefault());on('webglcontextrestored',()=>this.invalidate());
    on('pointerdown',event=>{this._cameraTween=null;canvas.setPointerCapture(event.pointerId);const hit=this.pick(event),screen=this.eventScreen(event);this.drag={hit,start:screen,last:screen,orbit:event.button===2||event.altKey||!hit,moved:false};if(!this.drag.orbit){this.emit('select',hit,event);this.drag.plane=new THREE.Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()),new THREE.Vector3(...hit.point));}});
    on('pointermove',event=>{
      const screen=this.eventScreen(event),drag=this.drag;if(!drag){const hit=this.pick(event),names={'guide-1':'导纱眼',tensioner:'张力器',feeder:'喂纱嘴',spindle:'纱筒座','thread-end':'牵出的纱线',handwheel:'手轮',sample:'试织样片',blank:'袜坯','toe-left':'左袜边夹具','toe-right':'右袜边夹具','sewing-pedal':'缝纫踏板','dye-vat':'染槽',board:'定型板','smooth-cuff':'拉平袜口','smooth-leg':'拉平袜身','smooth-foot':'拉平足部','steam-button':'蒸汽按钮',mannequin:'试穿腿模','yarn-nylon-fine':'细尼龙纱','yarn-nylon-stretch':'尼龙包覆弹力纱','yarn-reinforced':'加固尼龙纱'};canvas.style.cursor=hit?'pointer':'grab';canvas.title=names[hit?.objectId]||'';return;}const delta={x:screen.x-drag.last.x,y:screen.y-drag.last.y};drag.last=screen;
      if(drag.orbit){this.manualCamera=true;this.angle-=delta.x*.006;this.elevation=clamp(this.elevation+delta.y*.003,.2,2.4);this.invalidate();return;}
      if(!drag.moved&&Math.hypot(screen.x-drag.start.x,screen.y-drag.start.y)<3)return;
      if(!drag.moved){drag.moved=true;if(drag.hit.objectId==='sample'){drag.sampleObject=this.objects.get('sample').object;drag.samplePosition=drag.sampleObject.position.clone();}else if(drag.hit.objectId!=='handwheel')this.beginGrip(drag.hit);this.emit('drag-start',drag.hit,event);}
      const p=this.pointerRay(event).ray.intersectPlane(drag.plane,new THREE.Vector3());if(p)this.followGrip(p.toArray());
      if(drag.sampleObject){const extension=clamp(Math.abs(screen.x-drag.start.x)/180,0,1),ratio=(1+extension)/(1+this.state.sample.pull);drag.sampleObject.scale.x=ratio;drag.sampleObject.position.x=drag.samplePosition.x+.135*(extension-this.state.sample.pull)/2;this.invalidate();}
      this.emit('drag',{...drag.hit,point:p?.toArray()||drag.hit.point},event,delta);
    });
    const end=event=>{if(!this.drag)return;const drag=this.drag;this.drag=null;this.endGrip();if(drag.sampleObject){drag.sampleObject.scale.x=1;drag.sampleObject.position.copy(drag.samplePosition);this.invalidate();}if(!drag.orbit)this.emit(drag.moved?'drag-end':'activate',drag.hit,event);};on('pointerup',end);on('pointercancel',end);on('lostpointercapture',end);
    on('wheel',event=>{event.preventDefault();this._cameraTween=null;this.manualCamera=true;this.distance=clamp(this.distance+event.deltaY*.002,1.0,5.5);this.invalidate();},{passive:false});
  }
  dispose(){
    if(this._disposed)return;this.endGrip();this._disposed=true;this.props.dispose();this.resizeObserver.disconnect();for(const [type,handler,options]of this.listeners)this.renderer.domElement.removeEventListener(type,handler,options);disposeTree(this.scene,this.sharedMaterials);for(const material of this.sharedMaterials)material.dispose();for(const texture of this.textures)texture.dispose();this.objects.clear();this.renderer.dispose();this.renderer.forceContextLoss();this.renderer.domElement.remove();
  }
}
