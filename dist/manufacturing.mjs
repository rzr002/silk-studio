/** Device rules and sample evidence are separate from geometric validity.
 * This module deliberately produces no native industrial machine instructions. */
const clone=x=>JSON.parse(JSON.stringify(x));
const STITCHES=['knit','tuck','miss','eyelet'];
const ACTIONS=['knit','tuck','miss','transfer','rack','increase','decrease','cast-on','bind-off','cut','sew'];
function object(x){return x&&typeof x==='object'&&!Array.isArray(x);}
export function parseMachineProfile(input){
  if(typeof input==='string'&&input.length>2_000_000)throw new Error('设备文件超过 2 MB');let p;try{p=typeof input==='string'?JSON.parse(input):clone(input);}catch{throw new Error('设备 JSON 格式无效');}
  if(!object(p)||p.schema!=='silk-machine-profile'||p.version!==1||typeof p.id!=='string'||!p.id.trim()||typeof p.name!=='string'||!['circular','flatbed','cut-sew','unknown'].includes(p.machineType))throw new Error('设备 profile 类型或版本无效');
  if(!object(p.provenance)||!['hypothetical','documented','sample-verified'].includes(p.provenance.status)||(typeof p.provenance.source!=='string'||!p.provenance.source.trim()))throw new Error('设备来源声明无效');const c=p.capabilities;
  if(!object(c)||![['needleCount',1,1_000_000],['feeders',1,1000],['maxColorsPerCourse',1,1000],['maxFloatNeedles',0,1_000_000]].every(([k,a,b])=>Number.isSafeInteger(c[k])&&c[k]>=a&&c[k]<=b)||typeof c.supportsTransfers!=='boolean'||!Array.isArray(c.supportedStitches)||!c.supportedStitches.length||!c.supportedStitches.every(x=>STITCHES.includes(x))||!Array.isArray(c.supportedActions)||!c.supportedActions.every(x=>ACTIONS.includes(x)))throw new Error('设备针位、喂纱路、颜色或动作能力无效');
  if(!object(p.organizationRules)||!['requiresCastOn','requiresBindOff','allowExperimentalEyelet'].every(k=>typeof p.organizationRules[k]==='boolean')||!Array.isArray(p.postProcessing)||!p.postProcessing.every(x=>typeof x==='string'))throw new Error('设备组织边界或后处理规则无效');
  // Imported provenance is a declaration. No trusted external verifier exists
  // in this prototype; self-asserted flags cannot attest a device or sample.
  p.provenance.declaredStatus=p.provenance.declaredStatus||p.provenance.status;
  if(p.provenance.status==='sample-verified')p.provenance.status='documented';
  p.provenance.evidenceVerified=false;p.provenance.verificationScope='imported-declaration';return p;
}
function revisionOf(design){const r=design?.revision??design?.version;if(!Number.isSafeInteger(r)||r<0)throw new Error('设计 revision 必须为非负整数');return r;}
export function validateManufacturing(design,profile=null){
  if(!object(design))throw new Error('无效的制造设计');
  const revision=revisionOf(design),p=profile?parseMachineProfile(profile):null,c=p?.capabilities,issues=[];
  const issue=(code,stage,severity,message,regionId=null)=>issues.push({code,stage,severity,message,...(regionId?{regionId}:{})});
  let graphEntries=[];
  if(design.graphs!=null&&!Array.isArray(design.graphs))issue('INVALID_REGIONS','structure','error','组织区域必须为数组。');
  if(Array.isArray(design.graphs)&&design.graphs.length){
    if(design.graphs.length>64)issue('REGION_LIMIT','structure','error','组织区域数量超出支持范围。');
    else for(const region of design.graphs){if(!object(region)||typeof region.id!=='string'||!region.id||!region.graph){issue('INVALID_REGION','structure','error','组织区域数据无效。');continue;}graphEntries.push({graph:region.graph,regionId:region.id});}
    if(new Set(graphEntries.map(r=>r.regionId)).size!==graphEntries.length)issue('DUPLICATE_REGION','structure','error','组织区域 ID 重复。');
  }else if(design.graph)graphEntries=[{graph:design.graph,regionId:null}];
  for(const {graph:g,regionId} of graphEntries){
    const add=(code,stage,severity,message)=>issue(code,stage,severity,message,regionId);
    if(c&&Number.isSafeInteger(g.cols)&&g.cols>c.needleCount)add('NEEDLE_COUNT','device','error',`组织需要 ${g.cols} 针，超过设备 ${c.needleCount} 针。`);
    if(!Number.isSafeInteger(g.cols)||!Number.isSafeInteger(g.rows)||g.cols<1||g.rows<1||g.cols>4096||g.rows>4096||!Array.isArray(g.cells)||g.cells.length!==g.cols*g.rows||g.cells.length>100000||!g.cells.every(x=>x===null||STITCHES.includes(x))){add('INVALID_GRAPH','structure','error','针目网格尺寸与组织数据不一致。');continue;}
    if(g.cells.includes(null))add('DROPPED_LOOP','structure','error','删针边界尚无可验证的防脱散操作。');
    if(g.cells.includes('eyelet'))add('EXPERIMENTAL_EYELET','structure','error','实验孔眼尚未转换为指定设备上的移圈与重新起针工序。');
    if(g.manualEdges!=null&&!Array.isArray(g.manualEdges))add('INVALID_SUPPORTS','structure','error','穿套支撑必须为数组。');
    for(const e of Array.isArray(g.manualEdges)?g.manualEdges:[]){const valid=id=>{const m=String(id).match(/^s-(\d+)-(\d+)$/);return m&&Number(m[1])<g.rows&&Number(m[2])<g.cols&&g.cells[Number(m[1])*g.cols+Number(m[2])]!=null;};if(!e||!valid(e.from)||!valid(e.to))add('DANGLING_SUPPORT','structure','error','穿套连接指向缺失针目。');}
    if(c)for(const type of new Set(g.cells))if(type&&!c.supportedStitches.includes(type))add('UNSUPPORTED_STITCH','device','error',`设备不支持 ${type} 组织。`);
    if(c)for(let row=0;row<g.rows;row++){let run=0;for(let col=0;col<g.cols;col++){run=g.cells[row*g.cols+col]==='miss'?run+1:0;if(run>c.maxFloatNeedles){add('FLOAT_LENGTH','device','error',`横列 ${row+1} 浮线跨度超过 ${c.maxFloatNeedles} 针。`);break;}}}
  }
  // Whole-garment geometry is independent of the selected regional graph.
  if(design.model){const m=design.model,n=m.positions?.length/3,finite=(a,length)=>a&&typeof a.length==='number'&&a.length===length&&Array.from(a).every(Number.isFinite);if(!Number.isInteger(n)||n<3||n>40000||!finite(m.positions,n*3)||!finite(m.rest,n*3)||!finite(m.uv,n*2)||!Array.isArray(m.triangles)||!m.triangles.length||m.triangles.length%3||!m.triangles.every(i=>Number.isInteger(i)&&i>=0&&i<n)||m.triangles.some((i,j)=>j%3===0&&(i===m.triangles[j+1]||i===m.triangles[j+2]||m.triangles[j+1]===m.triangles[j+2]))||m.density!=null&&(!Number.isFinite(m.density)||m.density<=0))issue('INVALID_GEOMETRY','structure','error','几何、自然坐标或面片索引无效。');
    if(!graphEntries.length)issue('CONSTRUCTION_UNSPECIFIED','structure','warning','三维网格尚未映射为裁片或针织工序。');
  }
  if(!design.model&&!graphEntries.length)issue('STRUCTURE_UNSPECIFIED','structure','warning','尚无结构数据。');
  if(graphEntries.length){
    if((p?.organizationRules.requiresCastOn??true)&&!design.boundaries?.castOn)issue('CAST_ON_UNSPECIFIED','structure','warning','起针边界工艺尚未定义。');
    if((p?.organizationRules.requiresBindOff??true)&&!design.boundaries?.bindOff)issue('BIND_OFF_UNSPECIFIED','structure','warning','收针边界工艺尚未定义。');
    if(c&&design.boundaries?.castOn&&!c.supportedActions.includes('cast-on'))issue('CAST_ON_UNSUPPORTED','device','error','设备配置不支持当前起针动作。');
    if(c&&design.boundaries?.bindOff&&!c.supportedActions.includes('bind-off'))issue('BIND_OFF_UNSUPPORTED','device','error','设备配置不支持当前收针动作。');
  }
  if(design.dimensions)for(const [key,value] of Object.entries(design.dimensions))if(!Number.isFinite(value)||value<=0)issue('INVALID_DIMENSION','structure','error',`${key} 尺寸无效。`);
  if(!p)issue('DEVICE_UNKNOWN','device','warning','尚未提供目标设备能力。');else if(p.provenance.status==='hypothetical'||p.machineType==='unknown')issue('DEVICE_HYPOTHETICAL','device','warning','设备参数为假设，尚未与真实机型核对。');
  if(design.operations!=null&&!Array.isArray(design.operations))issue('INVALID_OPERATIONS','device','error','工序必须为数组。');
  const colors=new Map(),semanticTypes=new Set();
  for(const op of Array.isArray(design.operations)?design.operations:[]){
    if(!object(op)){issue('INVALID_OPERATION','device','error','无效工序。');continue;}
    if(typeof op.type==='string'&&!op.action){semanticTypes.add(op.type);continue;}
    if(c){if(!c.supportedActions.includes(op.action))issue('UNSUPPORTED_ACTION','device','error',`设备不支持 ${op.action} 动作。`);if(op.action==='transfer'&&!c.supportsTransfers)issue('TRANSFER_UNSUPPORTED','device','error','设备不支持移圈。');if(op.needle!=null&&(!Number.isSafeInteger(op.needle)||op.needle<0||op.needle>=c.needleCount))issue('NEEDLE_POSITION','device','error','针位索引超出设备范围。');if(op.feeder!=null&&(!Number.isSafeInteger(op.feeder)||op.feeder<0||op.feeder>=c.feeders))issue('FEEDER_POSITION','device','error','喂纱路索引超出设备范围。');}
    if(op.color!=null){const key=String(op.course??0),set=colors.get(key)||new Set();set.add(String(op.color));colors.set(key,set);}
  }
  if(semanticTypes.size)issue('PROCESS_COMPILATION_UNVERIFIED','device','warning',`设计操作尚未编译为设备工序（${[...semanticTypes].join('、')}）。`);
  if(c)for(const [course,set] of colors)if(set.size>c.maxColorsPerCourse)issue('COLOR_LIMIT','device','error',`横列 ${course} 颜色数超过设备限制。`);
  const sample=design.sampleEvidence;let sampleStatus='unverified';
  if(sample){if(sample.revision!==revision)issue('SAMPLE_REVISION_MISMATCH','sample','warning','实样记录声明对应的设计版本不同。');else if(sample.status==='failed'){sampleStatus='failed';issue('SAMPLE_FAILED','sample','error','导入记录声明该设计版本实样失败。');}else if(sample.status==='passed'&&typeof sample.recordId==='string'&&sample.recordId.trim())issue('SAMPLE_DECLARATION_UNVERIFIED','sample','warning','已载入实样通过的记录声明；尚无可信外部验证，不能据此认定实样已验证。');else issue('SAMPLE_EVIDENCE_INCOMPLETE','sample','warning','实样记录声明缺少状态或记录编号。');}else issue('SAMPLE_UNVERIFIED','sample','warning','尚无当前版本的实样验证。');
  const stageStatus=(stage,good)=>issues.some(i=>i.stage===stage&&i.severity==='error')?'blocked':issues.some(i=>i.stage===stage&&i.severity==='warning')?'unverified':good;
  const states={structure:{status:stageStatus('structure','valid')},device:{status:stageStatus('device','compatible'),profileId:p?.id||null,evidence:p?.provenance.status||'unknown',evidenceVerified:false},sample:{status:sampleStatus,declaredStatus:typeof sample?.status==='string'?sample.status:null,recordId:typeof sample?.recordId==='string'?sample.recordId:null,revision:Number.isSafeInteger(sample?.revision)?sample.revision:null,evidenceVerified:false}};
  const blocked=states.structure.status==='blocked'||states.device.status==='blocked'||sampleStatus==='failed',known=states.structure.status==='valid'&&states.device.status==='compatible',overall=blocked?'blocked':!known?'unverified':'sample-required';
  return {schema:'silk-manufacturing-report',version:1,revision,states,issues,overall,evidenceVerified:false,productionVerified:false,nativeProgram:null};
}
function dimensionsOf(design){if(design.dimensions)return clone(design.dimensions);const rest=design.model?.rest;if(!rest?.length)return {};const axes=[0,1,2].map(k=>rest.filter((_,i)=>i%3===k));return {widthM:Math.max(...axes[0])-Math.min(...axes[0]),heightM:Math.max(...axes[1])-Math.min(...axes[1]),depthM:Math.max(...axes[2])-Math.min(...axes[2])};}
export function buildTechPack(design,profile=null){const revision=revisionOf(design),p=profile?parseMachineProfile(profile):null,ruleReport=validateManufacturing(design,p);return {schema:'silk-tech-pack',version:1,revision,kind:design.kind||null,designId:design.designId||null,materials:clone(design.materials||[]),dimensions:dimensionsOf(design),dimensionUnits:'m',graph:clone(design.graph||null),graphs:clone(design.graphs||[]),geometry:clone(design.model||null),boundaries:clone(design.boundaries||null),operations:clone(design.operations||[]),machineProfile:p,ruleReport,postProcessing:clone(design.postProcessing||p?.postProcessing||[]),nativeProgram:null,manufacturingStatus:ruleReport.overall,evidenceVerified:false,productionVerified:false,notice:'技术数据包用于工艺评审。样品与设备来源仅为导入声明，未经可信外部验证；尚无工业设备原生程序。'};}
