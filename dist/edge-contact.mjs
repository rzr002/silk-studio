/** Experimental linear edge/edge CCD, not an intersection-free solver.
 * Isolated cubic coplanarity roots are checked against finite segments. Floating
 * point root isolation, persistent coplanarity, parallel overlap, and the final
 * position projection do not provide the conservative guarantees of IPC/ACCD.
 * https://ipc-sim.github.io/C-IPC/file/paper.pdf
 * https://ipc-sim.github.io/file/IPC-supplement-A-technical.pdf
 */
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>Math.hypot(a[0],a[1],a[2]);
const mix=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
const point=(p,i)=>[p[i*3],p[i*3+1],p[i*3+2]];
const clamp=x=>Math.max(0,Math.min(1,x));
const triple=(a,b,c)=>dot(a,cross(b,c));
const polynomial=(c,t)=>((c[3]*t+c[2])*t+c[1])*t+c[0];
const topologyCache=new WeakMap(),bodyHashCache=new WeakMap();

function finiteVector(v){return v&&v.length===3&&Array.from(v).every(Number.isFinite);}
function validateEdge(e){if(!e||e.length!==2||!e.every(finiteVector))throw new Error('Invalid finite 3D edge');}
function quadraticRoots(a,b,c,eps){
  if(Math.abs(a)<=eps)return Math.abs(b)<=eps?[]:[-c/b];
  const discriminant=b*b-4*a*c,roundoff=eps*Math.max(1,b*b,Math.abs(4*a*c));
  if(discriminant < -roundoff)return [];
  if(Math.abs(discriminant)<=roundoff)return [-b/(2*a)];
  const root=Math.sqrt(discriminant),q=-.5*(b+(b>=0?root:-root));
  return q===0?[-b/(2*a)]:[q/a,c/q];
}
function rootsInStep(coefficients){
  const scale=Math.max(...coefficients.map(Math.abs));
  if(scale<1e-13)return null;
  const c=coefficients.map(x=>x/scale),eps=1e-12,roots=[];
  const add=t=>{if(t>=-1e-10&&t<=1+1e-10&&!roots.some(r=>Math.abs(r-clamp(t))<1e-8))roots.push(clamp(t));};
  if(Math.abs(c[3])<=eps){for(const t of quadraticRoots(c[2],c[1],c[0],eps))add(t);}
  else {
    const critical=quadraticRoots(3*c[3],2*c[2],c[1],eps).filter(t=>t>0&&t<1).sort((a,b)=>a-b),breaks=[0,...critical,1];
    for(const t of breaks)if(Math.abs(polynomial(c,t))<eps*8)add(t);
    for(let i=1;i<breaks.length;i++){
      let lo=breaks[i-1],hi=breaks[i],flo=polynomial(c,lo),fhi=polynomial(c,hi);
      if(flo*fhi>=0)continue;
      for(let k=0;k<70&&hi-lo>1e-12;k++){
        const mid=(lo+hi)/2,f=polynomial(c,mid);
        if(flo*f<=0){hi=mid;fhi=f;}else{lo=mid;flo=f;}
      }
      add((lo+hi)/2);
    }
  }
  return roots.sort((a,b)=>a-b);
}

/** Closest finite segments, including endpoints; parallel is returned explicitly. */
function segmentClosest(a,b,c,d){
  const u=sub(b,a),v=sub(d,c),r=sub(a,c),uu=dot(u,u),vv=dot(v,v),uv=dot(u,v),ur=dot(u,r),vr=dot(v,r);
  const determinant=uu*vv-uv*uv,parallel=determinant<=1e-12*uu*vv,degenerate=uu<1e-24||vv<1e-24;
  let s=0,t=0;
  if(uu<1e-24&&vv<1e-24){/* both points */}
  else if(uu<1e-24)t=clamp(vr/vv);
  else if(vv<1e-24)s=clamp(-ur/uu);
  else {
    s=parallel?0:clamp((uv*vr-ur*vv)/determinant);
    t=(uv*s+vr)/vv;
    if(t<0){t=0;s=clamp(-ur/uu);}else if(t>1){t=1;s=clamp((uv-ur)/uu);}
  }
  const pa=mix(a,b,s),pb=mix(c,d,t),delta=sub(pa,pb);
  return {s,t,pa,pb,delta,distance:norm(delta),parallel,degenerate};
}

/** All endpoints move linearly from previous to current. Normal points B -> A
 * immediately before the earliest valid isolated root, not at frame start. */
export function sweptEdgeEdge(aPrevious,aCurrent,bPrevious,bCurrent,{tolerance=1e-8}={}){
  for(const edge of [aPrevious,aCurrent,bPrevious,bCurrent])validateEdge(edge);
  if(!Number.isFinite(tolerance)||tolerance<=0)throw new Error('Invalid edge CCD tolerance');
  const origin=aPrevious[0],all=[...aPrevious,...aCurrent,...bPrevious,...bCurrent];
  const length=Math.max(...all.map(v=>norm(sub(v,origin))));
  const base={hit:false,status:'clear',coplanarCovered:false,fullGuarantee:false,numericPolicy:'floating-point-isolated-roots'};
  if(length<1e-15)return {...base,status:'unsupported-degenerate',parallel:true};
  const normalized=edge=>edge.map(p=>sub(p,origin).map(x=>x/length));
  const ap=normalized(aPrevious),ac=normalized(aCurrent),bp=normalized(bPrevious),bc=normalized(bCurrent),epsilon=tolerance/length;
  const u=sub(ap[1],ap[0]),v=sub(bp[0],ap[0]),w=sub(bp[1],ap[0]);
  const du=sub(sub(ac[1],ac[0]),u),dv=sub(sub(bc[0],ac[0]),v),dw=sub(sub(bc[1],ac[0]),w);
  const coefficients=[triple(u,v,w),triple(du,v,w)+triple(u,dv,w)+triple(u,v,dw),triple(du,dv,w)+triple(du,v,dw)+triple(u,dv,dw),triple(du,dv,dw)];
  const roots=rootsInStep(coefficients),at=t=>[mix(ap[0],ac[0],t),mix(ap[1],ac[1],t),mix(bp[0],bc[0],t),mix(bp[1],bc[1],t)];
  if(roots===null){
    const initial=segmentClosest(...at(0)),middle=segmentClosest(...at(.5)),last=segmentClosest(...at(1));
    if(initial.degenerate&&middle.degenerate&&last.degenerate)return {...base,status:'unsupported-degenerate',parallel:true};
    return {...base,status:'unsupported-coplanar',parallel:initial.parallel&&middle.parallel&&last.parallel};
  }
  for(const toi of roots){
    const edges=at(toi),contact=segmentClosest(...edges);
    if(contact.distance>epsilon)continue;
    if(contact.degenerate||contact.parallel)return {...base,status:contact.degenerate?'unsupported-degenerate':'unsupported-parallel',parallel:contact.parallel,toi};
    // There is no incoming side when the interval starts already intersecting.
    if(toi<=1e-10)return {...base,status:'initial-intersection',toi,s:contact.s,t:contact.t};
    const edgeNormal=cross(sub(edges[1],edges[0]),sub(edges[3],edges[2])),normalLength=norm(edgeNormal);
    let normal=edgeNormal.map(x=>x/normalLength),incoming=null;
    for(const gap of [1e-7,1e-6,1e-5,1e-4,1e-3,.01]){
      const before=segmentClosest(...at(Math.max(0,toi-gap)));
      if(before.distance>Math.max(epsilon*.01,1e-13)){incoming=before.delta;break;}
    }
    if(!incoming)return {...base,status:'unsupported-normal',toi,s:contact.s,t:contact.t};
    // Project separation onto the instantaneous normal. Nearby closest points
    // can slide along either segment, so their full vector is not a surface normal.
    if(dot(normal,incoming)<0)normal=normal.map(x=>-x);
    const delta=Math.min(1e-4,toi/2,(1-toi)/2),before=polynomial(coefficients,toi-delta),after=polynomial(coefficients,toi+delta);
    const tangential=delta>0&&before*after>0;
    return {...base,hit:true,status:'isolated-root',toi,s:contact.s,t:contact.t,normal,tangential,endpoint:contact.s<1e-8||contact.s>1-1e-8||contact.t<1e-8||contact.t>1-1e-8};
  }
  return base;
}

function validatePositions(p,label){
  if(!p||!p.length||p.length%3||!Array.from(p).every(Number.isFinite))throw new Error(`Invalid ${label} positions`);
}
function topology(owner,triangles,n){
  if(!triangles||triangles.length%3)throw new Error('Invalid edge topology');
  let cached=topologyCache.get(owner);
  if(cached&&cached.triangles===triangles&&cached.n===n&&cached.length===triangles.length)return cached;
  const unique=new Map(),adjacent=Array.from({length:n},()=>new Set());
  for(let k=0;k<triangles.length;k+=3){
    const ids=[triangles[k],triangles[k+1],triangles[k+2]];
    if(ids.some(i=>!Number.isInteger(i)||i<0||i>=n)||new Set(ids).size!==3)throw new Error('Invalid edge triangle indices');
    for(let j=0;j<3;j++){
      const a=Math.min(ids[j],ids[(j+1)%3]),b=Math.max(ids[j],ids[(j+1)%3]);
      unique.set(`${a}:${b}`,[a,b]);adjacent[a].add(b);adjacent[b].add(a);
    }
  }
  cached={triangles,n,length:triangles.length,edges:[...unique.values()],adjacent};topologyCache.set(owner,cached);return cached;
}
function sweptBounds(edge,previous,current,padding){
  const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(const id of edge)for(let k=0;k<3;k++){
    lo[k]=Math.min(lo[k],previous[id*3+k],current[id*3+k]);
    hi[k]=Math.max(hi[k],previous[id*3+k],current[id*3+k]);
  }
  return {lo:lo.map(v=>v-padding),hi:hi.map(v=>v+padding)};
}
const overlaps=(a,b)=>a.lo.every((v,k)=>v<=b.hi[k]&&a.hi[k]>=b.lo[k]);
function cells(bounds,size){
  const lo=bounds.lo.map(x=>Math.floor(x/size)),hi=bounds.hi.map(x=>Math.floor(x/size));
  return {lo,hi,count:(hi[0]-lo[0]+1)*(hi[1]-lo[1]+1)*(hi[2]-lo[2]+1)};
}
function eachCell(range,fn){for(let x=range.lo[0];x<=range.hi[0];x++)for(let y=range.lo[1];y<=range.hi[1];y++)for(let z=range.lo[2];z<=range.hi[2];z++)fn(`${x},${y},${z}`);}
function buildHash(edges,previous,current,size,padding){
  const hash=new Map(),overflow=[],bounds=edges.map(e=>sweptBounds(e,previous,current,padding));
  for(let i=0;i<edges.length;i++){
    const range=cells(bounds[i],size);
    if(range.count>4096){overflow.push(i);continue;}
    eachCell(range,key=>{let list=hash.get(key);if(!list){list=[];hash.set(key,list);}list.push(i);});
  }
  return {hash,overflow,bounds,size};
}
function meanEdgeLength(edges,p){let sum=0;for(const [a,b] of edges)sum+=norm(sub(point(p,a),point(p,b)));return sum/Math.max(1,edges.length);}

/** Position-level prototype response. A contact is detected on the original
 * linear trajectory; its incoming TOI plane then constrains final endpoints.
 * This is neither a line search nor a conservative advancement method. It does
 * not re-check every new trajectory introduced by sequential corrections. */
export function solveEdgeContact(model,{previousPositions,bodyMesh=null,previousBodyPositions=bodyMesh?.previousPositions||bodyMesh?.positions,thickness=.001,self=false,continuous=true,discrete=false,cellSize=null,maxCandidates=1000000}={}){
  const p=model?.positions;
  validatePositions(p,'cloth');validatePositions(previousPositions,'previous cloth');
  if(previousPositions.length!==p.length)throw new Error('Previous cloth position count mismatch');
  if(![self,continuous,discrete].every(value=>typeof value==='boolean'))throw new Error('Edge contact modes must be boolean');
  if(!Number.isFinite(thickness)||thickness<=0||thickness>.1||cellSize!==null&&(!Number.isFinite(cellSize)||cellSize<=0)||!Number.isSafeInteger(maxCandidates)||maxCandidates<1)throw new Error('Invalid edge contact options');
  const n=p.length/3,cloth=topology(model,model.triangles,n);
  if(model.inverseMass&&(model.inverseMass.length!==n||Array.from(model.inverseMass).some(x=>!Number.isFinite(x)||x<0)))throw new Error('Invalid inverse masses');
  let body=null;
  if(bodyMesh){
    validatePositions(bodyMesh.positions,'body');validatePositions(previousBodyPositions,'previous body');
    if(previousBodyPositions.length!==bodyMesh.positions.length)throw new Error('Previous body position count mismatch');
    body=topology(bodyMesh,bodyMesh.indices||bodyMesh.triangles,bodyMesh.positions.length/3);
  }
  const stats={contacts:0,candidates:0,continuousContacts:0,edgeEdgeCCD:true,coplanarCovered:false,unsupportedCoplanar:0,unsupportedParallel:0,unsupportedDegenerate:0,initialIntersections:0,broadphaseOverflow:false,fullGuarantee:false,trajectoryValidated:false,response:'incoming-toi-plane-projection',kinematicConflicts:0,excludedPairs:0,unresolvedTemporalContacts:0,alreadyOnIncomingSide:0,tangentialContacts:0,bodyHashReused:false,discreteCovered:false};
  if(!continuous){if(discrete)stats.discreteUnsupported=true;return stats;}
  const current=Float64Array.from(p),previous=previousPositions===p?Float64Array.from(previousPositions):previousPositions;
  const size=cellSize||Math.max(.01,thickness*4,meanEdgeLength(cloth.edges,model.rest||p)*1.5),padding=Math.max(thickness,1e-8);
  const clothBounds=cloth.edges.map(e=>sweptBounds(e,previous,current,padding));
  const weight=i=>model.active&&!model.active[i]||model.pins?.has(i)||model.grabbed?.index===i?0:(model.inverseMass?.[i]??1);
  const account=result=>{
    if(result.status==='unsupported-coplanar')stats.unsupportedCoplanar++;
    if(result.parallel)stats.unsupportedParallel++;
    if(result.status==='unsupported-degenerate')stats.unsupportedDegenerate++;
    if(result.status==='initial-intersection')stats.initialIntersections++;
  };
  const process=(a,b,bPrevious,bCurrent,isSelf)=>{
    if(stats.candidates>=maxCandidates){stats.broadphaseOverflow=true;return false;}
    stats.candidates++;
    const hit=sweptEdgeEdge(a.map(i=>point(previous,i)),a.map(i=>point(current,i)),b.map(i=>point(bPrevious,i)),b.map(i=>point(bCurrent,i)));
    account(hit);if(!hit.hit)return true;
    stats.continuousContacts++;if(hit.tangential)stats.tangentialContacts++;
    const weights=[1-hit.s,hit.s,-(1-hit.t),-hit.t],ids=[...a,...b],masses=[weight(a[0]),weight(a[1]),isSelf?weight(b[0]):0,isSelf?weight(b[1]):0];
    const denominator=masses.reduce((sum,m,i)=>sum+m*weights[i]*weights[i],0);
    if(denominator<1e-20){stats.kinematicConflicts++;return true;}
    const finalA=mix(point(p,a[0]),point(p,a[1]),hit.s),finalB=mix(point(isSelf?p:bCurrent,b[0]),point(isSelf?p:bCurrent,b[1]),hit.t);
    const penetration=thickness-dot(sub(finalA,finalB),hit.normal);
    // Earlier pair projections may already place this final contact point on
    // the incoming side. This counter is NOT a measured remaining penetration
    // count: the corrected trajectory has not been conservatively re-checked.
    if(penetration<=0){stats.unresolvedTemporalContacts++;stats.alreadyOnIncomingSide++;return true;}
    const amount=penetration/denominator;
    for(let j=0;j<4;j++)if(masses[j])for(let k=0;k<3;k++)p[ids[j]*3+k]+=amount*masses[j]*weights[j]*hit.normal[k];
    stats.contacts++;return true;
  };
  const traverse=(other,hash,isSelf)=>{
    if(hash.overflow.length)stats.broadphaseOverflow=true;
    for(let i=0;i<cloth.edges.length;i++){
      const range=cells(clothBounds[i],size),candidates=new Set(hash.overflow);
      if(range.count>4096){stats.broadphaseOverflow=true;for(let j=0;j<other.edges.length;j++)candidates.add(j);}
      else eachCell(range,key=>{for(const j of hash.hash.get(key)||[])candidates.add(j);});
      for(const j of candidates){
        if(isSelf&&j<=i)continue;
        const a=cloth.edges[i],b=other.edges[j];
        if(isSelf&&a.some(x=>b.some(y=>x===y||cloth.adjacent[x].has(y)))){stats.excludedPairs++;continue;}
        if(!overlaps(clothBounds[i],hash.bounds[j]))continue;
        if(!process(a,b,isSelf?previous:previousBodyPositions,isSelf?current:bodyMesh.positions,isSelf))return false;
      }
    }
    return true;
  };
  if(body){
    const revision=bodyMesh.revision;
    let cached=bodyHashCache.get(bodyMesh);
    if(revision!==undefined&&cached&&cached.revision===revision&&cached.indices===body.triangles&&cached.current===bodyMesh.positions&&cached.previous===previousBodyPositions&&cached.size===size&&cached.padding===padding){stats.bodyHashReused=true;}
    else {cached={...buildHash(body.edges,previousBodyPositions,bodyMesh.positions,size,padding),revision,indices:body.triangles,current:bodyMesh.positions,previous:previousBodyPositions,padding};if(revision!==undefined)bodyHashCache.set(bodyMesh,cached);}
    if(!traverse(body,cached,false))return stats;
  }
  if(self)traverse(cloth,buildHash(cloth.edges,previous,current,size,padding),true);
  return stats;
}
export const solveEdgeContacts=solveEdgeContact;
