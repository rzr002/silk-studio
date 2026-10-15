/**
 * Small, inspectable XPBD cloth laboratory. Coordinates are metres, time seconds,
 * mass kilograms. Distance compliance is m/N. Warp and weft follow the rest UV
 * directions; diagonal distances approximate shear and two-edge distances bend.
 * This is a discrete demonstration, not a calibrated constitutive hosiery model:
 * no yarn interlocking, general moving-surface CCD or manufacturing proof.
 * Incisions split mesh-edge vertex fans without removing fabric. The separate
 * cutSegmentUV operation deliberately removes a strip and reports lost mass.
 */

import { incisionPlan, pairBoundaryPaths } from './topology.mjs';
import { solveSelfCollision,solveMeshCollision,solveSurfaceCollision,solveBodyVertexContacts } from './collision.mjs';
import { evaluateMaterial } from './material-data.mjs';
import { solveEdgeContact } from './edge-contact.mjs';
const BASE_COMPLIANCE = { weft: 0.03, warp: 0.012, shear: 0.08, bend: 8, seam: 0.00000001 };
const EPS = 1e-12;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const copy = value => JSON.parse(JSON.stringify(value));
const dist3 = (p, a, b) => Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2]);
const cross2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function pointSegmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
function segmentDistance(a, b, c, d) {
  const ab = cross2(a, b, c), ac = cross2(a, b, d), cd = cross2(c, d, a), ce = cross2(c, d, b);
  if (ab * ac <= 0 && cd * ce <= 0 &&
      Math.max(a[0], b[0]) + EPS >= Math.min(c[0], d[0]) && Math.max(c[0], d[0]) + EPS >= Math.min(a[0], b[0]) &&
      Math.max(a[1], b[1]) + EPS >= Math.min(c[1], d[1]) && Math.max(c[1], d[1]) + EPS >= Math.min(a[1], b[1])) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}
function insideTriangle(p, a, b, c) {
  const x = cross2(a, b, p), y = cross2(b, c, p), z = cross2(c, a, p);
  return (x >= -EPS && y >= -EPS && z >= -EPS) || (x <= EPS && y <= EPS && z <= EPS);
}
function triangleArea(p, a, b, c) {
  const x1 = p[3 * b] - p[3 * a], y1 = p[3 * b + 1] - p[3 * a + 1], z1 = p[3 * b + 2] - p[3 * a + 2];
  const x2 = p[3 * c] - p[3 * a], y2 = p[3 * c + 1] - p[3 * a + 1], z2 = p[3 * c + 2] - p[3 * a + 2];
  return Math.hypot(y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2) / 2;
}
function shearState(element,p) {
  const u=[0,0,0],v=[0,0,0];for(let a=0;a<3;a++)for(let k=0;k<3;k++){u[k]+=element.gu[a]*p[element.ids[a]*3+k];v[k]+=element.gv[a]*p[element.ids[a]*3+k];}
  const nu=Math.hypot(...u),nv=Math.hypot(...v);if(nu<EPS||nv<EPS)return null;
  const cosine=clamp(u.reduce((s,x,k)=>s+x*v[k],0)/(nu*nv),-1+1e-10,1-1e-10),delta=clamp(element.restAngle-Math.acos(cosine),-1.47,1.47),gamma=Math.tan(delta),factor=(1+gamma*gamma)/Math.sqrt(1-cosine*cosine);
  const du=u.map((x,k)=>v[k]/(nu*nv)-cosine*x/(nu*nu)),dv=v.map((x,k)=>u[k]/(nu*nv)-cosine*x/(nv*nv));
  return {gamma,gradients:element.ids.map((_,a)=>du.map((x,k)=>factor*(element.gu[a]*x+element.gv[a]*dv[k])))};
}

export class ClothModel {
  constructor({ positions, rest = positions, uv, triangles, constraints, pins = [], kind = 'patch', cols, rows, density = 0.12, layout='grid', gridVertexCount=cols*rows, sourceVertices=null, vertexIds=null, metadata={},strainLimit=2 }) {
    this.positions = Float64Array.from(positions);
    this.rest = Float64Array.from(rest);
    this.uv = Float64Array.from(uv);
    this.triangles = [...triangles];
    this.constraints = constraints.map(c => ({ ...c, lambda: c.lambda || 0 }));
    this.pins = new Set(pins);
    this.pinTargets = new Map([...this.pins].map(i => [i, [...this.positions.slice(3 * i, 3 * i + 3)]]));
    this.velocities = new Float64Array(this.positions.length);
    this.kind = kind; this.cols = cols; this.rows = rows; this.density = density;
    this.layout=layout;this.gridVertexCount=gridVertexCount;this.metadata=copy(metadata);
    this.sourceVertices=sourceVertices?[...sourceVertices]:Array.from({length:this.positions.length/3},(_,i)=>i);
    this.vertexIds=vertexIds?[...vertexIds]:this.sourceVertices.map(i=>`v-${i}`);
    this.selfCollision=false;this.collisionStats={contacts:0,candidates:0,continuousContacts:0};
    this.materialLaw=null;
    this.setStrainLimit(strainLimit);
    this._shearElements=[];this._hasShearLaw=false;
    this.removedFaces = 0; this.removedMass = 0; this.cuts = []; this.regions = [];
    this.grabbed = null; this.grabForceN = 0;
    this._strain = new Float64Array(this.positions.length / 3);
    this._strainDirty = true;
    this._rebuildTopology();
    this.initialMass = this.mass;
  }

  _rebuildTopology() {
    this._selfTopology=null;
    const n = this.positions.length / 3;
    this.inverseMass = new Float64Array(n);
    this.active = new Uint8Array(n);
    const masses = new Float64Array(n), edges = new Map();
    for (let j = 0; j < this.triangles.length; j += 3) {
      const face = this.triangles.slice(j, j + 3);
      const m = triangleArea(this.rest, ...face) * this.density / 3;
      for (let k = 0; k < 3; k++) {
        masses[face[k]] += m; this.active[face[k]] = 1;
        const a = Math.min(face[k], face[(k + 1) % 3]), b = Math.max(face[k], face[(k + 1) % 3]);
        const key = `${a},${b}`;
        const edge = edges.get(key);
        if (edge) edge.count++; else edges.set(key, { a, b, count: 1 });
      }
    }
    this.mass = 0;
    this._areas=new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.mass += masses[i];
      this._areas[i]=masses[i]/this.density;
      this.inverseMass[i] = masses[i] > EPS ? 1 / masses[i] : 0;
    }
    this.boundary = new Set();
    for (const { a, b, count } of edges.values()) if (count === 1) { this.boundary.add(a); this.boundary.add(b); }
    this._previous = new Float64Array(this.positions.length);
    this._contactStage = new Float64Array(this.positions.length);
    this._weights = new Float64Array(n);
    if(this._strain.length!==n)this._strain=new Float64Array(n);
    if(this._hasShearLaw)this._buildShearElements();
    this._strainDirty = true;
  }

  pin(index, enabled = !this.pins.has(index)) {
    if (!Number.isInteger(index) || !this.active[index]) return false;
    if (enabled) {
      this.pins.add(index);
      this.pinTargets.set(index, [...this.positions.slice(3 * index, 3 * index + 3)]);
      this.velocities.fill(0, index * 3, index * 3 + 3);
    } else { this.pins.delete(index); this.pinTargets.delete(index); }
    return enabled;
  }

  grab(index, target) {
    if (!Number.isInteger(index) || !this.active[index] || !Array.isArray(target) || target.length !== 3 || !target.every(Number.isFinite)) return false;
    this.grabbed = { index, target: [...target] };
    this.velocities.fill(0, index * 3, index * 3 + 3);
    return true;
  }
  moveGrab(target) {
    if (!this.grabbed || !Array.isArray(target) || target.length !== 3 || !target.every(Number.isFinite)) return false;
    this.grabbed.target = [...target];
    return true;
  }
  release() {
    if (this.grabbed && this.pins.has(this.grabbed.index)) this.pinTargets.set(this.grabbed.index, [...this.grabbed.target]);
    this.grabbed = null;
  }
  _enforceAnchors() {
    for (const [i, p] of this.pinTargets) this.positions.set(p, i * 3);
    if (this.grabbed) this.positions.set(this.grabbed.target, this.grabbed.index * 3);
  }

  setSelfCollision(options=false) {
    if(!options){this.selfCollision=false;return false;}
    const value=options===true?{thickness:.003,continuous:false}:{thickness:.003,continuous:false,...options};
    if(!Number.isFinite(value.thickness)||value.thickness<=0||value.thickness>.1)throw new Error('无效的自碰撞厚度');
    this.selfCollision={thickness:value.thickness,continuous:!!value.continuous};return this.selfCollision;
  }
  setStrainLimit(value=2){
    if(value!==null&&(!Number.isFinite(value)||value<0||value>10))throw new Error('无效的数值伸长上限');
    this.strainLimit=value;this.strainLimitStats={limitEngineeringStrain:value,maxLengthRatio:value===null?null:1+value,corrections:0,conflicts:0,calibrated:false,solverGuard:true};if(this.collisionStats)this.collisionStats.strainLimiting=copy(this.strainLimitStats);return value;
  }
  setMaterialLaw(profile) {
    if(profile==null){this.materialLaw=null;this._hasShearLaw=false;this._shearElements=[];return null;}
    if(profile.schema!=='silk-material'||profile.version!==1||!profile.directionCurves||!['synthetic','measured'].includes(profile.sourceType))throw new Error('无效的方向材料曲线');
    const groups=[profile.directionCurves,...Object.values(profile.cycles||{})];let count=0;
    for(const group of groups)for(const [direction,points] of Object.entries(group)){
      if(!['warp','weft','shear'].includes(direction)||!Array.isArray(points)||points.length<2)throw new Error('材料曲线需要至少两个加载点');
      for(let i=0;i<points.length;i++){const p=points[i],previous=points[i-1];if(!Number.isFinite(p.strain)||p.strain<0||!Number.isFinite(p.tensionNPerM)||p.tensionNPerM<0||previous&&(p.strain<=previous.strain||p.tensionNPerM<previous.tensionNPerM))throw new Error('材料加载曲线必须按应变严格递增且张力不下降');}count++;
    }
    if(!count)throw new Error('材料曲线为空');
    this.materialLaw=copy(profile);this.materialLaw.calibration={...this.materialLaw.calibration,physicsValidated:false};
    this._hasShearLaw=!!evaluateMaterial(this.materialLaw,'shear',0);this._buildShearElements();
    for(const c of this.constraints)c.lambda=0;return this.materialLaw;
  }
  _buildShearElements() {
    this._shearElements=[];if(!this._hasShearLaw)return;
    const diagonal=new Map(this.constraints.filter(c=>c.kind==='shear').map(c=>[`${Math.min(c.a,c.b)},${Math.max(c.a,c.b)}`,c]));
    for(let f=0;f<this.triangles.length;f+=3){const ids=this.triangles.slice(f,f+3),points=this._uvPoints(ids),du1=points[1][0]-points[0][0],du2=points[2][0]-points[0][0],dv1=points[1][1]-points[0][1],dv2=points[2][1]-points[0][1],det=du1*dv2-du2*dv1;if(Math.abs(det)<EPS)continue;
      const gu=[(dv1-dv2)/det,dv2/det,-dv1/det],gv=[(du2-du1)/det,-du2/det,du1/det],element={ids,gu,gv,area:triangleArea(this.rest,...ids),restAngle:Math.PI/2,lambda:0,gamma:0};
      const u=[0,0,0],v=[0,0,0];for(let a=0;a<3;a++)for(let k=0;k<3;k++){u[k]+=gu[a]*this.rest[ids[a]*3+k];v[k]+=gv[a]*this.rest[ids[a]*3+k];}const denom=Math.hypot(...u)*Math.hypot(...v);if(denom<EPS)continue;element.restAngle=Math.acos(clamp(u.reduce((s,x,k)=>s+x*v[k],0)/denom,-1+1e-10,1-1e-10));
      for(let k=0;k<3;k++){const a=ids[k],b=ids[(k+1)%3],c=diagonal.get(`${Math.min(a,b)},${Math.max(a,b)}`);if(c){element.diagonal=c;break;}}this._shearElements.push(element);
    }
  }
  _usesTriangleShear(c) {
    // Toe-cap UVs may collapse to one V. Their closing chords have no valid
    // material-angle element and retain the declared linear support model.
    return this._hasShearLaw&&this._shearElements.length>0&&c.kind==='shear'&&Math.abs(this.uv[c.a*2+1]-this.uv[c.b*2+1])>EPS;
  }
  step(dt, { gravity = [0, -9.81, 0], loadAcceleration = [0, 0, 0], iterations = 8, substeps = 3, collider = null, damping = 1.8, friction = 0.35, selfCollision=this.selfCollision,collisionThickness=this.kind==='stocking'?.001:.003,continuousCollision=false,collisionMesh=null,surfaceCollision=false,surfacePasses=2,bodyVertexCollision=false,strainLimit=this.strainLimit,sweptCollider=false,edgeCollision=false } = {}) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if(strainLimit!==null&&(!Number.isFinite(strainLimit)||strainLimit<0||strainLimit>10))throw new Error('无效的数值伸长上限');
    this.strainLimitStats={limitEngineeringStrain:strainLimit,maxLengthRatio:strainLimit===null?null:1+strainLimit,corrections:0,conflicts:0,calibrated:false,solverGuard:true};
    substeps = clamp(Math.floor(substeps), 1, 12); iterations = clamp(Math.floor(iterations), 1, 30);
    const h = Math.min(dt, 1 / 30) / substeps, p = this.positions, v = this.velocities;
    const attenuation = Math.exp(-Math.max(0, damping) * h);
    this.collisionStats={contacts:0,candidates:0,continuousContacts:0,movingTrianglesSkipped:0};
    this.collisionStats.sweptColliderEnabled=!!(sweptCollider&&collider);this.collisionStats.sweptColliderExactCCD=false;this.collisionStats.sweptColliderResolutionM=.001;this.collisionStats.sweptColliderContacts=0;this.collisionStats.sweptColliderOverflow=false;
    const guarded=i=>sweptCollider&&collider;
    const guardVertex=(i,old)=>{
      if(!guarded(i))return;const at=i*3,target=Array.from(p.slice(at,at+3)),distance=Math.hypot(...target.map((x,k)=>x-old[k]));if(distance<1e-10)return;
      const nearFraction=Math.min(1,1e-6/distance),near=old.map((x,k)=>x+(target[k]-x)*nearFraction),nearProjection=collider(...near);
      if(nearProjection?.length===3&&nearProjection.every(Number.isFinite)){p.set(nearProjection,at);this.collisionStats.sweptColliderContacts++;return;}
      const requested=Math.ceil(distance/.001),steps=Math.min(256,Math.max(1,requested));if(requested>256)this.collisionStats.sweptColliderOverflow=true;
      for(let s=1;s<=steps;s++){const t=s/steps,point=old.map((x,k)=>x+(target[k]-x)*t),projection=collider(...point);if(!projection||projection.length!==3||!projection.every(Number.isFinite))continue;
        let lo=(s-1)/steps,hi=t,hit=projection;for(let j=0;j<12;j++){const middle=(lo+hi)/2,q=old.map((x,k)=>x+(target[k]-x)*middle),test=collider(...q);if(test?.length===3&&test.every(Number.isFinite)){hi=middle;hit=test;}else lo=middle;}
        p.set(hit,at);this.collisionStats.sweptColliderContacts++;return;
      }
    };
    this._weights.set(this.inverseMass);
    for (const i of this.pins) this._weights[i] = 0;
    if (this.grabbed) this._weights[this.grabbed.index] = 0;
    for (let sub = 0; sub < substeps; sub++) {
      this._previous.set(p);
      for (let i = 0; i < this._weights.length; i++) {
        if (!this._weights[i]) continue;
        for (let k = 0; k < 3; k++) {
          const j = i * 3 + k;
          v[j] = v[j] * attenuation + ((gravity[k] || 0) + (loadAcceleration[k] || 0)) * h;
          p[j] += v[j] * h;
        }
        guardVertex(i,Array.from(this._previous.slice(i*3,i*3+3)));
      }
      this._enforceAnchors();
      for (const c of this.constraints) c.lambda = 0;
      for(const element of this._shearElements)element.lambda=0;
      for (let pass = 0; pass < iterations; pass++) {
        if(collisionMesh&&edgeCollision)this._contactStage.set(pass===0?this._previous:p);
        // Alternate order to reduce directional Gauss-Seidel bias.
        for (let j = 0; j < this.constraints.length; j++) {
          const c = this.constraints[pass % 2 ? this.constraints.length - 1 - j : j];
          if(this._usesTriangleShear(c))continue;
          const ia = c.a * 3, ib = c.b * 3;
          const dx = p[ia] - p[ib], dy = p[ia + 1] - p[ib + 1], dz = p[ia + 2] - p[ib + 2];
          const len = Math.hypot(dx, dy, dz), wa = this._weights[c.a], wb = this._weights[c.b];
          if (len < EPS) continue;
          const law=this.materialLaw&&['warp','weft'].includes(c.kind)?evaluateMaterial(this.materialLaw,c.kind,len/c.restLength-1):null;
          let dl;
          if(law){
            // Tension is normalized by measured sample width (N/m). A discrete
            // edge represents its lumped surface tributary width, in metres.
            const width=(this._areas[c.a]+this._areas[c.b])/(2*c.baseRestLength),scale=width*(c.stiffness||1);
            const force=law.tensionNPerM*scale,tangent=law.tangentNPerM*scale/c.restLength;
            dl=-(h*h*force+c.lambda)/(1+h*h*tangent*(wa+wb));
            dl=Math.min(0,c.lambda+dl)-c.lambda;
          }else{
            if(wa+wb===0)continue;
            const alpha=c.compliance/(h*h);dl=(-(len-c.restLength)-alpha*c.lambda)/(wa+wb+alpha);
          }
          c.lambda += dl;
          const sa = wa * dl / len, sb = wb * dl / len;
          const oldA=guarded(c.a)?Array.from(p.slice(ia,ia+3)):null,oldB=guarded(c.b)?Array.from(p.slice(ib,ib+3)):null;
          p[ia] += dx * sa; p[ia + 1] += dy * sa; p[ia + 2] += dz * sa;
          p[ib] -= dx * sb; p[ib + 1] -= dy * sb; p[ib + 2] -= dz * sb;
          if(oldA&&wa)guardVertex(c.a,oldA);if(oldB&&wb)guardVertex(c.b,oldB);
        }
        for(const element of this._shearElements){const state=shearState(element,p);if(!state)continue;element.gamma=state.gamma;const law=evaluateMaterial(this.materialLaw,'shear',Math.abs(state.gamma)),scale=element.area*(element.diagonal?.stiffness||1),force=scale*law.tensionNPerM*Math.sign(state.gamma),tangent=scale*law.tangentNPerM,w=element.ids.reduce((s,i,a)=>s+this._weights[i]*state.gradients[a].reduce((q,x)=>q+x*x,0),0),dl=-(h*h*force+element.lambda)/(1+h*h*tangent*w);element.lambda+=dl;
          for(let a=0;a<3;a++)for(let k=0;k<3;k++)p[element.ids[a]*3+k]+=this._weights[element.ids[a]]*dl*state.gradients[a][k];
        }
        if(strainLimit!==null)for(const c of this.constraints){
          if(!['weft','warp','shear','toe-cap'].includes(c.kind))continue;
          const a=c.a*3,b=c.b*3,delta=[p[a]-p[b],p[a+1]-p[b+1],p[a+2]-p[b+2]],length=Math.hypot(...delta),limit=c.restLength*(1+strainLimit),wa=this._weights[c.a],wb=this._weights[c.b];if(length<=limit+1e-12)continue;
          if(wa+wb<=0){this.strainLimitStats.conflicts++;continue;}
          const oldA=guarded(c.a)?Array.from(p.slice(a,a+3)):null,oldB=guarded(c.b)?Array.from(p.slice(b,b+3)):null;
          const correction=(length-limit)/(length*(wa+wb));for(let k=0;k<3;k++){p[a+k]-=delta[k]*correction*wa;p[b+k]+=delta[k]*correction*wb;}this.strainLimitStats.corrections++;if(oldA&&wa)guardVertex(c.a,oldA);if(oldB&&wb)guardVertex(c.b,oldB);
        }
        this._enforceAnchors();
        if(collisionMesh&&edgeCollision){
          const previousBodyPositions=sub===0&&pass===0&&this._edgeMeshRevision!==collisionMesh.revision&&collisionMesh.previousPositions?collisionMesh.previousPositions:collisionMesh.positions;
          const result=solveEdgeContact(this,{previousPositions:this._contactStage,bodyMesh:collisionMesh,previousBodyPositions,thickness:collisionThickness,continuous:continuousCollision,discrete:false,self:false});
          this._edgeMeshRevision=collisionMesh.revision;
          const stats=this.collisionStats.edgeContact||(this.collisionStats.edgeContact={contacts:0,candidates:0,continuousContacts:0,unsupportedCoplanar:0,unsupportedParallel:0,kinematicConflicts:0,unresolvedTemporalContacts:0,edgeEdgeCCD:true,coplanarCovered:false,fullGuarantee:false,broadphaseOverflow:false});
          for(const key of ['contacts','candidates','continuousContacts','unsupportedCoplanar','unsupportedParallel','kinematicConflicts','unresolvedTemporalContacts'])stats[key]+=result[key]||0;
          stats.broadphaseOverflow||=result.broadphaseOverflow;
        }
        if (collider) for (let i = 0; i < this._weights.length; i++) {
          if (!this._weights[i]) continue;
          const j = i * 3, projection = collider(p[j], p[j + 1], p[j + 2]);
          if (projection && projection.length === 3 && projection.every(Number.isFinite)) p.set(projection, j);
        }
      }
      if(selfCollision){
        const settings=selfCollision===true?{thickness:collisionThickness,continuous:continuousCollision}:selfCollision;
        const result=solveSelfCollision(this,{...settings,previousPositions:this._previous});
        for(const key of ['contacts','candidates','continuousContacts','movingTrianglesSkipped'])this.collisionStats[key]+=result[key];
        for(const key of ['algorithm','continuousAlgorithm','edgeEdgeCCD','movingTriangleCCD','broadphaseOverflow'])this.collisionStats[key]=result[key];
      }
      if(collisionMesh){
        const result=solveMeshCollision(this,collisionMesh,{thickness:collisionThickness,continuous:continuousCollision,previousPositions:this._previous});
        for(const key of ['contacts','candidates','continuousContacts','movingTrianglesSkipped'])this.collisionStats[key]+=result[key];
        for(const key of ['algorithm','continuousAlgorithm','edgeEdgeCCD','movingTriangleCCD','broadphaseOverflow'])this.collisionStats[key]=result[key];
      }
      if(collisionMesh&&bodyVertexCollision){
        const previousBodyPositions=sub===0&&this._bodyVertexRevision!==collisionMesh.revision&&collisionMesh.previousPositions?collisionMesh.previousPositions:collisionMesh.positions;
        const result=solveBodyVertexContacts(this,collisionMesh,{thickness:collisionThickness,continuous:continuousCollision,discrete:!continuousCollision,previousPositions:this._previous,previousBodyPositions});
        this._bodyVertexRevision=collisionMesh.revision;
        this.collisionStats.bodyVertexContacts=(this.collisionStats.bodyVertexContacts||0)+result.contacts;this.collisionStats.bodyVertexContinuousContacts=(this.collisionStats.bodyVertexContinuousContacts||0)+result.continuousContacts;this.collisionStats.bodyVertexAlgorithm=result.algorithm;this.collisionStats.bodyVertexContinuousAlgorithm=result.continuousAlgorithm;this.collisionStats.bodyVertexMovingTriangleCCD=result.movingTriangleCCD;
        if(collider)for(let i=0;i<this._weights.length;i++){if(!this._weights[i])continue;const j=i*3,q=collider(p[j],p[j+1],p[j+2]);if(q&&q.length===3&&q.every(Number.isFinite))p.set(q,j);}
      }
      if(surfaceCollision&&collider){const result=solveSurfaceCollision(this,collider,{passes:surfacePasses});this.collisionStats.surfaceContacts=(this.collisionStats.surfaceContacts||0)+result.contacts;this.collisionStats.surfaceCheckedSamples=(this.collisionStats.surfaceCheckedSamples||0)+result.checkedSamples;this.collisionStats.surfaceMaxCorrectionM=Math.max(this.collisionStats.surfaceMaxCorrectionM||0,result.maxCorrectionM);this.collisionStats.surfaceAlgorithm=result.algorithm;this.collisionStats.kinematicConflicts=(this.collisionStats.kinematicConflicts||0)+result.kinematicConflicts;}
      // Pairwise mesh/self responses can re-enter the signed body after the
      // structural-pass projection. Preserve endpoint feasibility last; this
      // does not certify the intervening path or unsampled cloth face interior.
      if(collider)for(let i=0;i<this._weights.length;i++){
        if(!this._weights[i])continue;const j=i*3,q=collider(p[j],p[j+1],p[j+2]);
        if(q?.length===3&&q.every(Number.isFinite))p.set(q,j);
      }
      for (let i = 0; i < this._weights.length; i++) {
        const j = i * 3;
        if (!this._weights[i]) { v.fill(0, j, j + 3); continue; }
        for (let k = 0; k < 3; k++) v[j + k] = (p[j + k] - this._previous[j + k]) / h;
        // Probe for active contact after projection. Remove normal velocity and
        // damp tangential speed; collider only needs to return closest projection.
        if (collider) {
          const probe = collider(p[j] + v[j] * h, p[j + 1] + v[j + 1] * h, p[j + 2] + v[j + 2] * h);
          if (probe) {
            const nx = probe[0] - p[j] - v[j] * h, ny = probe[1] - p[j + 1] - v[j + 1] * h, nz = probe[2] - p[j + 2] - v[j + 2] * h;
            const len = Math.hypot(nx, ny, nz);
            if (len > EPS) {
              const dot = (v[j] * nx + v[j + 1] * ny + v[j + 2] * nz) / (len * len);
              if (dot < 0) { v[j] -= nx * dot; v[j + 1] -= ny * dot; v[j + 2] -= nz * dot; }
            }
            const f = 1 - clamp(friction, 0, 1);
            v[j] *= f; v[j + 1] *= f; v[j + 2] *= f;
          }
        }
      }
    }
    this.grabForceN = 0;
    if (this.grabbed) {
      const index = this.grabbed.index;
      let fx = 0, fy = 0, fz = 0;
      for (const c of this.constraints) {
        if(this._usesTriangleShear(c))continue;
        if (c.a !== index && c.b !== index) continue;
        const other = c.a === index ? c.b : c.a;
        const dx = p[index * 3] - p[other * 3], dy = p[index * 3 + 1] - p[other * 3 + 1], dz = p[index * 3 + 2] - p[other * 3 + 2];
        const len = Math.hypot(dx, dy, dz);
        if (len > EPS) { const scale = c.lambda / (h * h * len); fx += dx * scale; fy += dy * scale; fz += dz * scale; }
      }
      for(const element of this._shearElements){const a=element.ids.indexOf(index);if(a<0)continue;const state=shearState(element,p);if(state){fx+=state.gradients[a][0]*element.lambda/(h*h);fy+=state.gradients[a][1]*element.lambda/(h*h);fz+=state.gradients[a][2]*element.lambda/(h*h);}}
      // Constraint reaction only: estimated at the final substep, not a calibrated
      // load-cell reading and excludes the grasped particle's external body force.
      this.grabForceN = Math.hypot(fx, fy, fz);
    }
    this.collisionStats.strainLimiting=copy(this.strainLimitStats);
    this._strainDirty = true;
  }

  _uvPoints(indices) {
    const points = indices.map(i => [this.uv[2 * i], this.uv[2 * i + 1]]);
    if (this.kind === 'tube'||this.kind==='stocking') {
      const lo = Math.min(...points.map(p => p[0])), hi = Math.max(...points.map(p => p[0]));
      if (hi - lo > 0.5) for (const p of points) if (p[0] < 0.5) p[0]++;
    }
    return points;
  }

  cutSegmentUV(a, b, radius = 0.012) {
    if (!a?.every(Number.isFinite) || !b?.every(Number.isFinite)) return { removedFaces: 0, removedConstraints: 0, removedMass: 0 };
    a = [...a]; b = [...b];
    if ((this.kind === 'tube'||this.kind==='stocking') && a[0] >= 0 && a[0] <= 1 && b[0] >= 0 && b[0] <= 1 && Math.abs(a[0] - b[0]) > 0.5) b[0] += b[0] < a[0] ? 1 : -1;
    radius = Math.max(0, radius);
    const oldFaces = this.triangles.length / 3, oldConstraints = this.constraints.length, oldMass = this.mass;
    const lines = this.kind === 'tube'||this.kind==='stocking' ? [-1, 0, 1].map(s => [[a[0] + s, a[1]], [b[0] + s, b[1]]]) : [[a, b]];
    const keep = [];
    for (let j = 0; j < this.triangles.length; j += 3) {
      const face = this.triangles.slice(j, j + 3), p = this._uvPoints(face);
      const hit = lines.some(([start, end]) => insideTriangle(start, ...p) || insideTriangle(end, ...p) || p.some((v, k) => segmentDistance(start, end, v, p[(k + 1) % 3]) <= radius));
      if (!hit) keep.push(...face);
    }
    this.triangles = keep;
    this._rebuildTopology();
    this.constraints = this.constraints.filter(c => {
      if (!this.active[c.a] || !this.active[c.b]) return false;
      const [p, q] = this._uvPoints([c.a, c.b]);
      return !lines.some(([start, end]) => segmentDistance(start, end, p, q) <= radius);
    });
    for (const i of [...this.pins]) if (!this.active[i]) { this.pins.delete(i); this.pinTargets.delete(i); }
    if (this.grabbed && !this.active[this.grabbed.index]) this.release();
    const result = { removedFaces: oldFaces - keep.length / 3, removedConstraints: oldConstraints - this.constraints.length, removedMass: Math.max(0, oldMass - this.mass) };
    this.removedFaces += result.removedFaces; this.removedMass += result.removedMass;
    this.cuts.push({ a: [...a], b: [...b], radius, ...result });
    return result;
  }

  incisionSegmentUV(a,b) {
    const plan=incisionPlan(this,a,b);if(!plan.ok)return plan;
    const n=this.positions.length/3,count=n+plan.addedVertices;
    if(count>40000)return {ok:false,reason:'切口超过当前支持的四万顶点上限'};
    for(const field of ['positions','rest','velocities','uv']){
      const width=field==='uv'?2:3,next=new Float64Array(count*width);next.set(this[field]);
      for(const {source,index} of plan.vertexMap)next.set(this[field].slice(source*width,source*width+width),index*width);this[field]=next;
    }
    const revision=(this.metadata.topologyRevision||0)+1;this.metadata.topologyRevision=revision;
    for(const item of plan.vertexMap){this.sourceVertices.push(this.sourceVertices[item.source]);item.id=`${this.vertexIds[item.source]}:split-${revision}-${item.index}`;this.vertexIds.push(item.id);if(this.pins.has(item.source)){this.pins.add(item.index);this.pinTargets.set(item.index,[...this.pinTargets.get(item.source)]);}}
    this.triangles=plan.triangles;this.constraints=plan.constraints;this.layout='edited-grid';this._rebuildTopology();
    const result={ok:true,path:plan.path,pathA:plan.pathA,pathB:plan.pathB,vertexMap:plan.vertexMap,sourceVertices:[...this.sourceVertices],addedVertices:plan.addedVertices,removedConstraints:plan.removedConstraints,removedFaces:0,removedMass:0};
    this.cuts.push({type:'incision',a:[...a],b:[...b],pathA:[...plan.pathA],pathB:[...plan.pathB],addedVertices:plan.addedVertices});return result;
  }

  sewPaths(pathA,pathB,{compliance=BASE_COMPLIANCE.seam,restLength=.002}={}) {
    const pairs=pairBoundaryPaths(this,pathA,pathB);
    if(!pairs?.length||!Number.isFinite(compliance)||compliance<0||!Number.isFinite(restLength)||restLength<=0)return {ok:false,reason:'请选择连续的两段边界路径'};
    if(pairs.some(([a,b])=>this.constraints.some(c=>c.kind==='seam'&&(c.a===a&&c.b===b||c.a===b&&c.b===a))))return {ok:false,reason:'该边界段已有缝线'};
    const sequence=(this.metadata.seamSequence||0)+1;this.metadata.seamSequence=sequence;const seamId=`seam-${sequence}`;
    for(const [a,b] of pairs)this.constraints.push({a,b,kind:'seam',seamId,restLength,baseRestLength:restLength,compliance,lambda:0,stiffness:1});
    this._strainDirty=true;return {ok:true,seamId,pairs};
  }
  unstitch(seamId) {
    const before=this.constraints.length;this.constraints=this.constraints.filter(c=>c.kind!=='seam'||c.seamId!==seamId);
    this._strainDirty=true;return {ok:before!==this.constraints.length,removed:before-this.constraints.length,seamId};
  }

  sew(a, b) {
    if (a === b || !this.boundary.has(a) || !this.boundary.has(b)) return { ok: false, reason: '请选择两个不同的边界顶点' };
    if (this.constraints.some(c => c.kind === 'seam' && (c.a === a && c.b === b || c.a === b && c.b === a))) return { ok: false, reason: '这两个顶点已经缝合' };
    const c = { a, b, kind: 'seam', restLength: 0.002, baseRestLength: 0.002, compliance: BASE_COMPLIANCE.seam, lambda: 0, stiffness: 1 };
    this.constraints.push(c); this._strainDirty = true;
    return { ok: true, seam: { ...c } };
  }

  addLink(a, b, { kind = 'knit', compliance = 0.01, restLength = dist3(this.rest, a, b) } = {}) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b || !this.active[a] || !this.active[b] ||
        !(restLength > 0) || !Number.isFinite(restLength) || !(compliance >= 0) || !Number.isFinite(compliance)) return { ok: false, reason: '无效的物理连接' };
    const c = { a, b, kind, restLength, baseRestLength: restLength, compliance, lambda: 0, stiffness: 1 };
    this.constraints.push(c); this._strainDirty = true;
    return { ok: true, constraint: { ...c } };
  }

  setRegion(region, parameters) {
    const u0 = Math.min(region.u0, region.u1), u1 = Math.max(region.u0, region.u1), v0 = Math.min(region.v0, region.v1), v1 = Math.max(region.v0, region.v1);
    let changed = 0;
    for (const c of this.constraints) {
      if (c.kind === 'seam') continue;
      const [a, b] = this._uvPoints([c.a, c.b]);
      let u = (a[0] + b[0]) / 2; if (u > 1) u--;
      const v = (a[1] + b[1]) / 2;
      if (u < u0 || u > u1 || v < v0 || v > v1) continue;
      if (Number.isFinite(parameters[c.kind])) {
        c.stiffness = clamp(parameters[c.kind], 0.01, 100);
        c.compliance = BASE_COMPLIANCE[c.kind] / c.stiffness;
        changed++;
      }
      if (Number.isFinite(parameters.restScale)) {
        c.restLength = c.baseRestLength * clamp(parameters.restScale, 0.5, 1.5);
        changed++;
      }
      c.lambda = 0;
    }
    this.regions.push({ region: { u0, v0, u1, v1 }, parameters: { ...parameters } });
    this._strainDirty = true;
    return { changed };
  }

  resetPose() {
    this.positions.set(this.rest); this.velocities.fill(0); this.grabbed = null; this.grabForceN = 0;
    this.pinTargets = new Map([...this.pins].map(i => [i, [...this.rest.slice(3 * i, 3 * i + 3)]]));
    for (const c of this.constraints) c.lambda = 0;
    this._strainDirty = true;
  }

  _ensureStrain() {
    if (!this._strainDirty) return;
    this._strain.fill(0); let sum = 0, count = 0, max = 0;
    for (const c of this.constraints) {
      if (c.kind === 'seam' || c.kind === 'bend') continue;
      const strain = Math.abs(dist3(this.positions, c.a, c.b) / c.restLength - 1);
      this._strain[c.a] = Math.max(this._strain[c.a], strain); this._strain[c.b] = Math.max(this._strain[c.b], strain);
      max = Math.max(max, strain); sum += strain; count++;
    }
    this._maxStrain = max; this._meanStrain = sum / (count || 1); this._strainDirty = false;
    for(const element of this._shearElements){const state=shearState(element,this.positions);element.gamma=state?.gamma||0;}
  }
  vertexStrain(index) { this._ensureStrain(); return this._strain[index] || 0; }
  stats() {
    this._ensureStrain();
    const limiting=copy(this.collisionStats.strainLimiting||this.strainLimitStats);
    limiting.maxResidualEngineeringStrain=limiting.limitEngineeringStrain===null?0:this.constraints.filter(c=>['weft','warp','shear','toe-cap'].includes(c.kind)).reduce((maximum,c)=>Math.max(maximum,dist3(this.positions,c.a,c.b)/c.restLength-1-limiting.limitEngineeringStrain),0);
    return { vertices: this.active.reduce((a, b) => a + b, 0), totalVertices: this.positions.length / 3,
      faces: this.triangles.length / 3, constraints: this.constraints.length, pins: this.pins.size,
      maxStrain: this._maxStrain, meanStrain: this._meanStrain, seams: this.constraints.filter(c => c.kind === 'seam').length,
      removedFaces: this.removedFaces, removedMass: this.removedMass, mass: this.mass, boundaryVertices: this.boundary.size, grabForceN: this.grabForceN,collision:copy(this.collisionStats),strainLimiting:limiting,
      materialShear:{elements:this._shearElements.length,unsupportedFaces:this._hasShearLaw?this.triangles.length/3-this._shearElements.length:0,maxEngineeringShear:this._shearElements.reduce((s,e)=>Math.max(s,Math.abs(e.gamma)),0),strainMeasure:'tan-angle-change',forceMeasure:'area-times-tension-N-per-m',physicsValidated:false} };
  }

  snapshot() {
    return { version: 1, kind: this.kind, cols: this.cols, rows: this.rows, density: this.density,
      layout:this.layout,gridVertexCount:this.gridVertexCount,sourceVertices:[...this.sourceVertices],vertexIds:[...this.vertexIds],metadata:copy(this.metadata),
      selfCollision:copy(this.selfCollision),collisionStats:copy(this.collisionStats),
      materialLaw:copy(this.materialLaw),
      strainLimit:this.strainLimit,strainLimitStats:copy(this.strainLimitStats),
      garment:copy(this.garment??null),
      positions: [...this.positions], rest: [...this.rest], uv: [...this.uv], triangles: [...this.triangles],
      velocities: [...this.velocities], constraints: this.constraints.map(c => ({ ...c })), pins: [...this.pins],
      pinTargets: [...this.pinTargets].map(([i, p]) => [i, [...p]]), grabbed: copy(this.grabbed),
      removedFaces: this.removedFaces, removedMass: this.removedMass, initialMass: this.initialMass, grabForceN: this.grabForceN,
      cuts: copy(this.cuts), regions: copy(this.regions) };
  }
  static fromSnapshot(saved) {
    if (saved?.version !== 1 || !Array.isArray(saved.positions) || saved.positions.length % 3 || !saved.positions.every(Number.isFinite)) throw new Error('无效的物理快照');
    const n = saved.positions.length / 3;
    const vertex = i => Number.isInteger(i) && i >= 0 && i < n;
    const finiteArray = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
    const gridCount=saved.gridVertexCount??saved.cols*saved.rows,layout=saved.layout??'grid';
    if (!['patch', 'tube','stocking'].includes(saved.kind) || !Number.isInteger(saved.cols) || !Number.isInteger(saved.rows) ||
        saved.cols < 3 || saved.cols > 100 || saved.rows < 3 || saved.rows > 100 || saved.cols * saved.rows !== gridCount ||
        !['grid','edited-grid'].includes(layout)||layout==='grid'&&gridCount!==n||layout==='edited-grid'&&gridCount>n||
        layout==='edited-grid'&&(!Array.isArray(saved.sourceVertices)||!Array.isArray(saved.vertexIds))||
        saved.sourceVertices&&(!Array.isArray(saved.sourceVertices)||saved.sourceVertices.length!==n||!saved.sourceVertices.every(i=>Number.isInteger(i)&&i>=0&&i<gridCount))||
        saved.vertexIds&&(!Array.isArray(saved.vertexIds)||saved.vertexIds.length!==n||new Set(saved.vertexIds).size!==n||!saved.vertexIds.every(i=>typeof i==='string'&&i.length>0&&i.length<256))||
        n < 3 || n > 40000 || !finiteArray(saved.rest, n * 3) || !finiteArray(saved.uv, n * 2) || !finiteArray(saved.velocities, n * 3) ||
        !Array.isArray(saved.triangles) || saved.triangles.length % 3 || !saved.triangles.every(vertex) ||
        !Array.isArray(saved.constraints) || !saved.constraints.every(c => vertex(c.a) && vertex(c.b) && c.a !== c.b && typeof c.kind === 'string' && c.restLength > 0 && Number.isFinite(c.restLength) && c.baseRestLength > 0 && Number.isFinite(c.baseRestLength) && c.compliance >= 0 && Number.isFinite(c.compliance) && Number.isFinite(c.lambda)) ||
        !Array.isArray(saved.pins) || !saved.pins.every(vertex) || !Array.isArray(saved.pinTargets) || !saved.pinTargets.every(p => Array.isArray(p) && vertex(p[0]) && finiteArray(p[1], 3)) ||
        !(saved.density > 0) || !Number.isFinite(saved.density) || !Array.isArray(saved.cuts) || !Array.isArray(saved.regions) ||
        saved.grabbed && (!vertex(saved.grabbed.index) || !finiteArray(saved.grabbed.target, 3))) throw new Error('无效的物理快照拓扑');
    const pinned = new Set(saved.pins), targets = new Set(saved.pinTargets.map(([i]) => i));
    if (pinned.size !== saved.pins.length || targets.size !== saved.pinTargets.length || pinned.size !== targets.size ||
        [...targets].some(i => !pinned.has(i))) throw new Error('无效的物理快照固定点');
    const model = new ClothModel(saved);
    if(saved.strainLimitStats)model.strainLimitStats=copy(saved.strainLimitStats);
    if(saved.garment)model.garment=copy(saved.garment);
    model.setSelfCollision(saved.selfCollision||false);if(saved.collisionStats)model.collisionStats=copy(saved.collisionStats);
    if(saved.materialLaw){model.setMaterialLaw(saved.materialLaw);model.constraints.forEach((c,i)=>{c.lambda=saved.constraints[i].lambda;});}
    model.velocities.set(saved.velocities);
    model.pinTargets = new Map(saved.pinTargets.map(([i, p]) => [i, [...p]]));
    model.grabbed = copy(saved.grabbed);
    for (const key of ['removedFaces', 'removedMass', 'initialMass', 'grabForceN']) model[key] = saved[key];
    model.cuts = copy(saved.cuts); model.regions = copy(saved.regions);
    return model;
  }
}

function buildGrid({ cols, rows, width, height, radius, kind }) {
  cols = clamp(Math.floor(cols), 3, 100); rows = clamp(Math.floor(rows), 3, 100);
  const positions = [], uv = [], triangles = [], constraints = [], pins = [], pairs = new Set();
  const periodic = kind === 'tube';
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const u = x / (periodic ? cols : cols - 1), v = y / (rows - 1);
    if (periodic) positions.push(Math.sin(u * Math.PI * 2) * radius, 0.25 + v * height, Math.cos(u * Math.PI * 2) * radius);
    else positions.push((u - 0.5) * width, 0.25 + v * height, 0);
    uv.push(u, v);
    if (y === rows - 1) pins.push(y * cols + x);
  }
  const at = (x, y) => y * cols + (x + cols) % cols;
  const link = (a, b, kind) => {
    const key = `${Math.min(a, b)},${Math.max(a, b)}`;
    if (pairs.has(key)) return; pairs.add(key);
    const restLength = dist3(positions, a, b);
    constraints.push({ a, b, kind, restLength, baseRestLength: restLength, compliance: BASE_COMPLIANCE[kind], lambda: 0, stiffness: 1 });
  };
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const a = at(x, y);
    if (x < cols - 1 || periodic) link(a, at(x + 1, y), 'weft');
    if (y < rows - 1) link(a, at(x, y + 1), 'warp');
    if ((x < cols - 1 || periodic) && y < rows - 1) {
      const b = at(x + 1, y), c = at(x, y + 1), d = at(x + 1, y + 1);
      triangles.push(a, b, d, a, d, c);
      link(a, d, 'shear'); link(b, c, 'shear');
    }
    if (x < cols - 2 || periodic) link(a, at(x + 2, y), 'bend');
    if (y < rows - 2) link(a, at(x, y + 2), 'bend');
  }
  return new ClothModel({ positions, uv, triangles, constraints, pins, kind, cols, rows });
}
export function createPatch({ cols = 24, rows = 28, width = 0.5, height = 0.65 } = {}) {
  return buildGrid({ cols, rows, width, height, kind: 'patch' });
}
export function createTube({ cols = 40, rows = 36, height = 0.85, radius = 0.1 } = {}) {
  return buildGrid({ cols, rows, height, radius, kind: 'tube' });
}
export const restoreModel = snapshot => ClothModel.fromSnapshot(snapshot);
