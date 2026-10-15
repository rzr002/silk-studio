import {bodyGeometryData, DEFAULT_BODY_DIMENSIONS, normalizeDimensions,NUMERICAL_STANDOFF} from './garment-geometry.mjs';

/** Legacy rigid, metre-scale leg proxy, retained for old experiment snapshots.
 * Each straight centerline segment carries the same sampled radius profile as
 * the visible rings. Segment ends use rounded caps, and their union closes the
 * knee. This is deliberately a geometric proxy, not anatomical soft tissue or
 * continuous collision detection. The small cap volumes extend beyond end rings.
 */
const KNEE = 0.70, BASE = 0.25, HEIGHT = 0.85;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const radiusAt = t => { const d = (t - 0.28) / 0.20; return 0.054 + 0.035 * Math.exp(-d * d) + 0.063 * t * t; };
const upperHit = new Float64Array(4), lowerHit = new Float64Array(4);
let cachedAngle = NaN, cachedCos = 1, cachedSin = 0;

export function legPoint(t, angle = 0) {
  const y = BASE + HEIGHT * t, phi = angle * Math.PI / 180;
  const lower = y < KNEE;
  return { x: 0.12, y: lower ? KNEE + (y - KNEE) * Math.cos(phi) : y,
    z: lower ? -(y - KNEE) * Math.sin(phi) : 0,
    radius: radiusAt(t), phi: lower ? phi : 0 };
}

function penetration(x, y, z, lower, cos, sin, margin, out) {
  // Orthogonally project onto each original axial interval separately. A bent
  // lower cross-section can cross world y=.70, so world height never selects it.
  const localY = lower ? KNEE + (y - KNEE) * cos - z * sin : y;
  const axialY = clamp(localY, lower ? BASE : KNEE, lower ? KNEE : BASE + HEIGHT);
  const t = (axialY - BASE) / HEIGHT;
  const cy = lower ? KNEE + (axialY - KNEE) * cos : axialY;
  const cz = lower ? -(axialY - KNEE) * sin : 0;
  const dx = x - 0.12, dy = y - cy, dz = z - cz;
  const distance = Math.hypot(dx, dy, dz), radius = radiusAt(t) + margin;
  if (distance >= radius - 1e-10) { out[0] = 0; return; }
  out[0] = radius - distance;
  if (distance < 1e-12) { out[1] = 0.12 + radius; out[2] = cy; out[3] = cz; return; }
  const scale = radius / distance;
  out[1] = 0.12 + dx * scale; out[2] = cy + dy * scale; out[3] = cz + dz * scale;
}

export function legProjection(x, y, z, angle = 0, margin = 0.003) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(angle) || !Number.isFinite(margin)) return null;
  margin = Math.max(0, margin);
  if (Math.abs(x - 0.12) > 0.13 + margin) return null;
  if (angle !== cachedAngle) { const phi = angle * Math.PI / 180; cachedCos = Math.cos(phi); cachedSin = Math.sin(phi); cachedAngle = angle; }
  const cos = cachedCos, sin = cachedSin;
  let touched = false;
  // Exit the union, not merely one of its overlapping parts. Deepest-first
  // projections converge rapidly for the supported demo range 0–55 degrees.
  for (let iteration = 0; iteration < 24; iteration++) {
    penetration(x, y, z, false, cos, sin, margin, upperHit);
    penetration(x, y, z, true, cos, sin, margin, lowerHit);
    if (!upperHit[0] && !lowerHit[0]) return touched ? [x, y, z] : null;
    const hit = upperHit[0] > lowerHit[0] ? upperHit : lowerHit;
    x = hit[1]; y = hit[2]; z = hit[3]; touched = true;
  }
  return touched ? [x, y, z] : null;
}

// Full-foot mannequin contact shares its closed triangle surface with rendering.
// A refitted BVH accelerates nearest features; this discrete signed projection
// is not continuous moving-triangle collision detection or soft body mechanics.
let bodyCache = null;
const dimensionKeys = Object.keys(DEFAULT_BODY_DIMENSIONS);
function boundsFor(ids, positions, indices) {
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const face of ids) for (let k = 0; k < 3; k++) {
    const offset = indices[face * 3 + k] * 3;
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[offset + axis];
      bounds[axis] = Math.min(bounds[axis], value); bounds[axis + 3] = Math.max(bounds[axis + 3], value);
    }
  }
  return bounds;
}
function makeTree(ids, positions, indices) {
  const bounds = boundsFor(ids, positions, indices);
  if (ids.length <= 8) return {bounds, ids};
  const size = [0, 1, 2].map(axis => bounds[axis + 3] - bounds[axis]);
  const axis = size.indexOf(Math.max(...size));
  const centroid = face => (positions[indices[face * 3] * 3 + axis] + positions[indices[face * 3 + 1] * 3 + axis] + positions[indices[face * 3 + 2] * 3 + axis]) / 3;
  ids.sort((a, b) => centroid(a) - centroid(b));
  const middle = Math.floor(ids.length / 2);
  return {bounds, left: makeTree(ids.slice(0, middle), positions, indices), right: makeTree(ids.slice(middle), positions, indices)};
}
function refitTree(node, positions, indices) {
  if (node.ids) node.bounds = boundsFor(node.ids, positions, indices);
  else {
    refitTree(node.left, positions, indices); refitTree(node.right, positions, indices);
    for (let axis = 0; axis < 3; axis++) {
      node.bounds[axis] = Math.min(node.left.bounds[axis], node.right.bounds[axis]);
      node.bounds[axis + 3] = Math.max(node.left.bounds[axis + 3], node.right.bounds[axis + 3]);
    }
  }
}
function normalsFor(mesh) {
  const {positions: p, indices: ids} = mesh;
  mesh.faceNormals = new Float64Array(ids.length);
  mesh.vertexNormals = new Float64Array(p.length);
  mesh.edgeNormals=new Map();const vertexCount=p.length/3;
  for (let j = 0; j < ids.length; j += 3) {
    const a = ids[j] * 3, b = ids[j + 1] * 3, c = ids[j + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], length = Math.hypot(...n) || 1;
    for (let axis = 0; axis < 3; axis++) {
      mesh.faceNormals[j + axis] = n[axis] / length;
    }
    for(let corner=0;corner<3;corner++){
      const origin=ids[j+corner]*3,next=ids[j+(corner+1)%3]*3,previous=ids[j+(corner+2)%3]*3;
      const x=[p[next]-p[origin],p[next+1]-p[origin+1],p[next+2]-p[origin+2]],y=[p[previous]-p[origin],p[previous+1]-p[origin+1],p[previous+2]-p[origin+2]];
      const angle=Math.acos(clamp(x.reduce((sum,value,k)=>sum+value*y[k],0)/(Math.hypot(...x)*Math.hypot(...y)||1),-1,1));
      for(let axis=0;axis<3;axis++)mesh.vertexNormals[origin+axis]+=mesh.faceNormals[j+axis]*angle;
      const ia=ids[j+corner],ib=ids[j+(corner+1)%3],key=Math.min(ia,ib)*vertexCount+Math.max(ia,ib);
      if(!mesh.edgeNormals.has(key))mesh.edgeNormals.set(key,[0,0,0]);const normal=mesh.edgeNormals.get(key);
      for(let axis=0;axis<3;axis++)normal[axis]+=mesh.faceNormals[j+axis];
    }
  }
  for(const normal of mesh.edgeNormals.values()){const length=Math.hypot(...normal)||1;for(let axis=0;axis<3;axis++)normal[axis]/=length;}
  for (let offset = 0; offset < p.length; offset += 3) {
    const length = Math.hypot(mesh.vertexNormals[offset], mesh.vertexNormals[offset + 1], mesh.vertexNormals[offset + 2]) || 1;
    for (let axis = 0; axis < 3; axis++) mesh.vertexNormals[offset + axis] /= length;
  }
}
export function getBodyCollisionMesh({pose = 0, dimensions = DEFAULT_BODY_DIMENSIONS} = {}) {
  const unchanged = bodyCache && bodyCache.pose === pose && dimensionKeys.every(key => bodyCache.dimensions[key] === (dimensions[key] === undefined ? DEFAULT_BODY_DIMENSIONS[key] : dimensions[key]));
  if (unchanged) return bodyCache;
  const d = normalizeDimensions(dimensions, DEFAULT_BODY_DIMENSIONS), data = bodyGeometryData({pose, dimensions: d});
  if (!bodyCache) {
    bodyCache = {positions: Float64Array.from(data.positions), indices: Uint32Array.from(data.indices),
      previousPositions: null, pose, dimensions: d, revision: 0};
    bodyCache.tree = makeTree(Array.from({length: data.indices.length / 3}, (_, i) => i), bodyCache.positions, bodyCache.indices);
  } else {
    bodyCache.previousPositions = Float64Array.from(bodyCache.positions);
    bodyCache.positions.set(data.positions); bodyCache.pose = pose; bodyCache.dimensions = d; bodyCache.revision++;
    refitTree(bodyCache.tree, bodyCache.positions, bodyCache.indices);
  }
  normalsFor(bodyCache);
  return bodyCache;
}
function boxDistanceSquared(x, y, z, bounds) {
  let distance = 0;
  for (let axis = 0; axis < 3; axis++) {
    const p = axis === 0 ? x : axis === 1 ? y : z;
    const delta = p < bounds[axis] ? bounds[axis] - p : p > bounds[axis + 3] ? p - bounds[axis + 3] : 0;
    distance += delta * delta;
  }
  return distance;
}
function testTriangle(face, query, mesh) {
  const {positions: p, indices: ids} = mesh, j = face * 3;
  const a = ids[j] * 3, b = ids[j + 1] * 3, c = ids[j + 2] * 3;
  const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
  const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
  const apx = query.x - p[a], apy = query.y - p[a + 1], apz = query.z - p[a + 2];
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let v, w;
  if (d1 <= 0 && d2 <= 0) { v = 0; w = 0; }
  else {
    const bpx = query.x - p[b], bpy = query.y - p[b + 1], bpz = query.z - p[b + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { v = 1; w = 0; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { v = d1 / (d1 - d3); w = 0; }
      else {
        const cpx = query.x - p[c], cpy = query.y - p[c + 1], cpz = query.z - p[c + 2];
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { v = 0; w = 1; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { v = 0; w = d2 / (d2 - d6); }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { w = (d4 - d3) / (d4 - d3 + d5 - d6); v = 1 - w; }
            else { const inverse = 1 / (va + vb + vc); v = vb * inverse; w = vc * inverse; }
          }
        }
      }
    }
  }
  const qx = p[a] + abx * v + acx * w, qy = p[a + 1] + aby * v + acy * w, qz = p[a + 2] + abz * v + acz * w;
  const dx = query.x - qx, dy = query.y - qy, dz = query.z - qz, squared = dx * dx + dy * dy + dz * dz;
  if (squared >= query.best) return;
  query.best = squared; query.qx = qx; query.qy = qy; query.qz = qz;
  const u = 1 - v - w;
  let nx, ny, nz;
  if (Math.min(u, v, w) > 1e-7) {
    nx = mesh.faceNormals[j]; ny = mesh.faceNormals[j + 1]; nz = mesh.faceNormals[j + 2];
  } else {
    const weights=[u,v,w],zero=weights.map((value,index)=>value<=1e-7?index:-1).filter(index=>index>=0);
    if(zero.length===1){
      const ends=[0,1,2].filter(index=>index!==zero[0]).map(index=>ids[j+index]),key=Math.min(...ends)*(p.length/3)+Math.max(...ends),normal=mesh.edgeNormals.get(key);
      nx=normal[0];ny=normal[1];nz=normal[2];
    }else{
      const corner=weights.indexOf(Math.max(...weights)),offset=ids[j+corner]*3,n=mesh.vertexNormals;
      nx=n[offset];ny=n[offset+1];nz=n[offset+2];
    }
  }
  query.nx = nx; query.ny = ny; query.nz = nz;
  query.signedDistance = (dx * nx + dy * ny + dz * nz < 0 ? -1 : 1) * Math.sqrt(squared);
}
function visitTree(node, query, mesh) {
  if (boxDistanceSquared(query.x, query.y, query.z, node.bounds) > query.best) return;
  if (node.ids) { for (const face of node.ids) testTriangle(face, query, mesh); return; }
  const dl = boxDistanceSquared(query.x, query.y, query.z, node.left.bounds), dr = boxDistanceSquared(query.x, query.y, query.z, node.right.bounds);
  if (dl < dr) { visitTree(node.left, query, mesh); visitTree(node.right, query, mesh); }
  else { visitTree(node.right, query, mesh); visitTree(node.left, query, mesh); }
}
export function bodyProjection(x, y, z, {pose = 0, dimensions = DEFAULT_BODY_DIMENSIONS, margin = NUMERICAL_STANDOFF.contact} = {}) {
  if (![x, y, z, pose, margin].every(Number.isFinite) || pose < 0 || pose > 55 || margin < 0 || margin > 0.03) return null;
  const mesh = getBodyCollisionMesh({pose, dimensions});
  if (boxDistanceSquared(x, y, z, mesh.tree.bounds) > margin * margin) return null;
  let touched = false;
  for (let iteration = 0; iteration < 12; iteration++) {
    const query = {x, y, z, best: Infinity};
    visitTree(mesh.tree, query, mesh);
    if (query.signedDistance >= margin - 1e-8) return touched ? [x, y, z] : null;
    x = query.qx + query.nx * (margin + 1e-7);
    y = query.qy + query.ny * (margin + 1e-7);
    z = query.qz + query.nz * (margin + 1e-7);
    touched = true;
  }
  return touched ? [x, y, z] : null;
}

function trianglePoints(positions,ids){return Array.from(ids,i=>Array.from(positions.slice(i*3,i*3+3)));}
function segmentTriangleCrossing(p,q,a,b,c){
  const d=q.map((x,k)=>x-p[k]),e=b.map((x,k)=>x-a[k]),f=c.map((x,k)=>x-a[k]),h=[d[1]*f[2]-d[2]*f[1],d[2]*f[0]-d[0]*f[2],d[0]*f[1]-d[1]*f[0]],det=e.reduce((sum,x,k)=>sum+x*h[k],0);
  if(Math.abs(det)<1e-12)return false;
  const s=p.map((x,k)=>x-a[k]),u=s.reduce((sum,x,k)=>sum+x*h[k],0)/det;if(u<-1e-8||u>1+1e-8)return false;
  const r=[s[1]*e[2]-s[2]*e[1],s[2]*e[0]-s[0]*e[2],s[0]*e[1]-s[1]*e[0]],v=d.reduce((sum,x,k)=>sum+x*r[k],0)/det;if(v<-1e-8||u+v>1+1e-8)return false;
  const t=f.reduce((sum,x,k)=>sum+x*r[k],0)/det;return t>1e-6&&t<1-1e-6;
}
function intersectingCandidates(node,bounds,out){
  if(![0,1,2].every(k=>bounds[k]<=node.bounds[k+3]+1e-8&&bounds[k+3]>=node.bounds[k]-1e-8))return;
  if(node.ids)out.push(...node.ids);else{intersectingCandidates(node.left,bounds,out);intersectingCandidates(node.right,bounds,out);}
}
/** Offline geometry audit, not a contact response or a continuous-time proof.
 * Test both meshes' edges against the other mesh's triangles; exterior cloth
 * vertices alone cannot prove that a closed toe cap encloses the body.
 */
export function auditBodyIntersections(model,{pose=0,dimensions=DEFAULT_BODY_DIMENSIONS}={}){
  const body=getBodyCollisionMesh({pose,dimensions}),clothFaces=new Set(),samples=[];
  let pairCount=0,toePairCount=0;
  for(let j=0;j<model.triangles.length;j+=3){
    const ids=model.triangles.slice(j,j+3),a=trianglePoints(model.positions,ids),bounds=[0,1,2].map(k=>Math.min(...a.map(p=>p[k]))).concat([0,1,2].map(k=>Math.max(...a.map(p=>p[k])))),candidates=[];
    intersectingCandidates(body.tree,bounds,candidates);
    for(const face of candidates){const b=trianglePoints(body.positions,body.indices.slice(face*3,face*3+3));let hit=false;
      for(let edge=0;edge<3&&!hit;edge++)hit=segmentTriangleCrossing(a[edge],a[(edge+1)%3],...b)||segmentTriangleCrossing(b[edge],b[(edge+1)%3],...a);
      if(hit){pairCount++;clothFaces.add(j/3);if(ids.every(i=>model.uv[i*2+1]<=.055))toePairCount++;if(samples.length<12)samples.push({clothFace:j/3,bodyFace:face});}
    }
  }
  return {pairCount,clothFaceCount:clothFaces.size,clothFaces:[...clothFaces],toePairCount,samples,
    scope:'noncoplanar segment-triangle crossings',coplanarOverlapCovered:false,continuousTimeCovered:false};
}
