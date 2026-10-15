import {createTube} from './physics.mjs';

// Dimensions describe natural garment geometry in metres. The mannequin has
// separate dimensions so changing a garment size changes its fit and strain.
export const DEFAULT_DIMENSIONS = Object.freeze({footLength: 0.24, footWidth: 0.084, heelDepth: 0.052,
  ankleCircumference: 0.205, calfCircumference: 0.34, thighCircumference: 0.47,
  stockingLength: 0.78, cuffHeight: 0.045});
export const DEFAULT_BODY_DIMENSIONS = Object.freeze({footLength: 0.255, footWidth: 0.09, heelDepth: 0.058,
  ankleCircumference: 0.22, calfCircumference: 0.365, thighCircumference: 0.52,
  stockingLength: 0.84, cuffHeight: 0.045});
// Solver clearances, not measured fabric thickness or calibrated fit ease.
export const NUMERICAL_STANDOFF=Object.freeze({fitting:.003,contact:.001,calibrated:false});
export const STOCKING_REGIONS = Object.freeze([
  {name: 'toe', v0: 0, v1: 0.055}, {name: 'foot', v0: 0.055, v1: 0.22},
  {name: 'heel', v0: 0.22, v1: 0.31}, {name: 'ankle', v0: 0.31, v1: 0.39},
  {name: 'calf', v0: 0.39, v1: 0.63}, {name: 'knee', v0: 0.63, v1: 0.72},
  {name: 'thigh', v0: 0.72, v1: 0.93}, {name: 'cuff', v0: 0.93, v1: 1}
].map(Object.freeze));
const BOUNDS = {footLength: [0.18, 0.34], footWidth: [0.06, 0.14], heelDepth: [0.035, 0.1],
  ankleCircumference: [0.15, 0.34], calfCircumference: [0.22, 0.58], thighCircumference: [0.3, 0.85],
  stockingLength: [0.45, 1.1], cuffHeight: [0.015, 0.12]};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = t => t * t * (3 - 2 * t);
const distance = (p, a, b) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);

export function normalizeDimensions(values = {}, defaults = DEFAULT_DIMENSIONS) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('Invalid dimensions');
  const dimensions = {...defaults, ...values};
  for (const [key, [low, high]] of Object.entries(BOUNDS)) {
    if (!Number.isFinite(dimensions[key]) || dimensions[key] < low || dimensions[key] > high) throw new RangeError(`Invalid dimension ${key}`);
  }
  if (dimensions.cuffHeight > dimensions.stockingLength * 0.18) throw new RangeError('Cuff dimension exceeds stocking length');
  return dimensions;
}

function checkPose(pose) {
  if (!Number.isFinite(pose) || pose < 0 || pose > 55) throw new RangeError('Pose must be a finite angle from 0 to 55 degrees');
}
function ellipse(circumference, ratio = 0.9) {
  const factor = Math.PI * (3 * (1 + ratio) - Math.sqrt((3 + ratio) * (1 + 3 * ratio)));
  return [circumference / factor, circumference / factor * ratio];
}
function profile(d) {
  const top = 0.06 + d.stockingLength, span = top - 0.14;
  // A heel turn needs a centreline bend radius larger than the section depth;
  // otherwise a swept tube folds through itself on the inside of the ankle.
  const turnRadius = Math.max(0.06, d.heelDepth * 1.5);
  const turn = v => {
    const angle = smooth(clamp((v - 0.2) / 0.16, 0, 1)) * Math.PI / 2;
    return [0.067 + turnRadius * (1 - Math.cos(angle)), turnRadius * (1 - Math.sin(angle))];
  };
  const ankle = ellipse(d.ankleCircumference), calf = ellipse(d.calfCircumference), thigh = ellipse(d.thighCircumference);
  const knee = ellipse(Math.min(d.calfCircumference * 0.89, d.thighCircumference * 0.73));
  const knots = [
    [0, 0.067, d.footLength - 0.06, 0.012, 0.014],
    [0.055, 0.069, d.footLength - 0.078, d.footWidth * 0.38, 0.022],
    [0.16, 0.067, Math.max(d.footLength * 0.43, turnRadius + 0.012), d.footWidth * 0.5, 0.028],
    [0.2, ...turn(0.2), d.footWidth * 0.46, d.heelDepth * 0.68],
    [0.24, ...turn(0.24), d.footWidth * 0.43, d.heelDepth * 0.78],
    [0.29, ...turn(0.29), d.footWidth * 0.42, d.heelDepth],
    [0.36, ...turn(0.36), ...ankle],
    [0.5, 0.14 + span * 0.28, 0.005, calf[0] * 0.95, calf[1] * 0.95],
    [0.6, 0.14 + span * 0.45, 0.004, ...calf],
    [0.69, 0.14 + span * 0.61, 0, ...knee],
    [0.82, 0.14 + span * 0.82, 0, ...thigh],
    [0.93, top - d.cuffHeight, 0, thigh[0] * 0.97, thigh[1] * 0.97],
    [1, top, 0, thigh[0] * 0.94, thigh[1] * 0.94]
  ];
  knots.turnRadius = turnRadius;
  return knots;
}
function evaluate(v, knots) {
  let i = 0;
  while (i < knots.length - 2 && knots[i + 1][0] < v) i++;
  const a = knots[i], b = knots[i + 1], before = knots[Math.max(0, i - 1)], after = knots[Math.min(knots.length - 1, i + 2)];
  const h = b[0] - a[0], t = clamp((v - a[0]) / h, 0, 1), t2 = t * t, t3 = t2 * t;
  const result = [1, 2, 3, 4].map(k => {
    const ma = (b[k] - before[k]) / (b[0] - before[0]);
    const mb = (after[k] - a[k]) / (after[0] - a[0]);
    const value = (2 * t3 - 3 * t2 + 1) * a[k] + (t3 - 2 * t2 + t) * h * ma + (-2 * t3 + 3 * t2) * b[k] + (t3 - t2) * h * mb;
    return clamp(value, Math.min(a[k], b[k]), Math.max(a[k], b[k]));
  });
  if (v >= 0.2 && v <= 0.36) {
    const angle = smooth((v - 0.2) / 0.16) * Math.PI / 2;
    result[0] = 0.067 + knots.turnRadius * (1 - Math.cos(angle));
    result[1] = knots.turnRadius * (1 - Math.sin(angle));
  }
  return result;
}
function posedCenter(v, knots, pose) {
  const [y, z] = evaluate(v, knots), [ky] = evaluate(0.69, knots);
  const angle = pose * Math.PI / 180 * (1 - smooth(clamp((v - 0.58) / 0.22, 0, 1)));
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return [ky + (y - ky) * cos + z * sin, -(y - ky) * sin + z * cos];
}
function frame(v, knots, pose) {
  const q = evaluate(v, knots), center = posedCenter(v, knots, pose);
  const a = posedCenter(Math.max(0, v - 0.00001), knots, pose), b = posedCenter(Math.min(1, v + 0.00001), knots, pose);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ty = (b[0] - a[0]) / length, tz = (b[1] - a[1]) / length;
  return {x: 0.12, y: center[0], z: center[1], rx: q[2], rn: q[3], ty, tz, ny: -tz, nz: ty};
}
function sample(u, f, margin = 0) {
  const angle = u * Math.PI * 2, sin = Math.sin(angle), cos = Math.cos(angle);
  const nx = sin / f.rx, nr = cos / f.rn, length = Math.hypot(nx, nr);
  return [f.x + sin * f.rx + margin * nx / length,
    f.y + cos * f.rn * f.ny + margin * nr / length * f.ny,
    f.z + cos * f.rn * f.nz + margin * nr / length * f.nz];
}
function checkUV(u, v) {
  if (!Number.isFinite(u) || !Number.isFinite(v) || v < 0 || v > 1) throw new RangeError('Surface UV must be finite with V in [0,1]');
}
export function stockingSurface(u, v, dimensions = DEFAULT_DIMENSIONS) {
  checkUV(u, v);
  return sample(u, frame(v, profile(normalizeDimensions(dimensions)), 0));
}
export function bodyFrame(v, {pose = 0, dimensions = DEFAULT_BODY_DIMENSIONS} = {}) {
  checkPose(pose); checkUV(0, v);
  return frame(v, profile(normalizeDimensions(dimensions, DEFAULT_BODY_DIMENSIONS)), pose);
}
export function bodySurface(u, v, {pose = 0, dimensions = DEFAULT_BODY_DIMENSIONS, margin = 0} = {}) {
  checkPose(pose); checkUV(u, v);
  if (!Number.isFinite(margin) || margin < 0 || margin > 0.03) throw new RangeError('Invalid body margin');
  return sample(u, frame(v, profile(normalizeDimensions(dimensions, DEFAULT_BODY_DIMENSIONS)), pose), margin);
}
export function stockingRegion(v) { return STOCKING_REGIONS.find(r => v >= r.v0 && v <= r.v1)?.name || 'cuff'; }

function cap(indices, cols, row, reverse) {
  const base = row * cols;
  for (let col = 1; col < cols - 1; col++) indices.push(base, base + col + (reverse ? 1 : 0), base + col + (reverse ? 0 : 1));
}
function checkResolution(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 12 || cols > 80 || rows < 20 || rows > 96) throw new RangeError('Stocking resolution outside supported range');
}
export function createStocking({cols = 40, rows = 48, dimensions = DEFAULT_DIMENSIONS} = {}) {
  checkResolution(cols, rows);
  const d = normalizeDimensions(dimensions), knots = profile(d);
  const model = createTube({cols, rows, height: 1, radius: 0.1});
  model.kind = 'stocking'; model.gridVertexCount = cols * rows;
  for (let row = 0; row < rows; row++) {
    const f = frame(row / (rows - 1), knots, 0);
    for (let col = 0; col < cols; col++) model.positions.set(sample(col / cols, f), (row * cols + col) * 3);
  }
  // A free centre particle gives the closed toe an independent contact degree
  // of freedom. A perimeter-rooted disk can pass entirely through a foot while
  // all of its boundary vertices remain outside the contact surface.
  const toeCenter=cols*rows,toe=frame(0,knots,0),positions=[...model.positions,toe.x,toe.y,toe.z],uv=[...model.uv,.5,0];
  const nodes=[{index:toeCenter,id:'toe-center',u:.5,fraction:0}],rings=[];
  model.sourceVertices.push(0);model.vertexIds.push('toe-center');
  for(const [layer,fraction] of [.25,.5,.75].entries()){
    const count=Math.max(6,Math.round(cols*fraction)),ring=[];
    for(let col=0;col<count;col++){
      const u=col/count,index=positions.length/3,id=`toe-ring-${layer+1}-${col}`,outer=sample(u,toe);
      positions.push(toe.x+(outer[0]-toe.x)*fraction,toe.y+(outer[1]-toe.y)*fraction,toe.z+(outer[2]-toe.z)*fraction);uv.push(u,0);
      ring.push(index);nodes.push({index,id,u,fraction});model.sourceVertices.push(Math.round(u*cols)%cols);model.vertexIds.push(id);
    }
    rings.push(ring);
  }
  model.positions=Float64Array.from(positions);
  model.rest=Float64Array.from(model.positions);model.uv=Float64Array.from(uv);
  model.velocities=new Float64Array(model.positions.length);model.layout='edited-grid';
  model.metadata.toeCap={centerVertex:toeCenter,centerVertexId:'toe-center',ring:Array.from({length:cols},(_,i)=>i),
    vertices:nodes.map(node=>node.index),vertexIds:nodes.map(node=>node.id),nodes};
  const capStart=model.triangles.length,allRings=[Array.from({length:cols},(_,i)=>i),...rings.toReversed()];
  for(let layer=0;layer<allRings.length-1;layer++){
    const outer=allRings[layer],inner=allRings[layer+1];let a=0,b=0;
    while(a<outer.length||b<inner.length){
      const nextA=(a+1)/outer.length,nextB=(b+1)/inner.length;
      if(a<outer.length&&(b===inner.length||nextA<=nextB+1e-12)){model.triangles.push(outer[a%outer.length],inner[b%inner.length],outer[(a+1)%outer.length]);a++;}
      else {model.triangles.push(outer[a%outer.length],inner[b%inner.length],inner[(b+1)%inner.length]);b++;}
    }
  }
  for(let col=0;col<rings[0].length;col++)model.triangles.push(toeCenter,rings[0][(col+1)%rings[0].length],rings[0][col]);
  const pairs=new Set(model.constraints.map(c=>`${Math.min(c.a,c.b)},${Math.max(c.a,c.b)}`));
  for(let j=capStart;j<model.triangles.length;j+=3)for(let k=0;k<3;k++){
    const a=model.triangles[j+k],b=model.triangles[j+(k+1)%3],key=`${Math.min(a,b)},${Math.max(a,b)}`;if(pairs.has(key))continue;pairs.add(key);
    model.constraints.push({a,b,kind:'toe-cap',compliance:.012,lambda:0,stiffness:1});
  }
  // Shared-face opposite distances give the disk and its sidewall junction a
  // local folding penalty. These approximate hinges use the same uncalibrated
  // bend compliance as the tube; no cap vertex is anchored to a body plane.
  const capVertices=new Set(nodes.map(node=>node.index)),hinges=new Map();
  for(let j=0;j<model.triangles.length;j+=3)for(let k=0;k<3;k++){
    const a=model.triangles[j+k],b=model.triangles[j+(k+1)%3],opposite=model.triangles[j+(k+2)%3],key=`${Math.min(a,b)},${Math.max(a,b)}`;
    if(!hinges.has(key))hinges.set(key,{opposites:[],cap:false});
    const hinge=hinges.get(key);hinge.opposites.push(opposite);hinge.cap ||= capVertices.has(a)||capVertices.has(b)||capVertices.has(opposite);
  }
  const bendPairs=new Set(model.constraints.filter(c=>c.kind==='bend').map(c=>`${Math.min(c.a,c.b)},${Math.max(c.a,c.b)}`));
  for(const hinge of hinges.values())if(hinge.cap&&hinge.opposites.length===2){
    const [a,b]=hinge.opposites,key=`${Math.min(a,b)},${Math.max(a,b)}`;if(bendPairs.has(key))continue;bendPairs.add(key);
    model.constraints.push({a,b,kind:'bend',compliance:8,lambda:0,stiffness:1});
  }
  for (const constraint of model.constraints) {
    constraint.restLength = constraint.baseRestLength = distance(model.rest, constraint.a, constraint.b);
    const v = (model.uv[constraint.a * 2 + 1] + model.uv[constraint.b * 2 + 1]) / 2;
    constraint.region = stockingRegion(v);
    if (constraint.region === 'cuff') { constraint.compliance *= 0.28; constraint.stiffness = 3.57; }
  }
  model.dimensions = {...d};
  model.garment = {type: 'single-leg-stocking', dimensions: {...d}, regions: STOCKING_REGIONS.map(r => ({...r})),
    numericalStandOff:{...NUMERICAL_STANDOFF},
    finishing:{toeCap:{method:'free-center-fan',refinement:'concentric-free-rings',centerVertexId:'toe-center',isotropicAppearanceFallback:true,materialStatus:'experimental-linear-closure',bendingStatus:'experimental-distance-hinges'}},
    formation: 'experimental shaped circular knit with heel shaping and closed-toe finishing', manufacturing: 'unverified', calibrated: false};
  model.regions.push({kind: 'garment-definition', ...JSON.parse(JSON.stringify(model.garment))});
  model._rebuildTopology(); model.initialMass = model.mass;
  return model;
}
export function fitStocking(model, {pose = 0, dimensions = DEFAULT_BODY_DIMENSIONS, margin = NUMERICAL_STANDOFF.fitting} = {}) {
  checkPose(pose);
  const d = normalizeDimensions(dimensions, DEFAULT_BODY_DIMENSIONS), knots = profile(d);
  if (!Number.isFinite(margin) || margin < 0 || margin > 0.03) throw new RangeError('Invalid fitting margin');
  const frames = new Map(),capNodes=new Map((model.metadata?.toeCap?.nodes||[]).map(node=>[node.id,node]));
  for (let i = 0; i < model.positions.length / 3; i++) {
    if (!model.active[i]) continue;
    const capNode=capNodes.get(model.vertexIds?.[i]?.split(':split-')[0]);
    if(capNode||model.vertexIds?.[i]==='toe-center'||model.vertexIds?.[i]?.startsWith('toe-center:')){
      const toe=frame(0,knots,pose),node=capNode||{u:.5,fraction:0},outer=sample(node.u,toe,margin);
      model.positions.set([toe.x+(outer[0]-toe.x)*node.fraction,toe.y+(outer[1]-toe.y)*node.fraction-toe.ty*margin,toe.z+(outer[2]-toe.z)*node.fraction-toe.tz*margin],3*i);continue;
    }
    const u = model.uv[2 * i], v = model.uv[2 * i + 1];
    if (!frames.has(v)) frames.set(v, frame(v, knots, pose));
    const f = frames.get(v), point = sample(u, f, margin);
    const toeOffset = margin * (1 - smooth(clamp(v / 0.055, 0, 1)));
    point[1] -= f.ty * toeOffset; point[2] -= f.tz * toeOffset;
    model.positions.set(point, 3 * i);
  }
  model.velocities.fill(0); model.release(); model.grabForceN = 0;
  for (const index of model.pins) model.pinTargets.set(index, [...model.positions.slice(3 * index, 3 * index + 3)]);
  for (const constraint of model.constraints) constraint.lambda = 0;
  model._strainDirty = true;
  return model;
}
export function bodyGeometryData({pose = 0, dimensions = DEFAULT_BODY_DIMENSIONS, cols = 40, rows = 64} = {}) {
  checkPose(pose); checkResolution(cols, rows);
  const knots = profile(normalizeDimensions(dimensions, DEFAULT_BODY_DIMENSIONS));
  const positions = [], uv = [], indices = [];
  for (let row = 0; row < rows; row++) {
    const v = row / (rows - 1), f = frame(v, knots, pose);
    for (let col = 0; col < cols; col++) {
      positions.push(...sample(col / cols, f)); uv.push(col / cols, v);
      if (row < rows - 1) {
        const a = row * cols + col, b = row * cols + (col + 1) % cols, c = a + cols, d = b + cols;
        indices.push(a, b, d, a, d, c);
      }
    }
  }
  // The rigid toe end-plane has the same polygonal boundary as before, with
  // interior samples for symmetric body-point/cloth-face contact. Refinement
  // does not inflate the body or introduce hidden attachment constraints.
  const toe=frame(0,knots,pose),center=positions.length/3,rings=[];
  positions.push(toe.x,toe.y,toe.z);uv.push(.5,0);
  for(const fraction of [.25,.5,.75]){
    const count=Math.max(6,Math.round(cols*fraction)),ring=[];
    for(let col=0;col<count;col++){const u=col/count,p=sample(u,toe),index=positions.length/3;ring.push(index);positions.push(toe.x+(p[0]-toe.x)*fraction,toe.y+(p[1]-toe.y)*fraction,toe.z+(p[2]-toe.z)*fraction);uv.push(u,0);}
    rings.push(ring);
  }
  const allRings=[Array.from({length:cols},(_,i)=>i),...rings.toReversed()];
  for(let layer=0;layer<allRings.length-1;layer++){
    const outer=allRings[layer],inner=allRings[layer+1];let a=0,b=0;
    while(a<outer.length||b<inner.length){const nextA=(a+1)/outer.length,nextB=(b+1)/inner.length;
      if(a<outer.length&&(b===inner.length||nextA<=nextB+1e-12)){indices.push(outer[a%outer.length],inner[b%inner.length],outer[(a+1)%outer.length]);a++;}
      else{indices.push(outer[a%outer.length],inner[b%inner.length],inner[(b+1)%inner.length]);b++;}
    }
  }
  for(let col=0;col<rings[0].length;col++)indices.push(center,rings[0][(col+1)%rings[0].length],rings[0][col]);
  cap(indices, cols, rows - 1, false);
  return {positions, uv, indices, cols, rows, gridVertexCount: cols * rows};
}

function rayTriangle(point,direction,positions,ia,ib,ic){
  const a=ia*3,b=ib*3,c=ic*3,p=positions,e1=[p[b]-p[a],p[b+1]-p[a+1],p[b+2]-p[a+2]],e2=[p[c]-p[a],p[c+1]-p[a+1],p[c+2]-p[a+2]],h=[direction[1]*e2[2]-direction[2]*e2[1],direction[2]*e2[0]-direction[0]*e2[2],direction[0]*e2[1]-direction[1]*e2[0]],det=e1[0]*h[0]+e1[1]*h[1]+e1[2]*h[2];
  if(Math.abs(det)<1e-12)return null;
  const inverse=1/det,s=[point[0]-p[a],point[1]-p[a+1],point[2]-p[a+2]],u=inverse*(s[0]*h[0]+s[1]*h[1]+s[2]*h[2]);if(u<-1e-9||u>1+1e-9)return null;
  const q=[s[1]*e1[2]-s[2]*e1[1],s[2]*e1[0]-s[0]*e1[2],s[0]*e1[1]-s[1]*e1[0]],v=inverse*(direction[0]*q[0]+direction[1]*q[1]+direction[2]*q[2]);if(v<-1e-9||u+v>1+1e-9)return null;
  const t=inverse*(e2[0]*q[0]+e2[1]*q[1]+e2[2]*q[2]);return t>1e-8?t:null;
}
/** Coverage audit for the uncut one-boundary stocking. A temporary cuff cap is
 * used only for ray parity; it never modifies the simulation mesh or adds pins.
 * It catches a toe cap slipping axially inside a foot while ring winding stays 1.
 * Positive probe offsets check extra axial clearance; zero samples the actual
 * body tip and negative values sample a shallow body inset. This is a sampled
 * coverage audit, not a proof that every body surface point is enclosed.
 */
export function stockingToeCoverage(model,{pose=0,dimensions=DEFAULT_BODY_DIMENSIONS,probeOffsetM=.0005}={}){
  if(!Number.isFinite(probeOffsetM)||probeOffsetM<-.001||probeOffsetM>.003)throw new RangeError('Toe coverage probe offset must be finite within [-0.001,0.003] metres');
  const coverageScope=probeOffsetM===0?'sampled-body-toe-tip':probeOffsetM>0?'sampled-toe-tip-clearance':'sampled-body-toe-inset';
  const applicable=model.kind==='stocking'&&model.boundary.size===model.cols&&[...model.boundary].every(i=>model.uv[i*2+1]>.999999);
  if(!applicable)return {applicable:false,covered:null,probeOffsetM,coverageScope,reason:'Coverage parity requires an uncut stocking with only the cuff boundary.'};
  const f=bodyFrame(0,{pose,dimensions}),center=[f.x,f.y,f.z],normal=[0,-f.ty,-f.tz],faces=[...model.triangles];cap(faces,model.cols,model.rows-1,false);
  const direction=[.893,.367,.262],probes=[center.map((x,k)=>x+normal[k]*probeOffsetM)];
  for(const fraction of [.5,.9])for(let col=0;col<8;col++){const angle=col/8*Math.PI*2;probes.push([f.x+Math.sin(angle)*f.rx*fraction,f.y+Math.cos(angle)*f.rn*f.ny*fraction+normal[1]*probeOffsetM,f.z+Math.cos(angle)*f.rn*f.nz*fraction+normal[2]*probeOffsetM]);}
  let uncoveredProbes=0;
  for(const probe of probes){const hits=[];for(let j=0;j<faces.length;j+=3){const t=rayTriangle(probe,direction,model.positions,faces[j],faces[j+1],faces[j+2]);if(t!==null)hits.push(t);}hits.sort((a,b)=>a-b);let count=0,last=-Infinity;for(const t of hits)if(t-last>1e-7){count++;last=t;}if(count%2===0)uncoveredProbes++;}
  let minCapAxial=Infinity,maxCapAxial=-Infinity,meanCapAxial=0;
  for(let col=0;col<model.cols;col++){const distance=normal.reduce((sum,x,k)=>sum+x*(model.positions[col*3+k]-center[k]),0);minCapAxial=Math.min(minCapAxial,distance);maxCapAxial=Math.max(maxCapAxial,distance);meanCapAxial+=distance/model.cols;}
  return {applicable:true,covered:uncoveredProbes===0,probes:probes.length,uncoveredProbes,minCapAxial,maxCapAxial,meanCapAxial,probeOffsetM,coverageScope,scope:'toe-tip-volume',manufacturing:'unverified'};
}
