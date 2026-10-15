import * as THREE from './vendor/three.module.js';

const TAU=Math.PI*2;
const clamp=value=>Math.max(0,Math.min(1,value));

/** Original, deterministic workshop dressing. These parts are visual machinery,
 * not a manufacturing model or an additional cloth solver. No timers are owned
 * here: the caller supplies motion channels and decides when to draw. */
export function createWorkshopProps({materials={}}={}){
  const group=new THREE.Group();group.name='workshop-props';
  const ownedGeometries=new Set(),ownedMaterials=new Set(),ownedTextures=new Set(),cache=new Map();
  let disposed=false,station=null,lastMotion=null;
  const geometry=(key,build)=>{if(!cache.has(key)){const result=build();ownedGeometries.add(result);cache.set(key,result);}return cache.get(key);};
  const material=options=>{const result=new THREE.MeshStandardMaterial(options);ownedMaterials.add(result);return result;};
  const ownTexture=result=>{ownedTextures.add(result);return result;};
  function grain(kind){
    const size=64,data=new Uint8Array(size*size*4);
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const noise=(Math.sin(x*127.1+y*311.7)*43758.5453)%1,wave=kind==='wood'?Math.sin(y*.72+Math.sin(x*.09)*1.6)*12:kind==='cloth'?Math.cos(x*Math.PI)*8+Math.cos(y*Math.PI)*7:noise*7;
      const base=kind==='wood'?194:kind==='cloth'?226:239,k=(y*size+x)*4;data[k]=data[k+1]=data[k+2]=Math.max(0,Math.min(255,base+wave+noise*3));data[k+3]=255;
    }
    const result=ownTexture(new THREE.DataTexture(data,size,size));result.needsUpdate=true;result.wrapS=result.wrapT=THREE.RepeatWrapping;result.repeat.set(kind==='wood'?3:5,kind==='wood'?1:5);return result;
  }
  const woodMap=materials.wood?null:grain('wood'),paintMap=materials.paint?null:grain('paint'),clothMap=materials.cloth?null:grain('cloth');
  const m={
    steel:materials.steel||material({color:'#a7aba3',metalness:.89,roughness:.31}),
    dark:materials.dark||material({color:'#303b35',metalness:.58,roughness:.55}),
    paint:materials.paint||material({color:'#466252',map:paintMap,bumpMap:paintMap,bumpScale:.00009,metalness:.36,roughness:.51}),
    brass:materials.brass||material({color:'#ad8a4c',metalness:.75,roughness:.38}),
    wood:materials.wood||material({color:'#c0aa84',map:woodMap,bumpMap:woodMap,bumpScale:.0002,roughness:.66}),
    rubber:materials.rubber||material({color:'#272c29',roughness:.92}),
    paper:materials.paper||material({color:'#ede5d2',roughness:.9,side:THREE.DoubleSide}),
    cloth:materials.cloth||material({color:'#baaa92',map:clothMap,bumpMap:clothMap,bumpScale:.0002,roughness:.86}),
    plaster:material({color:'#c9c9bc',roughness:.94}),
    glass:material({color:'#c5d6ce',transparent:true,opacity:.24,roughness:.25,metalness:.08,depthWrite:false}),
  };
  function node(name,parent=group,position=[0,0,0]){const result=new THREE.Group();result.name=name;result.position.fromArray(position);parent.add(result);return result;}
  function mesh(parent,g,mat,position=[0,0,0],rotation=[0,0,0]){
    const result=new THREE.Mesh(g,mat);result.position.fromArray(position);result.rotation.set(...rotation);result.castShadow=!mat.transparent;result.receiveShadow=true;parent.add(result);return result;
  }
  const box=(parent,size,mat,position,rotation)=>mesh(parent,geometry(`box:${size}`,()=>new THREE.BoxGeometry(...size)),mat,position,rotation);
  const cylinder=(parent,radius,height,mat,position,rotation=[0,0,0],segments=24)=>mesh(parent,geometry(`cylinder:${radius}:${height}:${segments}`,()=>new THREE.CylinderGeometry(radius,radius,height,segments)),mat,position,rotation);
  const ring=(parent,radius,tube,mat,position,rotation=[0,0,0])=>mesh(parent,geometry(`torus:${radius}:${tube}`,()=>new THREE.TorusGeometry(radius,tube,6,36)),mat,position,rotation);
  function pipe(parent,points,radius,mat){const key=`pipe:${radius}:${points}`;return mesh(parent,geometry(key,()=>new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),Math.max(12,points.length*8),radius,6,false)),mat);}
  function instances(parent,name,g,mat,transforms){
    const result=new THREE.InstancedMesh(g,mat,transforms.length),dummy=new THREE.Object3D();result.name=name;result.castShadow=true;result.receiveShadow=true;
    transforms.forEach((transform,i)=>{dummy.position.fromArray(transform.position||[0,0,0]);dummy.rotation.set(...(transform.rotation||[0,0,0]));dummy.scale.fromArray(transform.scale||[1,1,1]);dummy.updateMatrix();result.setMatrixAt(i,dummy.matrix);});result.instanceMatrix.needsUpdate=true;parent.add(result);return result;
  }
  function label(parent,text,width,height,position,rotation=[0,0,0]){
    let map;
    if(globalThis.document?.createElement){
      const canvas=document.createElement('canvas');canvas.width=256;canvas.height=64;const ctx=canvas.getContext('2d');
      if(ctx){ctx.fillStyle='#e7dfc9';ctx.fillRect(0,0,256,64);ctx.strokeStyle='#625b47';ctx.lineWidth=2;ctx.strokeRect(4,4,248,56);ctx.fillStyle='#4a5145';ctx.font='600 24px monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,128,34);map=ownTexture(new THREE.CanvasTexture(canvas));map.colorSpace=THREE.SRGBColorSpace;}
    }
    if(!map){map=ownTexture(new THREE.DataTexture(new Uint8Array([231,223,201,255]),1,1));map.needsUpdate=true;}
    const mat=material({map,roughness:.85,side:THREE.DoubleSide}),result=mesh(parent,geometry(`label:${width}:${height}`,()=>new THREE.PlaneGeometry(width,height)),mat,position,rotation);result.name=`label:${text}`;result.castShadow=false;return result;
  }
  const unitBox=geometry('unit-box',()=>new THREE.BoxGeometry(1,1,1));
  const screwGeometry=geometry('screw',()=>new THREE.CylinderGeometry(.0033,.0033,.003,6));
  function gear(parent,radius,teeth,position){
    const g=geometry(`gear:${radius}:${teeth}`,()=>{
      const outline=new THREE.Shape();for(let i=0;i<teeth*4;i++){const angle=i*TAU/(teeth*4),r=radius*(i%4===1||i%4===2?1:.88),x=Math.sin(angle)*r,y=Math.cos(angle)*r;if(i)outline.lineTo(x,y);else outline.moveTo(x,y);}outline.closePath();const hole=new THREE.Path();hole.absarc(0,0,radius*.22,0,TAU,true);outline.holes.push(hole);return new THREE.ExtrudeGeometry(outline,{depth:.009,bevelEnabled:true,bevelSegments:1,bevelSize:.0006,bevelThickness:.0006,curveSegments:8});
    });return mesh(parent,g,m.brass,position);
  }

  // The front sector stays open. Neither this shell nor its cam rises through
  // the old needle bed, feeder, yarn guides or handwheel's working face.
  const machine=node('circular-machine-details',group,[-.12,.98,.16]);
  const shell=mesh(machine,geometry('open-machine-shell',()=>new THREE.CylinderGeometry(.184,.192,.12,48,1,true,.78,TAU-1.56)),m.paint,[0,-.115,0]);shell.name='open-service-window';
  mesh(machine,geometry('machine-top-lip',()=>new THREE.RingGeometry(.158,.185,48,1,.78,TAU-1.56)),m.steel,[0,-.054,0],[-Math.PI/2,0,0]);
  for(const x of [-.15,.15]){box(machine,[.026,.19,.055],m.paint,[x,-.205,-.07]);box(machine,[.073,.019,.095],m.dark,[x,-.298,-.07]);}
  box(machine,[.28,.095,.025],m.paint,[0,-.22,-.13]);label(machine,'CIRCULAR / 04',.14,.027,[0,-.10,.183]);
  const driveGear=gear(machine,.053,22,[-.145,-.105,.10]),idler=gear(machine,.032,14,[-.077,-.163,.095]);
  cylinder(machine,.008,.063,m.steel,[-.145,-.105,.118],[Math.PI/2,0,0]);
  const pulley=node('belt-pulley',machine,[.145,-.12,.092]);
  for(const z of [-.008,.008])cylinder(pulley,.041,.006,m.dark,[0,0,z],[Math.PI/2,0,0]);ring(pulley,.035,.003,m.rubber,[0,0,0]);box(pulley,[.054,.006,.012],m.brass);
  pipe(machine,[[.145,-.083,.094],[.178,-.112,.094],[.158,-.245,.094],[.125,-.26,.094],[.112,-.125,.094],[.145,-.083,.094]],.0025,m.rubber);
  const rollers=node('take-up-rollers',machine,[0,-.23,-.025]);
  for(const x of [-.15,.15]){const roller=node('take-up-roller',rollers,[x,0,0]);cylinder(roller,.019,.075,m.rubber,[0,0,0],[0,0,Math.PI/2]);for(const sign of [-1,1])cylinder(roller,.022,.006,m.steel,[sign*.041,0,0],[0,0,Math.PI/2]);}
  const cam=node('needle-cam',machine,[0,-.026,-.14]);box(cam,[.075,.012,.031],m.brass,[0,0,0],[0,0,.07]);for(const x of [-.025,.025])cylinder(cam,.009,.014,m.steel,[x,.01,.005],[Math.PI/2,0,0]);
  const feeder=node('feeder-bracket',machine,[.085,.038,-.04]);box(feeder,[.013,.08,.016],m.paint,[0,0,0],[0,0,-.18]);pipe(feeder,[[0,.035,0],[-.035,.058,.01],[-.062,.058,.02]],.003,m.brass);
  const screwTransforms=Array.from({length:32},(_,i)=>{const angle=.80+i*(TAU-1.60)/31;return {position:[Math.sin(angle)*.171,-.051,Math.cos(angle)*.171]};});instances(machine,'machine-fasteners',screwGeometry,m.steel,screwTransforms);
  instances(machine,'bed-scale',unitBox,m.paper,Array.from({length:40},(_,i)=>{const angle=i*TAU/40;return {position:[Math.sin(angle)*.152,-.045,Math.cos(angle)*.152],rotation:[0,angle,0],scale:[.001,.001,i%5===0?.011:.005]};}));

  // A compact C-arm leaves both existing fabric clamps reachable from front.
  const seam=node('seam-head',group,[.38,.98,.49]);
  box(seam,[.055,.19,.055],m.paint,[.102,.092,-.095]);box(seam,[.145,.058,.065],m.paint,[.042,.17,-.075]);
  cylinder(seam,.022,.041,m.steel,[-.025,.142,-.055]);ring(seam,.023,.003,m.brass,[-.025,.17,-.042],[Math.PI/2,0,0]);
  const needle=node('sewing-needle',seam,[-.025,.038,-.045]);needle.userData.restY=needle.position.y;cylinder(needle,.0013,.065,m.steel,[0,.028,0],[0,0,0],12);ring(needle,.0025,.0007,m.dark,[0,0,0]);
  const presser=node('presser-foot',seam,[-.025,.013,-.044]);presser.userData.restY=presser.position.y;
  box(presser,[.025,.004,.022],m.steel,[0,0,0]);box(presser,[.004,.05,.006],m.steel,[.010,.025,-.006]);
  pipe(seam,[[.100,.10,-.13],[.02,.205,-.13],[-.025,.20,-.05],[-.025,.07,-.045]],.0009,m.cloth);
  const feedWheel=node('seam-feed-wheel',seam,[.108,.09,-.05]);cylinder(feedWheel,.035,.015,m.dark,[0,0,0],[Math.PI/2,0,0]);box(feedWheel,[.054,.004,.017],m.brass);
  cylinder(seam,.019,.065,m.rubber,[0,-.035,-.015],[0,0,Math.PI/2]);label(seam,'LINK / ALIGN',.09,.020,[.040,.173,-.040]);
  instances(seam,'head-fasteners',screwGeometry,m.steel,[[-.02,.20,-.07],[.06,.20,-.07],[.10,.19,-.095],[.10,.01,-.095]].map(position=>({position})));

  const vat=node('dye-process-details',group,[.72,.06,.66]);
  const gauge=node('dye-gauge',vat,[.185,.67,-.09]);
  cylinder(gauge,.029,.016,m.dark,[0,0,0],[Math.PI/2,0,0]);mesh(gauge,geometry('gauge-face',()=>new THREE.CircleGeometry(.025,32)),m.paper,[0,0,.009]);ring(gauge,.027,.002,m.steel,[0,0,.010]);
  const gaugeNeedle=box(gauge,[.0013,.020,.001],m.dark,[0,.006,.012],[0,0,-.8]);
  instances(gauge,'gauge-scale',unitBox,m.dark,Array.from({length:11},(_,i)=>{const a=-2.3+i*.46;return {position:[Math.sin(a)*.020,Math.cos(a)*.020,.011],rotation:[0,0,-a],scale:[.001,.004,.001]};}));
  pipe(vat,[[.18,.63,-.09],[.19,.43,-.11],[.15,.13,-.10],[.10,.10,-.12]],.006,m.steel);cylinder(vat,.031,.11,m.paint,[.195,.14,-.105]);
  pipe(vat,[[.21,.15,-.11],[.24,.28,-.10],[.20,.48,-.08],[.12,.68,-.03]],.005,m.dark);ring(vat,.019,.003,m.brass,[.19,.44,-.10],[Math.PI/2,0,0]);
  label(vat,'DYE / RINSE',.09,.022,[.185,.57,-.075]);
  const surface=node('dye-surface-overlay',vat,[0,.691,0]);
  const rippleMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,uniforms:{time:{value:0},amplitude:{value:0},dyeMix:{value:0}},vertexShader:'varying vec2 p; void main(){p=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:'varying vec2 p;uniform float time;uniform float amplitude;uniform float dyeMix;void main(){float r=length(p);float wave=pow(.5+.5*sin(170.*r-3.5*time+sin(p.x*48.+time)),12.);float edge=1.-smoothstep(.11,.14,r);vec3 tint=mix(vec3(.87,.82,.71),vec3(.48,.38,.42),dyeMix);gl_FragColor=vec4(tint,wave*edge*amplitude*.25);}'});ownedMaterials.add(rippleMaterial);
  const ripple=mesh(surface,geometry('dye-ripple-disc',()=>new THREE.CircleGeometry(.138,48)),rippleMaterial,[0,0,0],[-Math.PI/2,0,0]);ripple.castShadow=false;ripple.receiveShadow=false;ripple.visible=false;
  const steamTextureData=new Uint8Array(32*32*4);for(let y=0;y<32;y++)for(let x=0;x<32;x++){const k=(y*32+x)*4,r=Math.hypot((x-15.5)/16,(y-15.5)/16);steamTextureData[k]=steamTextureData[k+1]=steamTextureData[k+2]=255;steamTextureData[k+3]=Math.round(Math.max(0,1-r)**2*210);}
  const steamMap=ownTexture(new THREE.DataTexture(steamTextureData,32,32));steamMap.needsUpdate=true;
  const steamMaterial=new THREE.PointsMaterial({color:'#edf0e7',size:.075,map:steamMap,transparent:true,opacity:0,depthWrite:false,sizeAttenuation:true});ownedMaterials.add(steamMaterial);
  const steamGeometry=geometry('steam-particles',()=>{const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(40*3),3));return g;}),steam=new THREE.Points(steamGeometry,steamMaterial);steam.position.set(.61,1.13,-.18);steam.name='boarding-steam';steam.frustumCulled=false;steam.visible=false;group.add(steam);

  const tools=node('textile-tools');
  const scissors=node('tailor-scissors',tools,[-.87,.858,.06]);scissors.rotation.x=-Math.PI/2;scissors.rotation.z=-.4;
  for(const side of [-1,1]){const blade=node('scissor-blade',scissors);blade.rotation.z=side*.16;box(blade,[.009,.10,.0025],m.steel,[0,.028,0]);ring(blade,.016,.003,m.dark,[side*.008,-.052,0]);}cylinder(scissors,.004,.006,m.brass,[0,0,.002],[Math.PI/2,0,0],12);
  const snips=node('thread-snips',tools,[-.56,.858,.026]);snips.rotation.x=-Math.PI/2;for(const side of [-1,1]){box(snips,[.004,.072,.003],m.steel,[side*.008,0,0],[0,0,side*.13]);box(snips,[.010,.035,.006],m.paint,[side*.011,-.026,0],[0,0,side*.13]);}ring(snips,.010,.002,m.steel,[0,-.043,0]);
  const tape=node('measuring-tape',tools,[-.85,.860,.28]);cylinder(tape,.030,.012,m.paper,[0,.008,0]);cylinder(tape,.010,.014,m.brass,[0,.008,0]);box(tape,[.20,.0015,.025],m.paper,[.13,0,0]);
  instances(tape,'tape-scale',unitBox,m.dark,Array.from({length:40},(_,i)=>({position:[.032+i*.0048,.0015,.007],scale:[.00065,.0007,i%5===0?.011:.005]})));
  const caliper=node('caliper',tools,[.82,.860,-.32]);caliper.rotation.y=.25;box(caliper,[.18,.005,.012],m.steel);for(const x of [-.08,-.012]){box(caliper,[.008,.006,.045],m.steel,[x,.001,.017]);box(caliper,[.026,.012,.020],m.dark,[x,.006,-.003]);}
  instances(caliper,'caliper-scale',unitBox,m.dark,Array.from({length:23},(_,i)=>({position:[-.073+i*.0065,.003,.002],scale:[.0005,.0004,.005]})));
  const brush=node('finishing-brush',tools,[.80,.860,.10]);brush.rotation.y=-.6;box(brush,[.075,.012,.028],m.wood);box(brush,[.065,.008,.012],m.wood,[-.055,0,0]);
  instances(brush,'brush-bristles',unitBox,m.cloth,Array.from({length:36},(_,i)=>({position:[-.031+(i%9)*.0078,.015,-.009+Math.floor(i/9)*.006],scale:[.002,.020,.002]})));
  const swatches=node('labelled-yarn-swatches',tools,[.85,.857,-.13]);
  for(const [i,color]of ['#d9c7ab','#9d8c78','#5a4845','#46424c'].entries()){const mat=material({color,roughness:.88,map:clothMap||null});box(swatches,[.056,.001,.045],mat,[0,i*.002,i*.022],[0,(i-1.5)*.07,0]);}
  label(swatches,'NY / 03',.041,.012,[0,.009,-.01],[-Math.PI/2,0,0]);
  label(tools,'SAMPLE / NOTES',.12,.033,[-.76,.854,-.10],[-Math.PI/2,0,0]);

  // Storage is kept against the rear wall, distinct from the three selectable
  // inventory spools on the worktop. It never joins the interaction registry.
  const room=node('workshop-room');
  box(room,[3.5,2.35,.035],m.plaster,[0,1.1,-.76]);box(room,[3.5,.07,.045],m.wood,[0,.035,-.724]);
  instances(room,'wall-slats',unitBox,m.wood,Array.from({length:9},(_,i)=>({position:[-1.6+i*.4,1.1,-.736],scale:[.022,2.2,.012]})));
  const shelving=node('yarn-shelf',room,[-1.02,1.30,-.55]);
  for(const y of [0,.31]){box(shelving,[.67,.025,.22],m.wood,[0,y,0]);for(const x of [-.28,.28])box(shelving,[.018,.09,.16],m.dark,[x,y-.04,-.015],[0,0,.10]);}
  const shelfYarn=instances(shelving,'stored-yarn',geometry('stored-yarn-cylinder',()=>new THREE.CylinderGeometry(.040,.044,.14,20)),m.cloth,Array.from({length:12},(_,i)=>({position:[-.25+(i%6)*.10,.085+Math.floor(i/6)*.31,0]})));
  const yarnColors=['#c9b79a','#b2aa94','#62705c','#544440','#a2a6a0','#b9aa80'];for(let i=0;i<12;i++)shelfYarn.setColorAt(i,new THREE.Color(yarnColors[i%6]));shelfYarn.instanceColor.needsUpdate=true;
  instances(shelving,'stored-yarn-cores',geometry('stored-yarn-core',()=>new THREE.CylinderGeometry(.010,.010,.17,12)),m.paper,Array.from({length:12},(_,i)=>({position:[-.25+(i%6)*.10,.085+Math.floor(i/6)*.31,0]})));
  label(shelving,'YARN / MATERIALS',.30,.040,[0,-.009,.113]);
  box(room,[.75,.52,.018],m.wood,[.65,1.41,-.72]);
  instances(room,'pegboard-rows',geometry('peg-hole',()=>new THREE.CircleGeometry(.0018,6)),m.dark,Array.from({length:120},(_,i)=>({position:[.32+(i%15)*.047,1.20+Math.floor(i/15)*.056,-.708]})));
  pipe(room,[[.40,1.55,-.68],[.40,1.48,-.66],[.40,1.42,-.66]],.002,m.brass);ring(room,.042,.003,m.steel,[.40,1.40,-.66]);
  box(room,[.16,.035,.13],m.paper,[.78,1.22,-.635]);label(room,'PATTERNS',.13,.024,[.78,1.23,-.566]);
  const workLamp=node('task-lamp',room,[-.94,1.45,-.55]);
  cylinder(workLamp,.025,.022,m.dark,[0,0,0],[Math.PI/2,0,0]);pipe(workLamp,[[0,0,0],[.02,.18,.04],[.12,.13,.30]],.007,m.dark);
  mesh(workLamp,geometry('task-lamp-shade',()=>new THREE.ConeGeometry(.065,.09,24,1,true)),m.paint,[.12,.098,.30]);
  const bulbMaterial=material({color:'#fff3d3',emissive:'#ffe5aa',emissiveIntensity:1.5,roughness:.4});mesh(workLamp,geometry('lamp-diffuser',()=>new THREE.CircleGeometry(.055,24)),bulbMaterial,[.12,.053,.30],[-Math.PI/2,0,0]);
  const taskLight=new THREE.PointLight('#ffe9c3',.30,1.25,2);taskLight.position.set(.12,.04,.30);workLamp.add(taskLight);
  const wearBackdrop=node('independent-display');wearBackdrop.visible=false;
  box(wearBackdrop,[1.0,1.65,.025],m.plaster,[-.91,.80,.10]);cylinder(wearBackdrop,.17,.075,m.dark,[-.91,.034,.75],[0,0,0],48);cylinder(wearBackdrop,.172,.004,m.brass,[-.91,.073,.75],[0,0,0],48);
  const displayLight=new THREE.DirectionalLight('#f8efdd',.42);displayLight.position.set(-1.6,2,1.6);displayLight.target.position.set(-.91,.7,.75);wearBackdrop.add(displayLight,displayLight.target);

  const refs={machine:{root:machine,driveGear,idler,pulley,rollers,cam,feeder,shell},seam:{root:seam,needle,presser,feedWheel},vat:{root:vat,surface,ripple,steam,gauge,gaugeNeedle},tools,room:{root:room,workLamp,wearBackdrop}};
  function setStation(next){
    if(disposed||next===station)return false;station=next;const wear=next==='wear';for(const object of [machine,seam,vat,tools,room,workLamp])object.visible=!wear;wearBackdrop.visible=wear;steam.visible=!wear&&(lastMotion?.steam||0)>0;return true;
  }
  const motionKeys=['wheelAngle','spindleAngle','feedPhase','sewingNeedle','sewingWheel','dyeRipple','dyeMix','steam','heatGlow'];
  function applyMotion(channels={},timeSec=0){
    if(disposed)return false;if(!Number.isFinite(timeSec))throw new TypeError('Motion time must be finite');
    const values={};for(const key of motionKeys){const value=channels[key]??0;if(!Number.isFinite(value))throw new TypeError(`Motion ${key} must be finite`);values[key]=key.endsWith('Angle')||key==='sewingWheel'?value:clamp(value);}
    const animated=values.dyeRipple>0||values.steam>0,signature=motionKeys.map(key=>values[key]);if(animated)signature.push(timeSec);
    if(lastMotion&&signature.length===lastMotion.signature.length&&signature.every((value,i)=>value===lastMotion.signature[i]))return false;
    driveGear.rotation.z=-values.wheelAngle;idler.rotation.z=values.wheelAngle*22/14;pulley.rotation.z=values.spindleAngle;
    for(const roller of rollers.children)roller.rotation.x=values.feedPhase*TAU;
    cam.rotation.z=Math.sin(values.feedPhase*TAU)*.03;needle.position.y=needle.userData.restY+.026*values.sewingNeedle;presser.position.y=presser.userData.restY+.002*values.sewingNeedle;feedWheel.rotation.z=values.sewingWheel;
    ripple.visible=values.dyeRipple>0;rippleMaterial.uniforms.amplitude.value=values.dyeRipple;rippleMaterial.uniforms.time.value=timeSec;rippleMaterial.uniforms.dyeMix.value=values.dyeMix;
    gaugeNeedle.rotation.z=-.8+values.dyeMix*1.6;
    steam.visible=station!=='wear'&&values.steam>0;steamMaterial.opacity=.32*values.steam;
    if(values.steam>0){const positions=steamGeometry.attributes.position;for(let i=0;i<positions.count;i++){const life=((i/positions.count+timeSec*.35)%1+1)%1;positions.setXYZ(i,Math.sin(i*2.4+life*4)*(.035+life*.05),life*.52,Math.cos(i*1.7+life*3)*(.025+life*.04));}positions.needsUpdate=true;}
    bulbMaterial.emissiveIntensity=1.5+values.heatGlow*.12;lastMotion={...values,signature};return true;
  }
  function dispose(){if(disposed)return;disposed=true;group.removeFromParent();for(const g of ownedGeometries)g.dispose();for(const mat of ownedMaterials)mat.dispose();for(const map of ownedTextures)map.dispose();}
  const stats={get disposed(){return disposed;},get geometries(){return ownedGeometries.size;},get materials(){return ownedMaterials.size;},get textures(){return ownedTextures.size;},get drawCalls(){let n=0;group.traverse(object=>{if(object.isMesh||object.isPoints)n++;});return n;},get triangles(){let n=0;group.traverse(object=>{if(object.isMesh){const g=object.geometry;n+=(g.index?g.index.count:g.attributes.position.count)/3*(object.isInstancedMesh?object.count:1);}});return n;},get instances(){let n=0;group.traverse(object=>{if(object.isInstancedMesh)n+=object.count;});return n;}};
  applyMotion({},0);return {group,refs,setStation,applyMotion,dispose,stats:Object.freeze(stats)};
}
