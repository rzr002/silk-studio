/** Spatial-hash nonadjacent vertex/triangle self contact. Finite thickness and
 * inverse-mass reaction; excludes incident and one-ring neighbours. Optional
 * continuous mode tests moving vertex segments against STATIONARY triangles.
 * Moving triangles and edge/edge CCD are explicitly not covered by this module.
 */
const vec=(p,i)=>[p[i*3],p[i*3+1],p[i*3+2]],sub=(a,b)=>a.map((v,k)=>v-b[k]),dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function closest(p,a,b,c){
  const ab=sub(b,a),ac=sub(c,a),ap=sub(p,a),d1=dot(ab,ap),d2=dot(ac,ap);let w;
  if(d1<=0&&d2<=0)w=[1,0,0];
  else {const bp=sub(p,b),d3=dot(ab,bp),d4=dot(ac,bp);
    if(d3>=0&&d4<=d3)w=[0,1,0];
    else {const vc=d1*d4-d3*d2;
      if(vc<=0&&d1>=0&&d3<=0){const v=d1/(d1-d3);w=[1-v,v,0];}
      else {const cp=sub(p,c),d5=dot(ab,cp),d6=dot(ac,cp);
        if(d6>=0&&d5<=d6)w=[0,0,1];
        else {const vb=d5*d2-d1*d6;
          if(vb<=0&&d2>=0&&d6<=0){const v=d2/(d2-d6);w=[1-v,0,v];}
          else {const va=d3*d6-d5*d4;
            if(va<=0&&d4-d3>=0&&d5-d6>=0){const v=(d4-d3)/((d4-d3)+(d5-d6));w=[0,1-v,v];}
            else {const sum=va+vb+vc;if(Math.abs(sum)<1e-20)return null;const v=vb/sum,t=vc/sum;w=[1-v-t,v,t];}
          }
        }
      }
    }
  }
  return {weights:w,point:a.map((v,k)=>v*w[0]+b[k]*w[1]+c[k]*w[2])};
}
export function solveSelfCollision(model,{thickness=.003,continuous=false,previousPositions=null,cellSize=null}={}){
  if(!Number.isFinite(thickness)||thickness<=0||thickness>.1)throw new Error('Invalid self contact thickness');
  const p=model.positions,tri=model.triangles,n=p.length/3;
  const stats={contacts:0,candidates:0,continuousContacts:0,movingTrianglesSkipped:0,algorithm:'spatial-hash-vertex-triangle',continuousAlgorithm:continuous?'moving-vertex-static-triangle':'disabled',edgeEdgeCCD:false,movingTriangleCCD:false,broadphaseOverflow:false};
  let cache=model._selfTopology;
  if(!cache||cache.triangles!==tri||cache.n!==n||cache.thickness!==thickness||cache.rest!==model.rest){
    const adjacent=Array.from({length:n},()=>new Set()),edges=Array.from({length:n},()=>new Map()),rest=model.rest||p;
    for(let j=0;j<tri.length;j+=3)for(let a=0;a<3;a++)for(let b=0;b<3;b++){const from=tri[j+a],to=tri[j+b];adjacent[from].add(to);if(from!==to)edges[from].set(to,Math.hypot(...sub(vec(rest,from),vec(rest,to))));}
    // Ignore a material-local neighbourhood measured along rest mesh edges.
    // Euclidean proximity alone would wrongly exempt separate folded layers.
    for(let source=0;source<n;source++){const distances=new Map([[source,0]]),queue=[source];while(queue.length){let best=0;for(let j=1;j<queue.length;j++)if(distances.get(queue[j])<distances.get(queue[best]))best=j;const from=queue.splice(best,1)[0],distance=distances.get(from);for(const [to,length] of edges[from]){const next=distance+length;if(next>thickness*2+1e-12||next>=(distances.get(to)??Infinity))continue;distances.set(to,next);adjacent[source].add(to);queue.push(to);}}}
    cache={triangles:tri,n,adjacent,thickness,rest:model.rest};model._selfTopology=cache;
  }
  const fixed=model._fixedGeometryRevision!==undefined;
  let geometry=model._collisionHash;
  if(!fixed||!geometry||geometry.revision!==model._fixedGeometryRevision||geometry.thickness!==thickness||geometry.cellSize!==cellSize||geometry.triangles!==tri){
    let mean=0;for(let j=0;j<tri.length;j+=3)mean+=Math.hypot(...sub(vec(p,tri[j]),vec(p,tri[j+1])));
    geometry={revision:model._fixedGeometryRevision,thickness,cellSize,triangles:tri,size:cellSize||Math.max(thickness*2,mean/(tri.length/3||1)),hash:new Map(),overflow:[],faces:[]};
    const size=geometry.size,cell=v=>Math.floor(v/size);
    for(let f=0;f<tri.length/3;f++){const ids=tri.slice(f*3,f*3+3),v=ids.map(i=>vec(p,i));geometry.faces.push({ids,vertices:v});const lo=[0,1,2].map(k=>cell(Math.min(...v.map(a=>a[k]))-thickness)),hi=[0,1,2].map(k=>cell(Math.max(...v.map(a=>a[k]))+thickness));
      if((hi[0]-lo[0]+1)*(hi[1]-lo[1]+1)*(hi[2]-lo[2]+1)>4096){geometry.overflow.push(f);continue;}
      for(let x=lo[0];x<=hi[0];x++)for(let y=lo[1];y<=hi[1];y++)for(let z=lo[2];z<=hi[2];z++){const id=`${x},${y},${z}`;if(!geometry.hash.has(id))geometry.hash.set(id,[]);geometry.hash.get(id).push(f);}
    }
    if(fixed)model._collisionHash=geometry;
  }
  const {size,hash,overflow}=geometry;stats.broadphaseOverflow=!!overflow.length;
  const cell=v=>Math.floor(v/size),key=(x,y,z)=>`${x},${y},${z}`;
  const weight=i=>model.pins?.has(i)||model.grabbed?.index===i?0:model.inverseMass?.[i]??1;
  for(let index=0;index<n;index++){
    if(model.active&&!model.active[index]||fixed&&!weight(index))continue;
    const start=previousPositions?vec(previousPositions,index):vec(p,index),current=vec(p,index),candidates=new Set(overflow);
    const span=continuous?Math.ceil(Math.max(...sub(current,start).map(Math.abs))/size*2):1,steps=Math.max(1,Math.min(4096,span));if(span>4096)stats.broadphaseOverflow=true;
    for(let s=0;s<=steps;s++){const t=continuous?s/steps:1,q=start.map((v,k)=>v+(current[k]-v)*t);for(const f of hash.get(key(cell(q[0]),cell(q[1]),cell(q[2])))||[])candidates.add(f);}
    for(const face of candidates){const ids=geometry.faces[face].ids;if(ids.some(i=>cache.adjacent[index].has(i)))continue;stats.candidates++;
      const vertices=fixed?geometry.faces[face].vertices:ids.map(i=>vec(p,i)),now=vec(p,index),near=closest(now,...vertices);if(!near)continue;
      let delta=sub(now,near.point),distance=Math.hypot(...delta),normal,penetration,bary=near.weights,ccd=false;
      // Test the incoming trajectory first. Otherwise an endpoint just behind
      // the face would be repelled further through it by a double-sided contact.
      if(continuous&&previousPositions){
        if(ids.some(i=>Math.hypot(...sub(vec(previousPositions,i),vec(p,i)))>1e-9))stats.movingTrianglesSkipped++;
        else {
          normal=cross(sub(vertices[1],vertices[0]),sub(vertices[2],vertices[0]));const len=Math.hypot(...normal);
          if(len>1e-15){normal=normal.map(v=>v/len);const d0=dot(sub(start,vertices[0]),normal),d1=dot(sub(now,vertices[0]),normal);
            if(d0*d1<0){const t=d0/(d0-d1),hit=start.map((v,k)=>v+(now[k]-v)*t),on=closest(hit,...vertices);
              if(on&&Math.hypot(...sub(hit,on.point))<=1e-8){if(d0<0)normal=normal.map(v=>-v);bary=on.weights;penetration=thickness-dot(sub(now,on.point),normal);ccd=true;}
            }
          }
        }
      }
      if(!ccd&&distance<thickness){
        if(distance>1e-12)normal=delta.map(v=>v/distance);
        else {normal=cross(sub(vertices[1],vertices[0]),sub(vertices[2],vertices[0]));const len=Math.hypot(...normal);if(len<1e-15)continue;normal=normal.map(v=>v/len);if(previousPositions&&dot(sub(start,near.point),normal)<0)normal=normal.map(v=>-v);}
        penetration=thickness-distance;
      }else if(!ccd)continue;
      const w=weight(index),denominator=w+ids.reduce((s,i,k)=>s+weight(i)*bary[k]*bary[k],0);if(denominator<=0)continue;
      const correction=penetration/denominator;
      for(let k=0;k<3;k++){p[index*3+k]+=normal[k]*w*correction;for(let a=0;a<3;a++)p[ids[a]*3+k]-=normal[k]*weight(ids[a])*bary[a]*correction;}
      stats.contacts++;if(ccd)stats.continuousContacts++;
    }
  }
  return stats;
}

// Reuse the same broadphase and static-target segment detector for a rigid mesh.
// Signed inside/outside projection remains the caller's closed-body collider;
// this extra layer guards cloth vertex trajectories against frozen mesh faces.
export function solveMeshCollision(model,mesh,options={}) {
  const indices=mesh.indices||mesh.triangles,body=mesh.positions,n=model.positions.length/3,bn=body?.length/3;
  if(!body||body.length%3||!indices||indices.length%3||!Array.from(indices).every(i=>Number.isInteger(i)&&i>=0&&i<bn))throw new Error('Invalid body collision mesh');
  let cache=model._bodyCollisionCache;
  if(!cache||cache.indices!==indices||cache.n!==n||cache.bn!==bn){
    cache={indices,n,bn,virtual:{positions:new Float64Array((n+bn)*3),triangles:Array.from(indices,i=>i+n),active:new Uint8Array(n+bn),inverseMass:new Float64Array(n+bn)},previous:new Float64Array((n+bn)*3),seen:false};
    model._bodyCollisionCache=cache;
  }
  const virtual=cache.virtual;virtual.positions.set(model.positions);virtual.positions.set(body,n*3);
  virtual._fixedGeometryRevision=mesh.revision??Symbol('uncached mesh');
  virtual.active.fill(0);for(let i=0;i<n;i++)virtual.active[i]=model.active?.[i]??1;
  virtual.inverseMass.fill(0);virtual.inverseMass.set(model.inverseMass||new Float64Array(n).fill(1));virtual.pins=model.pins;virtual.grabbed=model.grabbed;
  cache.previous.set(options.previousPositions||model.positions);const changed=!cache.seen||cache.revision!==mesh.revision;
  cache.previous.set(changed&&mesh.previousPositions?.length===body.length?mesh.previousPositions:body,n*3);cache.revision=mesh.revision;cache.seen=true;
  const result=solveSelfCollision(virtual,{...options,previousPositions:cache.previous});
  model.positions.set(virtual.positions.subarray(0,n*3));return {...result,algorithm:'spatial-hash-cloth-vertex-body-triangle'};
}

/** Discrete barycentric face/edge contact with a caller-supplied closed-body
 * projection. Every centroid is checked; coarse faces also check edge midpoints
 * and three interior samples. This closes a vertex-only testing gap, but is not
 * exact triangle/triangle intersection or continuous surface collision.
 */
export function solveSurfaceCollision(model,collider,{passes=2,edgeThreshold=.04}={}) {
  const p=model.positions,tri=model.triangles,stats={contacts:0,checkedSamples:0,maxCorrectionM:0,kinematicConflicts:0,algorithm:'discrete-barycentric-body-contact',fullCCD:false};
  const weight=i=>model.pins?.has(i)||model.grabbed?.index===i?0:model.inverseMass?.[i]??1;
  const samples=[[1/3,1/3,1/3],[.5,.5,0],[0,.5,.5],[.5,0,.5],[.6,.2,.2],[.2,.6,.2],[.2,.2,.6]];
  for(let pass=0;pass<Math.max(1,Math.min(20,passes));pass++){let contacts=0;const changed=new Set();
    for(let face=0;face<tri.length;face+=3){const ids=tri.slice(face,face+3),maxEdge=Math.max(...ids.map((i,k)=>Math.hypot(...sub(vec(p,i),vec(p,ids[(k+1)%3])))));const count=maxEdge>edgeThreshold?7:1;
      for(let sample=0;sample<count;sample++){const b=samples[sample],point=[0,0,0];for(let a=0;a<3;a++)for(let k=0;k<3;k++)point[k]+=p[ids[a]*3+k]*b[a];const projected=collider(...point);stats.checkedSamples++;if(!projected||projected.length!==3||!projected.every(Number.isFinite))continue;
        const delta=sub(projected,point),length=Math.hypot(...delta);if(length<1e-9)continue;const denominator=ids.reduce((s,i,a)=>s+weight(i)*b[a]*b[a],0);if(denominator<=0){stats.kinematicConflicts++;continue;}
        for(let a=0;a<3;a++){const factor=weight(ids[a])*b[a]/denominator;if(!factor)continue;for(let k=0;k<3;k++)p[ids[a]*3+k]+=delta[k]*factor;changed.add(ids[a]);}
        stats.maxCorrectionM=Math.max(stats.maxCorrectionM,length);stats.contacts++;contacts++;
      }
    }
    // A shared-vertex face correction can approach another part of a concave
    // body. Reproject just the changed vertices, then repeat surface samples.
    for(const i of changed){const q=collider(...vec(p,i));if(q&&q.length===3&&q.every(Number.isFinite))p.set(q,i*3);}
    if(!contacts)break;
  }
  return stats;
}

// Coplanarity of four linearly moving points is cubic in time. Derivative
// intervals isolate all sign-changing roots, rather than testing only endpoints.
function rootsInStep(c){
  const tolerance=Math.max(...c.map(Math.abs),1e-30)*1e-11,critical=[];
  if(Math.abs(c[3])>tolerance){const a=3*c[3],b=2*c[2],d=b*b-4*a*c[1];if(d>=0){critical.push((-b-Math.sqrt(d))/(2*a),(-b+Math.sqrt(d))/(2*a));}}
  else if(Math.abs(c[2])>tolerance)critical.push(-c[1]/(2*c[2]));
  const stops=[0,...critical.filter(x=>x>0&&x<1).sort((a,b)=>a-b),1],result=[],value=t=>((c[3]*t+c[2])*t+c[1])*t+c[0],add=t=>{if(!result.some(x=>Math.abs(x-t)<1e-7))result.push(t);};
  if(c.every(x=>Math.abs(x)<=tolerance))return [];// Coplanar sliding needs edge/edge treatment.
  for(let i=0;i<stops.length;i++){const t=stops[i];if(Math.abs(value(t))<=tolerance)add(t);if(!i)continue;let lo=stops[i-1],hi=t,left=value(lo);if(left*value(hi)>=0)continue;for(let n=0;n<45;n++){const middle=(lo+hi)/2,v=value(middle);if(left*v<=0)hi=middle;else {lo=middle;left=v;}}add((lo+hi)/2);}
  return result.sort((a,b)=>a-b);
}
function movingPointFace(p0,p1,old,now){
  const r=sub(p0,old[0]),dr=sub(sub(p1,p0),sub(now[0],old[0])),u=sub(old[1],old[0]),du=sub(sub(now[1],old[1]),sub(now[0],old[0])),v=sub(old[2],old[0]),dv=sub(sub(now[2],old[2]),sub(now[0],old[0]));
  const n0=cross(u,v),n1=cross(du,v).map((x,k)=>x+cross(u,dv)[k]),n2=cross(du,dv),coefficients=[dot(r,n0),dot(dr,n0)+dot(r,n1),dot(dr,n1)+dot(r,n2),dot(dr,n2)];
  for(const time of rootsInStep(coefficients)){const vertices=old.map((a,i)=>a.map((x,k)=>x+(now[i][k]-x)*time)),point=p0.map((x,k)=>x+(p1[k]-x)*time),hit=closest(point,...vertices);if(!hit||Math.hypot(...sub(point,hit.point))>1e-7)continue;
    let normal=cross(sub(vertices[1],vertices[0]),sub(vertices[2],vertices[0])),length=Math.hypot(...normal);if(length<1e-14)continue;normal=normal.map(x=>x/length);
    // The body was on the opposite side of the outward cloth surface. Keep
    // that side even if the endpoint now lies well beyond the thin triangle.
    if(dot(sub(p0,old[0]),normal)>0)normal=normal.map(x=>-x);
    return {time,weights:hit.weights,normal};
  }
  return null;
}

/** Symmetric rigid-point / deforming-cloth-face contact. The optional cubic
 * test covers a linearly moving body vertex and a linearly moving triangle;
 * body-edge / cloth-edge and coplanar overlaps remain explicitly unsupported.
 */
export function solveBodyVertexContacts(model,mesh,{thickness=.003,continuous=true,discrete=true,previousPositions=model.positions,previousBodyPositions=mesh.previousPositions||mesh.positions}={}){
  const p=model.positions,tri=model.triangles,body=mesh.positions,stats={contacts:0,candidates:0,continuousContacts:0,algorithm:'swept-hash-body-vertex-cloth-triangle',continuousAlgorithm:continuous?'linear-point-linear-triangle-cubic':'disabled',edgeEdgeCCD:false,movingTriangleCCD:true,broadphaseOverflow:false};
  if(!body||body.length%3||previousPositions.length!==p.length||previousBodyPositions.length!==body.length||!Number.isFinite(thickness)||thickness<=0)throw new Error('Invalid symmetric body contact');
  const weight=i=>model.pins?.has(i)||model.grabbed?.index===i?0:model.inverseMass?.[i]??1;
  let mean=0;for(let f=0;f<tri.length;f+=3)mean+=Math.hypot(...sub(vec(p,tri[f]),vec(p,tri[f+1])));
  const size=Math.max(thickness*2,Math.min(.05,mean/(tri.length/3||1))),cell=x=>Math.floor(x/size),hash=new Map(),overflow=[],faces=[];
  for(let f=0;f<tri.length;f+=3){const ids=tri.slice(f,f+3),old=ids.map(i=>vec(previousPositions,i)),now=ids.map(i=>vec(p,i));faces.push({ids,old});const points=continuous?[...old,...now]:now,lo=[0,1,2].map(k=>cell(Math.min(...points.map(a=>a[k]))-thickness)),hi=[0,1,2].map(k=>cell(Math.max(...points.map(a=>a[k]))+thickness));
    if((hi[0]-lo[0]+1)*(hi[1]-lo[1]+1)*(hi[2]-lo[2]+1)>4096){overflow.push(f/3);stats.broadphaseOverflow=true;continue;}
    for(let x=lo[0];x<=hi[0];x++)for(let y=lo[1];y<=hi[1];y++)for(let z=lo[2];z<=hi[2];z++){const key=`${x},${y},${z}`;if(!hash.has(key))hash.set(key,[]);hash.get(key).push(f/3);}
  }
  for(let i=0;i<body.length/3;i++){const point=vec(body,i),start=vec(previousBodyPositions,i),candidates=new Set(overflow),span=continuous?Math.ceil(Math.max(...sub(point,start).map(Math.abs))/size*2):1,steps=Math.max(1,Math.min(4096,span));if(span>4096)stats.broadphaseOverflow=true;
    for(let s=0;s<=steps;s++){const t=continuous?s/steps:1,q=start.map((x,k)=>x+(point[k]-x)*t);for(const f of hash.get(`${cell(q[0])},${cell(q[1])},${cell(q[2])}`)||[])candidates.add(f);}
    for(const f of candidates){const {ids,old}=faces[f],now=ids.map(i=>vec(p,i));if(!ids.some(weight))continue;stats.candidates++;let contact=continuous?movingPointFace(start,point,old,now):null,ccd=!!contact;
      if(!contact){if(!discrete)continue;const near=closest(point,...now);if(!near||Math.hypot(...sub(point,near.point))>=thickness)continue;let normal=cross(sub(now[1],now[0]),sub(now[2],now[0])),length=Math.hypot(...normal);if(length<1e-14)continue;normal=normal.map(x=>x/length);if(dot(sub(start,old[0]),normal)>0)normal=normal.map(x=>-x);contact={weights:near.weights,normal};}
      const bary=contact.weights,q=[0,0,0];for(let a=0;a<3;a++)for(let k=0;k<3;k++)q[k]+=p[ids[a]*3+k]*bary[a];const penetration=thickness-dot(sub(q,point),contact.normal),denominator=ids.reduce((s,j,a)=>s+weight(j)*bary[a]*bary[a],0);if(penetration<=1e-10||denominator<=0)continue;
      for(let a=0;a<3;a++)for(let k=0;k<3;k++)p[ids[a]*3+k]+=contact.normal[k]*penetration*weight(ids[a])*bary[a]/denominator;
      stats.contacts++;if(ccd)stats.continuousContacts++;
    }
  }
  return stats;
}
