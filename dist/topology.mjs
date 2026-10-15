// Incisions follow existing mesh edges. Faces are retained; disconnected vertex
// fans receive copies. This approximates the drawn path without deleting fabric.
const key=(a,b)=>a<b?`${a},${b}`:`${b},${a}`;
const periodic=m=>m.kind==='tube'||m.kind==='stocking';
const uv=(m,i,origin)=>{let u=m.uv[i*2];if(origin!=null&&periodic(m)){while(u-origin>.5)u--;while(u-origin<-.5)u++;}return [u,m.uv[i*2+1]];};
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function pointDistance(p,a,b){const x=b[0]-a[0],y=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*x+(p[1]-a[1])*y)/(x*x+y*y||1)));return Math.hypot(p[0]-a[0]-t*x,p[1]-a[1]-t*y);}
function intersects(a,b,c,d){return cross(a,b,c)*cross(a,b,d)<=1e-20&&cross(c,d,a)*cross(c,d,b)<=1e-20&&Math.max(a[0],b[0])+1e-10>=Math.min(c[0],d[0])&&Math.max(c[0],d[0])+1e-10>=Math.min(a[0],b[0])&&Math.max(a[1],b[1])+1e-10>=Math.min(c[1],d[1])&&Math.max(c[1],d[1])+1e-10>=Math.min(a[1],b[1]);}
export function meshEdges(model){
  const edges=new Map(),incident=Array.from({length:model.positions.length/3},()=>[]);
  for(let f=0;f<model.triangles.length/3;f++){const ids=model.triangles.slice(f*3,f*3+3);for(let k=0;k<3;k++){incident[ids[k]].push(f);const a=ids[k],b=ids[(k+1)%3],id=key(a,b);if(!edges.has(id))edges.set(id,{a,b,faces:[]});edges.get(id).faces.push(f);}}
  return {edges,incident};
}
export function edgePathUV(model,start,end){
  if(!Array.isArray(start)||!Array.isArray(end)||start.length!==2||end.length!==2||![...start,...end].every(Number.isFinite))return [];
  end=[...end];if(periodic(model)&&Math.abs(end[0]-start[0])>.5)end[0]+=end[0]<start[0]?1:-1;
  const {edges}=meshEdges(model),n=model.positions.length/3,adj=Array.from({length:n},()=>[]);
  for(const {a,b} of edges.values()){adj[a].push(b);adj[b].push(a);}
  const nearest=p=>{let best=-1,d=Infinity;for(let i=0;i<n;i++){if(!model.active[i])continue;const q=uv(model,i,p[0]),v=Math.hypot(q[0]-p[0],q[1]-p[1]);if(v<d){d=v;best=i;}}return best;};
  const from=nearest(start),to=nearest(end);if(from<0||to<0||from===to)return [];
  const costs=new Float64Array(n).fill(Infinity),prev=new Int32Array(n).fill(-1),done=new Uint8Array(n);costs[from]=0;
  for(let count=0;count<n;count++){let a=-1,best=Infinity;for(let i=0;i<n;i++)if(!done[i]&&costs[i]<best){a=i;best=costs[i];}if(a<0)break;if(a===to)break;done[a]=1;
    const p=uv(model,a,start[0]);for(const b of adj[a]){const q=uv(model,b,p[0]),mid=[(p[0]+q[0])/2,(p[1]+q[1])/2],cost=best+Math.hypot(q[0]-p[0],q[1]-p[1])*(1+20*pointDistance(mid,start,end));if(cost<costs[b]){costs[b]=cost;prev[b]=a;}}}
  if(prev[to]<0)return [];const path=[];for(let i=to;i>=0;i=prev[i]){path.push(i);if(i===from)break;}return path.reverse();
}

export function incisionPlan(model,start,end){
  const path=edgePathUV(model,start,end);if(path.length<2)return {ok:false,reason:'切线需要覆盖至少一条网格边'};
  const {edges,incident}=meshEdges(model),cutEdges=new Set(path.slice(1).map((v,i)=>key(path[i],v))),triangles=[...model.triangles],maps=Array.from({length:triangles.length/3},()=>new Map());
  const vertexMap=[],copies=new Map(),n=model.positions.length/3;
  for(const vertex of path){
    const faces=new Set(incident[vertex]),fans=[];
    while(faces.size){const first=faces.values().next().value,fan=[],queue=[first];faces.delete(first);while(queue.length){const f=queue.pop();fan.push(f);for(const other of model.triangles.slice(f*3,f*3+3)){if(other===vertex||cutEdges.has(key(vertex,other)))continue;for(const next of edges.get(key(vertex,other)).faces)if(faces.delete(next))queue.push(next);}}fans.push(fan);}
    copies.set(vertex,[]);fans.forEach((fan,j)=>{const index=j===0?vertex:n+vertexMap.length;if(j)vertexMap.push({source:vertex,index});copies.get(vertex).push(index);for(const f of fan){maps[f].set(vertex,index);for(let k=0;k<3;k++)if(triangles[f*3+k]===vertex)triangles[f*3+k]=index;}});
  }
  if(!vertexMap.length)return {ok:false,reason:'该路径只有内部切口尖端，尚未分离顶点'};
  const mapFace=(f,v)=>maps[f].get(v)??v;
  const fanToward=(a,b)=>{
    if(!copies.has(a))return a;const p=uv(model,a),q=uv(model,b,p[0]),probe=[p[0]+(q[0]-p[0])*.001,p[1]+(q[1]-p[1])*.001];let best=Infinity,result=a;
    for(const f of incident[a]){const pts=model.triangles.slice(f*3,f*3+3).map(i=>uv(model,i,p[0])),signs=pts.map((v,k)=>cross(v,pts[(k+1)%3],probe)),inside=signs.every(v=>v>=-1e-15)||signs.every(v=>v<=1e-15);const d=inside?0:Math.min(...pts.map((v,k)=>pointDistance(probe,v,pts[(k+1)%3])));if(d<best){best=d;result=mapFace(f,a);}}return result;
  };
  const constraints=[],seen=new Set();let removedConstraints=0;
  for(const c of model.constraints){let pairs=[];const edge=edges.get(key(c.a,c.b));
    if(edge)pairs=edge.faces.map(f=>[mapFace(f,c.a),mapFace(f,c.b)]);
    else if(copies.has(c.a)&&copies.has(c.b)){removedConstraints++;continue;}
    else {
      const a=uv(model,c.a),b=uv(model,c.b,a[0]);
      const crosses=!copies.has(c.a)&&!copies.has(c.b)&&path.slice(1).some((v,i)=>intersects(a,b,uv(model,path[i],a[0]),uv(model,v,a[0])));
      if(crosses){removedConstraints++;continue;}pairs=[[fanToward(c.a,c.b),fanToward(c.b,c.a)]];
    }
    for(const [a,b] of pairs){const id=`${c.kind}:${key(a,b)}:${c.seamId||''}`;if(seen.has(id))continue;seen.add(id);constraints.push({...c,a,b,lambda:0});}
  }
  return {ok:true,path,triangles,constraints,vertexMap,pathA:path.map(i=>copies.get(i)[0]),pathB:path.map(i=>copies.get(i).at(-1)),addedVertices:vertexMap.length,removedConstraints,removedFaces:0,removedMass:0};
}

export function validateBoundaryPath(model,path){
  if(!Array.isArray(path)||path.length<2||new Set(path).size!==path.length||!path.every(i=>Number.isInteger(i)&&model.boundary.has(i)))return false;
  const {edges}=meshEdges(model);return path.slice(1).every((i,j)=>edges.get(key(path[j],i))?.faces.length===1);
}
export function pairBoundaryPaths(model,pathA,pathB){
  if(!validateBoundaryPath(model,pathA)||!validateBoundaryPath(model,pathB))return null;
  const distance=(a,b)=>Math.hypot(...[0,1,2].map(k=>model.rest[a*3+k]-model.rest[b*3+k]));
  const param=path=>{let s=0;const values=[0];for(let i=1;i<path.length;i++){s+=distance(path[i-1],path[i]);values.push(s);}return values.map(v=>v/(s||1));};
  const a=param(pathA),b=param(pathB),pairs=[],seen=new Set();const add=(i,j)=>{if(pathA[i]===pathB[j])return;const id=key(pathA[i],pathB[j]);if(!seen.has(id)){seen.add(id);pairs.push([pathA[i],pathB[j]]);}};
  for(let i=0;i<a.length;i++){let j=0;for(let k=1;k<b.length;k++)if(Math.abs(b[k]-a[i])<Math.abs(b[j]-a[i]))j=k;add(i,j);}
  for(let j=0;j<b.length;j++){let i=0;for(let k=1;k<a.length;k++)if(Math.abs(a[k]-b[j])<Math.abs(a[i]-b[j]))i=k;add(i,j);}return pairs;
}
