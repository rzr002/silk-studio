/** Triangle material coordinates, independent of world rotation and grid indices.
 * warp follows V, weft follows U; shear is the change of their included angle. */
const EPS=1e-12,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const norm=v=>Math.hypot(...v),dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function tangents(p,ids,du1,dv1,du2,dv2,det){const e1=[0,1,2].map(k=>p[ids[1]*3+k]-p[ids[0]*3+k]),e2=[0,1,2].map(k=>p[ids[2]*3+k]-p[ids[0]*3+k]);return {u:e1.map((x,k)=>(x*dv2-e2[k]*dv1)/det),v:e2.map((x,k)=>(x*du1-e1[k]*du2)/det)};}
function declaredToeCap(model,count){
  const finishing=model.garment?.finishing?.toeCap,metadata=model.metadata?.toeCap;
  if(model.kind!=='stocking'||finishing?.method!=='free-center-fan'||finishing.isotropicAppearanceFallback!==true||finishing.centerVertexId!=='toe-center'||metadata?.centerVertexId!==finishing.centerVertexId)return null;
  const center=model.vertexIds?.indexOf(finishing.centerVertexId),ring=metadata.ring;
  if(!Number.isInteger(center)||center<0||center>=count||metadata.centerVertex!==center||!Array.isArray(ring)||ring.length<3||new Set(ring).size!==ring.length||!ring.every(i=>Number.isInteger(i)&&i>=0&&i<count&&i!==center))return null;
  let auxiliary=[center];
  if(finishing.refinement==='concentric-free-rings'){
    const {vertices,vertexIds,nodes}=metadata;
    if(!Array.isArray(vertices)||!Array.isArray(vertexIds)||!Array.isArray(nodes)||vertices.length<2||vertexIds.length!==vertices.length||nodes.length!==vertices.length||new Set(vertices).size!==vertices.length||new Set(vertexIds).size!==vertexIds.length||!vertices.includes(center)||!vertices.every(i=>Number.isInteger(i)&&i>=0&&i<count&&!ring.includes(i)))return null;
    for(let j=0;j<vertices.length;j++){
      const index=vertices[j],node=nodes[j];
      if(vertexIds[j]!==model.vertexIds[index]||!node||node.index!==index||node.id!==vertexIds[j]||!Number.isFinite(node.u)||node.u<0||node.u>1||!Number.isFinite(node.fraction)||node.fraction<0||node.fraction>=1||node.u!==model.uv[index*2]||model.uv[index*2+1]!==0||index===center&&node.fraction!==0||index!==center&&node.fraction===0)return null;
    }
    auxiliary=vertices;
  }else if(finishing.refinement!=null||metadata.vertices!=null||metadata.vertexIds!=null||metadata.nodes!=null)return null;
  return {center,auxiliary:new Set(auxiliary),surface:new Set([...ring,...auxiliary])};
}
function doubleArea(p,ids){const a=ids[0]*3,b=ids[1]*3,c=ids[2]*3;return norm(cross([p[b]-p[a],p[b+1]-p[a+1],p[b+2]-p[a+2]],[p[c]-p[a],p[c+1]-p[a+1],p[c+2]-p[a+2]]));}
export function computeDeformation(model){
  const p=model?.positions,r=model?.rest,uv=model?.uv,tri=model?.triangles,n=p?.length/3;
  if(!Number.isInteger(n)||!p||!r||r.length!==p.length||!uv||uv.length!==n*2||!tri||tri.length%3||![...p,...r,...uv].every(Number.isFinite)||![...tri].every(i=>Number.isInteger(i)&&i>=0&&i<n))throw new TypeError('无效的变形几何');
  const out={warpStretch:new Float32Array(n),weftStretch:new Float32Array(n),shear:new Float32Array(n),areaStretch:new Float32Array(n),valid:new Uint8Array(n),isotropicFallback:new Uint8Array(n),directionalValid:new Uint8Array(n)},weights=new Float64Array(n),cap=declaredToeCap(model,n);
  let validTriangles=0,fallbackTriangles=0;
  const accumulate=(ids,weight,values)=>{for(const i of ids){weights[i]+=weight;for(const key of Object.keys(values))out[key][i]+=values[key]*weight;}validTriangles++;};
  for(let j=0;j<tri.length;j+=3){
    const ids=[tri[j],tri[j+1],tri[j+2]],u=ids.map(i=>uv[i*2]),v=ids.map(i=>uv[i*2+1]);
    if(model.kind==='tube'||model.kind==='stocking')for(let k=1;k<3;k++){while(u[k]-u[0]>.5)u[k]-=1;while(u[k]-u[0]<-.5)u[k]+=1;}
    const du1=u[1]-u[0],dv1=v[1]-v[0],du2=u[2]-u[0],dv2=v[2]-v[0],det=du1*dv2-du2*dv1;
    if(Math.abs(det)<EPS){
      // Declared finishing fan and ring faces have no U/V yarn directions. Only its real
      // triangle area is used; ordinary malformed UV triangles stay invalid.
      if(!cap||!ids.some(i=>cap.auxiliary.has(i))||!ids.every(i=>cap.surface.has(i)))continue;
      const restArea=doubleArea(r,ids)/2;if(restArea<EPS)continue;
      const areaStretch=doubleArea(p,ids)/(2*restArea),stretch=Math.sqrt(areaStretch);
      accumulate(ids,restArea,{weftStretch:stretch,warpStretch:stretch,areaStretch,shear:0});
      for(const i of ids)out.isotropicFallback[i]=1;fallbackTriangles++;continue;
    }
    const rest=tangents(r,ids,du1,dv1,du2,dv2,det),now=tangents(p,ids,du1,dv1,du2,dv2,det),ru=norm(rest.u),rv=norm(rest.v),cu=norm(now.u),cv=norm(now.v),ra=norm(cross(rest.u,rest.v)),ca=norm(cross(now.u,now.v));
    if(ru<EPS||rv<EPS||ra<EPS)continue;
    accumulate(ids,ra*Math.abs(det)/2,{weftStretch:cu/ru,warpStretch:cv/rv,areaStretch:ca/ra,shear:Math.acos(clamp(dot(rest.u,rest.v)/(ru*rv),-1,1))-Math.acos(clamp(dot(now.u,now.v)/Math.max(EPS,cu*cv),-1,1))});
    for(const i of ids)out.directionalValid[i]=1;
  }
  for(let i=0;i<n;i++){if(weights[i]>EPS){out.valid[i]=1;for(const key of ['warpStretch','weftStretch','shear','areaStretch'])out[key][i]/=weights[i];}else{out.warpStretch[i]=out.weftStretch[i]=out.areaStretch[i]=1;out.shear[i]=0;}}
  out.validTriangles=validTriangles;out.fallbackTriangles=fallbackTriangles;out.units={stretch:'ratio',shear:'radians'};
  out.assumptions=fallbackTriangles?[{code:'TOE_CAP_ISOTROPIC_AREA_FALLBACK',status:'experimental',scope:'declared-free-center-toe-finishing',directionalCalibration:false,description:'袜尖封口使用面积变化的各向同性外观假设，不代表实测纱线方向。'}]:[];
  return out;
}
function lerpLUT(points,value,key){const sorted=[...points].sort((a,b)=>a[key]-b[key]);if(sorted.length===1)return {value:sorted[0].transmittance,outside:true};let a=sorted[0],b=sorted[1];for(let i=1;i<sorted.length;i++){a=sorted[i-1];b=sorted[i];if(value<=b[key])break;}const t=clamp((value-a[key])/(b[key]-a[key]||1),0,1);return {value:a.transmittance+(b.transmittance-a.transmittance)*t,outside:value<sorted[0][key]||value>sorted.at(-1)[key]};}
export function opticalResponse(deformation,material={},organization=null){
  const n=deformation?.areaStretch?.length;if(!Number.isInteger(n)||!['warpStretch','weftStretch','shear','valid'].every(k=>deformation[k]?.length===n)||!['warpStretch','weftStretch','shear','areaStretch'].every(k=>[...deformation[k]].every(Number.isFinite)))throw new TypeError('无效的光学变形属性');
  const out={coverage:new Float32Array(n),transmittance:new Float32Array(n),roughness:new Float32Array(n),opacity:new Float32Array(n),valid:Uint8Array.from(deformation.valid),extrapolated:new Uint8Array(n),status:'experimental',source:'geometry-hypothesis',isotropicFallback:deformation.isotropicFallback?Uint8Array.from(deformation.isotropicFallback):new Uint8Array(n)};
  const base=material.opticalBaseline||{},coverage0=clamp(Number.isFinite(base.coverage)?base.coverage:.78,0,1),fiberT=clamp(Number.isFinite(base.fiberTransmittance)?base.fiberTransmittance:.08,0,.99),roughness0=clamp(Number.isFinite(base.roughness)?base.roughness:.63,.05,1);
  const points=(material.optics?.points||[]).filter(p=>Number.isFinite(p.strain)&&Number.isFinite(p.transmittance)&&p.transmittance>=0&&p.transmittance<=1&&(!p.cycle||!material.fitCycle||p.cycle===material.fitCycle));const sourceType=material.optics?.sourceType||material.sourceType;
  if(points.length){out.source=sourceType==='measured'?'measured-lut':'synthetic-lut';out.status=sourceType==='measured'?(material.optics?.calibrationStatus==='validated'?'validated':'fit'):'experimental';}
  for(let i=0;i<n;i++){if(!out.valid[i]){out.transmittance[i]=1;out.roughness[i]=roughness0;continue;}const area=Math.max(.02,deformation.areaStretch[i]),warp=Math.max(.02,deformation.warpStretch[i]),weft=Math.max(.02,deformation.weftStretch[i]),shear=Math.abs(deformation.shear[i]),shearGuard=shear>=84*Math.PI/180,shearGamma=Math.tan(Math.min(shear,84*Math.PI/180));out.extrapolated[i]=Number(shearGuard);const type=Array.isArray(organization)?organization[i]:organization?.types?.[i];const factor=(type==='eyelet'?.55:type==='miss'?.78:type==='tuck'?1.12:1)*(organization?.coverageFactor||1);let coverage=clamp(coverage0*(warp+weft)/(2*area)*factor,.01,.995),t=1-coverage*(1-fiberT);
    if(points.length&&!out.isotropicFallback[i]){const areaPoints=points.filter(p=>Number.isFinite(p.areaStretch));let lut;if(areaPoints.length>=2)lut=lerpLUT(areaPoints,area,'areaStretch');else{const candidates=['warp','weft','shear'].map(direction=>({direction,value:direction==='warp'?warp-1:direction==='weft'?weft-1:shearGamma,points:points.filter(p=>p.direction===direction)})).filter(c=>c.points.length);candidates.sort((a,b)=>Math.abs(b.value)-Math.abs(a.value));const chosen=candidates[0];if(chosen)lut=lerpLUT(chosen.points,Math.max(0,chosen.value),'strain');}if(lut){t=clamp(lut.value,0,1);coverage=clamp((1-t)/(1-fiberT)*factor,0,1);if(factor!==1){t=clamp(1-(1-t)*factor,0,1);out.status='experimental';}out.extrapolated[i]=Number(lut.outside||shearGuard);}}
    out.coverage[i]=coverage;out.transmittance[i]=clamp(t,0,1);out.opacity[i]=1-out.transmittance[i];out.roughness[i]=clamp(roughness0*(1-.10*Math.max(0,area-1))+.025*shear,.12,1);
  }
  const capVertices=out.isotropicFallback.reduce((sum,value)=>sum+value,0);if(capVertices)out.status='experimental';
  out.provenance={sourceType:sourceType||'hypothesis',sampleId:material.sampleId||null,scope:'appearance-only',calibrationStatus:out.status,shearInput:'engineering-gamma=tan(angle-change)',shearGuardRadians:84*Math.PI/180,isotropicCapFallbackVertices:capVertices,capStatus:capVertices?'experimental-isotropic-finishing':'not-applicable',capDirectionalLUT:capVertices?'not-applied':'not-applicable'};return out;
}
