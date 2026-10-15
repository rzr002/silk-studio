import {createPatch,restoreModel} from './physics.mjs';
import {DesignDocument,restoreDesign,restFrameAtUV} from './design-document.mjs';
import {fitStocking} from './garment-geometry.mjs';
import {editRestShape} from './rest-shape.mjs';
import {parseMaterialCSV,fitMaterial} from './material-data.mjs';
import {computeDeformation,opticalResponse} from './deformation.mjs';
import {parseMachineProfile,validateManufacturing,buildTechPack} from './manufacturing.mjs';
import {PhysicsScene} from './scene.mjs';
import {NativeSimulationController} from './native-simulation.mjs';
import {validateWorkshopOrigin,packWorkshopResume} from './workshop-project.mjs';

const $=id=>document.getElementById(id),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const labels={patch:'组织展开',knit:'线圈细节',stocking:'丝袜试穿',lab:'材料试验'};
const toolLabels={grab:'抓取',pin:'固定',cut:'开缝',sew:'缝合',region:'区域',shape:'改版',orbit:'视角'};
const hints={grab:'拖动试拉，松手观察回弹；展开图请使用改版工具。',pin:'点击添加或取消固定点。',cut:'拖出切线，沿网格边分离两侧；保留材料。',sew:'分别拖选两段边界路径；也可缝合最近切口。',region:'在整件上点选组织区或拖出新区；在线圈视图点击修改针目。',shape:'拖动修改局部自然尺寸；释放后保留。',orbit:'拖动旋转视角，滚轮缩放；右键也可旋转。'};
const STORAGE='silk-design-workbench-v2';
let doc=new DesignDocument(),lab=createPatch(),kind='stocking',tool='grab',playing=false,pose=0,targetPose=0,scene;
let workshopOrigin=null;
let history=[],redo=[],records=[],pending=null,stroke=null,sewFirst=null,trial=null,forceSamples=[];
let worker,browserWorker,nativeController,receiveResult,epoch=0,computing=false,computingStarted=0,steps=0,frameMs=0,lastUI=0,lastRender=0,solverError='',settings={},endGrab=null,grabDirty=false,lastRuleRevision=0,queuedGrabs=[],queuedGesture=null,workerDirty=true,computedDesignId=null,computedRevision=null;
const current=()=>kind==='lab'?lab:doc.model;
const clone=x=>JSON.parse(JSON.stringify(x));
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('visible'),4000);}
function readSettings(){return {backend:$('solver-backend').value,gravity:$('gravity').checked,collider:$('collider').checked,selfCollision:$('self-collision').checked,continuousCollision:$('continuous-collision').checked,quality:$('quality').value};}
function syncSolver(){epoch++;computing=false;endGrab=null;grabDirty=false;solverError='';workerDirty=true;}
function activateBackend(){nativeController?.terminate();nativeController=null;if($('solver-backend').value==='native'){nativeController=new NativeSimulationController();nativeController.onmessage=receiveResult;worker=nativeController;}else worker=browserWorker;$('prepare-reference').hidden=$('solver-backend').value!=='native';}
async function checkNativeBackend(){try{const response=await fetch('/api/health'),health=await response.json();if(!response.ok)throw new Error('本地接口不可用');const option=$('solver-backend').querySelector('[value="native"]');option.disabled=!health.referenceAvailable;option.textContent=health.referenceAvailable?'本地 IPC · 实验验证':'本地 IPC · 未安装';$('reference-status').textContent=health.referenceAvailable?'IPC已连接 · 实验线性求解；当前作品与真实材料仍需验证。':'浏览器接触有穿透反例。本地IPC需安装依赖并用项目服务启动。';}catch{$('solver-backend').querySelector('[value="native"]').textContent='本地 IPC · 未启动';$('reference-status').textContent='浏览器接触有穿透反例。本地IPC需使用项目服务启动。';}}
function state(){return {format:'silk-design-workbench',version:2,activeView:kind,design:doc.snapshot(),lab:lab.snapshot(),pose,targetPose,settings:readSettings(),playing:false,manufacturing:{status:'unverified',nativeProgram:null},...(workshopOrigin?{workshopOrigin:clone(workshopOrigin)}:{})};}
function restore(saved,{clearHistory=false}={}){
  if(saved?.format!=='silk-design-workbench'||saved.version!==2||!labels[saved.activeView])throw new Error('请选择 0.3 工作台导出的作品文件；早期独立实验格式不能直接作为统一作品。');
  if(![saved.pose,saved.targetPose].every(v=>Number.isFinite(v)&&v>=0&&v<=55))throw new Error('姿态必须在 0–55° 之间');
  const next=restoreDesign(saved.design),nextLab=restoreModel(saved.lab),s=saved.settings;
  if(nextLab.kind!=='patch'||!s||!['browser','native'].includes(s.backend??'browser')||!['fast','standard','reference'].includes(s.quality)||!['gravity','collider','selfCollision','continuousCollision'].every(k=>typeof s[k]==='boolean'))throw new Error('材料试验或求解设置无效');
  const nextOrigin=saved.workshopOrigin?validateWorkshopOrigin(saved.workshopOrigin,next).origin:null;
  workshopOrigin=nextOrigin;
  doc=next;lab=nextLab;doc.model.release();lab.release();kind=saved.activeView;pose=saved.pose;doc.pose=pose;targetPose=saved.targetPose;trial=null;stroke=null;pending=null;sewFirst=null;forceSamples=[];queuedGrabs=[];queuedGesture=null;
  for(const [key,id] of [['gravity','gravity'],['collider','collider'],['selfCollision','self-collision'],['continuousCollision','continuous-collision']])$(id).checked=s[key];$('quality').value=s.quality;$('solver-backend').value=s.backend??'browser';activateBackend();
  if(clearHistory){history=[];redo=[];records=['打开统一作品'];}setPlaying(false);mount();
}
function mount(){
  const m=current();scene.pose=pose;scene.setModel(m,kind,kind==='knit'?doc.activeRegion.graph:null,{region:kind==='lab'?null:doc.activeRegion,regions:kind==='lab'?[]:doc.regions,material:doc.material,bodyDimensions:doc.bodyDimensions});
  scene.setCollider($('collider').checked);scene.setWire($('wireframe').checked);scene.setStrain($('strain-view').checked);scene.tool=tool;
  applyWorkshopAppearance();
  $('knit-controls').hidden=kind==='lab';$('stocking-controls').hidden=kind!=='stocking';$('scene-name').textContent=labels[kind];
  for(const b of document.querySelectorAll('[data-scene]')){const on=b.dataset.scene===kind;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));}
  if($('apply-material-button'))$('apply-material-button').textContent=kind==='lab'?'应用到整块样片':'应用到所选组织区';
  $('view-note').textContent={patch:'同一件丝袜的 UV 组织图 · 展开图长度不代表实际尺寸',knit:'所选区域的线圈结构 · 纱线为示意，物理使用等效约束',stocking:'完整丝袜 · 自然尺寸与人台尺寸独立 · 尚未实样校准',lab:'独立材料样片 · 使用当前材料曲线 · 不改变作品结构'}[kind];
  for(const el of document.querySelectorAll('[data-dimension]')){el.value=(doc.dimensions[el.dataset.dimension]*100).toFixed(1);document.querySelector(`[data-dimension-output="${el.dataset.dimension}"]`).textContent=Number(el.value).toFixed(1);}
  $('pose').value=targetPose;$('pose-value').textContent=`${pose.toFixed(0)}°`;
  syncSolver();updateUI();scene.render();
}
function applyWorkshopAppearance(){
  if(!workshopOrigin||kind==='lab')return;
  scene.material.color.set(workshopOrigin.workshop.finish.color);
  if(scene.yarn&&!$('strain-view').checked)scene.yarn.material.color.set(workshopOrigin.workshop.finish.color);
  scene.invalidate();
}
function commit(label,before){history.push({label,before,after:state()});if(history.length>20)history.shift();redo=[];records.unshift(label);records=records.slice(0,9);updateUI();}
function change(label,fn,{remount=true}={}){if($('solver-backend').value==='native')setPlaying(false);finishPendingGrab();const before=state();try{const result=fn();if(remount)mount();else{syncSolver();scene.update();}commit(label,before);return result;}catch(e){toast(e.message);mount();return null;}}
function view(value){finishPendingGrab();queuedGrabs=[];queuedGesture=null;current().release();trial=null;kind=value;pending=null;stroke=null;sewFirst=null;mount();setTool(kind==='knit'?'region':'grab');}
function setTool(value){finishPendingGrab();queuedGrabs=[];queuedGesture=null;current().release();trial=null;pending=null;stroke=null;sewFirst=null;tool=value;scene.tool=tool;scene.select(null);syncSolver();$('mode-badge').textContent=toolLabels[tool];$('hint-text').textContent=hints[tool];for(const b of document.querySelectorAll('[data-tool]')){const on=b.dataset.tool===value;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));}}
function finishPendingGrab(){if(!endGrab)return;const before=endGrab.before;current().release();endGrab=null;queuedGrabs=[];queuedGesture=null;if(before)commit('抓取并释放',before);}
function launchQueuedGrab(){if(computing||endGrab||!queuedGrabs[0]?.ended)return;const g=queuedGrabs.shift(),m=current();if(!m.active[g.index])return;const before=state();m.grab(g.index,g.target);syncSolver();endGrab={before,finalRequested:true};solveOnce();}
function selectedCell(uv){const r=doc.activeRegion,b=r.bounds,u=(uv[0]-b.u0)/(b.u1-b.u0),v=(uv[1]-b.v0)/(b.v1-b.v0);let best=null,d=Infinity;for(const n of r.graph.nodes){const q=(u-.5-n.x)**2+(v-.5-n.y)**2;if(q<d){best=n;d=q;}}return best;}
function boundaryPath(m,a,b){
  const edges=new Map();for(let j=0;j<m.triangles.length;j+=3){const f=m.triangles.slice(j,j+3);for(let k=0;k<3;k++){const x=f[k],y=f[(k+1)%3],key=x<y?`${x}:${y}`:`${y}:${x}`;edges.set(key,(edges.get(key)||0)+1);}}
  const adj=new Map();for(const [edge,n] of edges)if(n===1){const [x,y]=edge.split(':').map(Number);if(!adj.has(x))adj.set(x,[]);if(!adj.has(y))adj.set(y,[]);adj.get(x).push(y);adj.get(y).push(x);}
  const q=[a],parent=new Map([[a,null]]);for(let i=0;i<q.length&&!parent.has(b);i++)for(const n of adj.get(q[i])||[])if(!parent.has(n)){parent.set(n,q[i]);q.push(n);}if(!parent.has(b)||a===b)throw new Error('请沿同一段边界拖动至少两个顶点');const path=[];for(let n=b;n!=null;n=parent.get(n))path.unshift(n);return path;
}
function apply(op){return doc.applyOperation(op);}
function interact(e){
  const m=current();
  try{
    if(e.type==='cancel'){m.release();pending=null;stroke=null;syncSolver();return;}
    if(e.type==='start'){
      if($('solver-backend').value==='native')setPlaying(false);const h=e.hit;if(m.garment?.finishing?.toeCap&&h.uv[1]<=1e-7&&['shape','cut','region'].includes(tool)){toast('脚尖封口的 UV 不唯一；此处暂支持抓取和固定，结构编辑请在袜身操作。');return;}if(tool==='grab'&&(endGrab||queuedGrabs.length)){queuedGesture={index:h.index,target:h.point,ended:false};queuedGrabs.push(queuedGesture);stroke={queued:true};return;}$('selection-text').textContent=`顶点 ${h.index} · U ${h.uv[0].toFixed(2)} / V ${h.uv[1].toFixed(2)}`;trial=null;
      if(kind==='knit'&&(tool==='region'||tool==='cut')){const n=selectedCell(h.uv);if(!n)return;change(tool==='cut'?'删除实验针目':`针目 → ${$('stitch-type').value}`,()=>tool==='cut'?doc.removeStitch(doc.activeRegionId,n.row,n.col):doc.applyStitch(doc.activeRegionId,n.row,n.col,$('stitch-type').value));return;}
      if(tool==='pin'){change(m.pins.has(h.index)?'解除固定点':'添加固定点',()=>kind==='lab'?m.pin(h.index):apply({type:'pin',vertexId:m.vertexIds[h.index],enabled:!m.pins.has(h.index)}),{remount:false});return;}
      if(tool==='grab'&&kind==='patch'){toast('展开图用于结构编辑；请在试穿或材料试验中试拉。');return;}
      pending=state();stroke={from:h.uv,to:h.uv,index:h.index,endIndex:h.index,lastPoint:h.viewPoint||h.point};
      if(tool==='grab'){m.grab(h.index,h.point);syncSolver();solveOnce();}
    }
    if(e.type==='move'&&stroke?.queued){queuedGesture.target=[...e.point];return;}
    if(e.type==='end'&&stroke?.queued){queuedGesture.ended=true;queuedGesture=null;stroke=null;launchQueuedGrab();return;}
    if(e.type==='move'&&stroke){
      if(e.hit){stroke.to=e.hit.uv;stroke.endIndex=e.hit.index;}
      if(tool==='grab'){m.moveGrab(e.point);grabDirty=true;if(!playing)solveOnce();}
      if(tool==='shape'){
        let delta=e.point.map((x,i)=>x-stroke.lastPoint[i]),len=Math.hypot(...delta);if(len<1e-5)return;if(len>.08)delta=delta.map(x=>x*.08/len);
        if(kind==='lab')editRestShape(m,stroke.from,delta,Math.max(.10,Number($('brush-size').value)));
        else{const f=restFrameAtUV(m,stroke.from),dot=v=>delta.reduce((s,x,i)=>s+x*v[i],0);apply({type:'rest-edit',centerUV:stroke.from,deltaLocal:kind==='patch'?[delta[0],delta[1],0]:[dot(f.u),dot(f.v),dot(f.normal)],radius:Math.max(.10,Number($('brush-size').value))});}
        stroke.lastPoint=[...e.point];syncSolver();scene.update();
      }
    }
    if(e.type==='end'&&stroke){
      if(tool==='grab'){endGrab={before:pending,finalRequested:false};if(!computing){endGrab.finalRequested=true;solveOnce();}}
      if(tool==='shape'&&pending)commit('修改自然轮廓',pending);
      if(tool==='cut'){if(m.garment?.finishing?.toeCap&&stroke.to[1]<=1e-7)throw new Error('脚尖封口不能用当前 UV 路径唯一定位切口');const result=kind==='lab'?m.incisionSegmentUV(stroke.from,stroke.to):apply({type:'incision',aUV:stroke.from,bUV:stroke.to}).result;if(!result.ok)throw new Error(result.reason);mount();commit(`开缝 · 增加 ${result.addedVertices} 个边界顶点`,pending);toast('已分离边界，面片与材料质量保持');}
      if(tool==='sew'){
        const path=boundaryPath(m,stroke.index,stroke.endIndex);
        if(!sewFirst){sewFirst=path;$('selection-text').textContent=`已选第一段 ${path.length} 个边界点；拖选第二段`;}
        else{if(kind==='lab'){const r=m.sewPaths(sewFirst,path);if(!r.ok)throw new Error(r.reason);}else apply({type:'seam',pathA:sewFirst,pathB:path});sewFirst=null;mount();commit('缝合两段边界',pending);}
      }
      if(tool==='region'){
        if(kind==='lab'){const r=Number($('brush-size').value);m.setRegion({u0:clamp(stroke.to[0]-r,0,1),u1:clamp(stroke.to[0]+r,0,1),v0:clamp(stroke.to[1]-r,0,1),v1:clamp(stroke.to[1]+r,0,1)},materialValues());syncSolver();commit('样片局部材料',pending);}
        else{const distance=Math.hypot(stroke.from[0]-stroke.to[0],stroke.from[1]-stroke.to[1]);if(distance<.025){const r=doc.regions.find(r=>stroke.from[0]>=r.bounds.u0&&stroke.from[0]<=r.bounds.u1&&stroke.from[1]>=r.bounds.v0&&stroke.from[1]<=r.bounds.v1);if(r){doc.selectRegion(r.id);mount();}else{const rad=.10,u=stroke.from[0],v=stroke.from[1];doc.addRegion({u0:clamp(u-rad,0,.99),u1:clamp(u+rad,.01,1),v0:clamp(v-rad,0,.99),v1:clamp(v+rad,.01,1)});mount();commit('建立组织区域',pending);}}else{doc.addRegion({u0:clamp(Math.min(stroke.from[0],stroke.to[0]),0,.99),u1:clamp(Math.max(stroke.from[0],stroke.to[0]),.01,1),v0:clamp(Math.min(stroke.from[1],stroke.to[1]),0,.99),v1:clamp(Math.max(stroke.from[1],stroke.to[1]),.01,1)});mount();commit('建立组织区域',pending);}}
      }
      stroke=null;pending=null;updateUI();
    }
  }catch(error){toast(error.message);m.release();pending=null;stroke=null;mount();}
}
function materialValues(){return {weft:Number($('material-weft').value),warp:Number($('material-warp').value),shear:Number($('material-shear').value)};}
function setPlaying(value){playing=value;$('play-button').setAttribute('aria-pressed',String(value));$('play-button').querySelector('span').textContent=value?'暂停':'继续';updateUI();}
function solveOnce(){
  if(computing||solverError)return;const m=current();let nextPose=pose;
  if(kind!=='lab')nextPose=pose+clamp(targetPose-pose,-.7,.7);
  if(trial){trial.elapsed+=1/60;const f=clamp(trial.elapsed/1.8,0,1);m.moveGrab([trial.start[0]+.10*f,trial.start[1]-.09*f,trial.start[2]]);}
  if(workerDirty){worker.postMessage({type:'sync',snapshot:m.snapshot(),epoch,pose,bodyDimensions:doc.bodyDimensions,designId:kind==='lab'?'lab':doc.id,designRevision:kind==='lab'?0:doc.revision});workerDirty=false;}settings=readSettings();computing=true;computingStarted=performance.now();grabDirty=false;worker.postMessage({type:'step',epoch,pose:nextPose,bodyDimensions:doc.bodyDimensions,...settings,grabbed:clone(m.grabbed),dt:1/60});updateUI();
}
function chart(id,series,colors=['#ad7049']){const c=$(id),ctx=c.getContext('2d'),w=c.width,h=c.height;ctx.clearRect(0,0,w,h);ctx.strokeStyle='#d5d4cb';ctx.lineWidth=1;for(let i=1;i<4;i++){ctx.beginPath();ctx.moveTo(0,h*i/4);ctx.lineTo(w,h*i/4);ctx.stroke();}const max=Math.max(.02,...series.flatMap(s=>s.map(p=>p[1]))),maxX=Math.max(1e-4,...series.flatMap(s=>s.map(p=>p[0])));series.forEach((s,n)=>{if(s.length<2)return;ctx.beginPath();s.forEach(([x,y],i)=>{const px=x/maxX*w,py=h-8-y/max*(h-20);i?ctx.lineTo(px,py):ctx.moveTo(px,py);});ctx.strokeStyle=colors[n%colors.length];ctx.lineWidth=1.8;ctx.stroke();});ctx.font='10px monospace';ctx.fillStyle='#7c7e73';ctx.fillText(max.toFixed(2),5,12);}
function optics(){return opticalResponse(computeDeformation(current()),doc.material||{});}
function updateManufacturing(){lastRuleRevision=doc.revision;const r=validateManufacturing(doc.manufacturingInput(),doc.machine);const names={valid:'结构规则通过',compatible:'声明能力匹配',unverified:'未验证',blocked:'存在阻碍',passed:'有实样记录',failed:'实样失败'};for(const k of ['structure','device','sample'])$(`${k}-state`).textContent=names[r.states[k].status]||r.states[k].status;$('manufacturing-status').textContent=doc.machine?`${doc.machine.name} · ${doc.machine.provenance.status==='hypothetical'?'假设设备':'声明资料'} · 版本 ${doc.revision}`:'尚未指定真实设备';$('manufacturing-issues').replaceChildren(...r.issues.map(i=>{const li=document.createElement('li');li.textContent=i.message;return li;}));return r;}
function updateUI(){
  if(!scene)return;$('engine-label').textContent=$('solver-backend').value==='native'?'CPU / IPC · 实验':'CPU / XPBD · 实验';const m=current(),s=m.stats();$('design-id').textContent=doc.id.slice(-12);$('design-id').title=doc.id;$('design-revision').textContent=`v${doc.revision}`;$('active-region').textContent=`${doc.activeRegionId} · ${doc.regions.length} 区`;
  if($('workshop-origin-note')){$('workshop-origin-note').hidden=!workshopOrigin;$('workshop-origin-note').textContent=workshopOrigin?`工坊制作记录 v${workshopOrigin.bridge.designRevision}${doc.revision>workshopOrigin.bridge.designRevision?' · 已在专业台继续编辑':''} · 查看制作原件 ↗`:'';}
  $('stat-vertices').textContent=s.vertices;$('stat-faces').textContent=s.faces;$('stat-strain').textContent=`${(s.maxStrain*100).toFixed(1)}%`;$('stat-seams').textContent=s.seams;$('stat-topology').textContent=`v${doc.revision}`;$('stat-frame').textContent=`${frameMs.toFixed(1)} ms`;$('stat-force').textContent=`${(s.grabForceN||0).toFixed(3)} N`;
  $('status-text').textContent=`${labels[kind]} · ${s.constraints} 条约束 · ${(s.mass*1000).toFixed(1)} g · 未实样校准`;
  const needsSolve=kind!=='lab'&&(computedDesignId!==doc.id||computedRevision!==doc.revision);
  $('solver-state').textContent=solverError?`计算失败：${solverError}`:`${computing?`后台计算中 ${((performance.now()-computingStarted)/1000).toFixed(1)} s`:playing?'等待下一步':needsSolve?'结构待重算':'已暂停'} · 累计 ${steps} 步 · ${(steps/60).toFixed(2)} s 仿真`;
  const limiting=s.strainLimiting;if(limiting?.maxResidualEngineeringStrain>1e-3)$('solver-state').textContent+=' · 数值约束未收敛';else if(limiting?.corrections)$('solver-state').textContent+=' · 数值伸长限制生效';
  if(lastRuleRevision!==doc.revision){$('manufacturing-status').textContent=`版本 ${doc.revision} · 需要重新检查工艺`;$('structure-state').textContent='待检查';$('device-state').textContent='待检查';$('sample-state').textContent='未验证';$('manufacturing-issues').replaceChildren();}
  $('undo-button').disabled=!history.length;$('redo-button').disabled=!redo.length;
  const g=doc.activeRegion.graph;$('knit-status').textContent=`${g.stats().loops} 个线圈 · ${g.supportLinks().length} 条穿套支撑 · 组织映射为假设`;
  $('sew-latest').disabled=!m.cuts.some(c=>c.type==='incision');$('unstitch-button').disabled=!s.seams;
  $('history-list').replaceChildren(...(records.length?records.map(t=>Object.assign(document.createElement('li'),{textContent:t})):[Object.assign(document.createElement('li'),{textContent:'尚未编辑'})]));
  const mat=doc.material;$('material-state').textContent=mat?`${mat.sourceType==='synthetic'?'合成数据':'声明实测'} · ${mat.calibration.status==='validated'?'曲线留出验证通过':'曲线拟合'} · 整件未校准`:'实验刚度 · 无实测数据';
  const o=scene.optics||scene.optical||{};const extrapolated=o.extrapolated?[...o.extrapolated].reduce((a,b)=>a+b,0):0;
  $('optical-state').textContent=o.source?`${o.source==='synthetic-lut'?'合成透光表':o.source==='measured-lut'?'实测透光表':'几何假设'} · ${o.status==='validated'?'表内验证通过':'实验外观'}${extrapolated?` · ${extrapolated} 点超出数据范围`:''}`:'几何假设 · 实验外观';
  if($('material-validation-detail'))$('material-validation-detail').textContent=mat?`${mat.sampleId||'无样片编号'} · 张力 N/m · ${mat.calibration.missingDirections?.length?`缺少方向：${mat.calibration.missingDirections.join(' / ')}`:'横纵向及剪切曲线齐全'} · ${mat.calibration.validation?.rows||0} 条留出记录 · 仅验证曲线插值，整件尚未校准`:'请按模板提供应变、力 N、样片宽度 m 和标距 m；实测与合成来源分别记录。';
  chart('force-chart',[forceSamples.map((f,i)=>[i,f])]);chart('material-curve',mat?['warp','weft','shear'].map(k=>(mat.directionCurves[k]||[]).map(p=>[p.strain,p.tensionNPerM])):[],['#ad7049','#416d60','#768bad']);
}
function download(name,body,type='application/json'){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([body],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
function undoAction(reverse=false){finishPendingGrab();const source=reverse?redo:history,target=reverse?history:redo;if(!source.length)return;const item=source.pop();try{restore(reverse?item.after:item.before);target.push(item);records.unshift(`${reverse?'重做':'撤销'}：${item.label}`);}catch(e){source.push(item);toast(e.message);}updateUI();}
function sewLatest(){const m=current(),cut=[...m.cuts].reverse().find(c=>c.type==='incision');if(!cut)return;change('缝合最近切口',()=>{if(kind==='lab'){const r=m.sewPaths(cut.pathA,cut.pathB);if(!r.ok)throw new Error(r.reason);return r;}return apply({type:'seam',pathA:cut.pathA.map(i=>m.vertexIds[i]),pathB:cut.pathB.map(i=>m.vertexIds[i])});});}
function startTrial(){if(kind!=='lab'){view('lab');toast('已进入独立材料试验样片');}const m=current(),i=Math.round(m.rows*.2)*m.cols+m.cols-1,start=[...m.positions.slice(i*3,i*3+3)];trial={start,index:i,elapsed:0,before:state()};m.grab(i,start);forceSamples=[];scene.select(i);syncSolver();setPlaying(true);}
function releaseTrial(){const before=trial?.before||state();current().release();trial=null;syncSolver();commit('拉伸试验释放',before);}
async function importMaterial(text){const profile=fitMaterial(parseMaterialCSV(text,{sourceType:$('material-source-type').value}));change('导入材料方向曲线',()=>{doc.setMaterial(profile);lab.setMaterialLaw(profile);});updateManufacturing();}
try{
  browserWorker=new Worker(new URL('./simulation-worker.mjs',import.meta.url),{type:'module'});worker=browserWorker;
  receiveResult=({data:r})=>{if(r.epoch!==epoch)return;computing=false;if(r.type==='error'){solverError=r.message;setPlaying(false);toast(r.message);return;}if(r.type!=='result')return;const m=current();if(r.positions.length!==m.positions.length)return;m.positions.set(r.positions);m.velocities.set(r.velocities);if(r.lambdas)for(let i=0;i<m.constraints.length;i++)m.constraints[i].lambda=r.lambdas[i];m.grabForceN=r.grabForceN;m.collisionStats=r.collisionStats;m._strainDirty=true;if(kind!=='lab'){pose=r.pose;doc.pose=pose;computedDesignId=doc.id;computedRevision=doc.revision;scene.setPose(pose);$('pose-value').textContent=`${pose.toFixed(0)}°`;}steps++;frameMs=r.ms;forceSamples.push(m.grabForceN||0);if(forceSamples.length>120)forceSamples.shift();scene.update();updateUI();if(endGrab){if(!endGrab.finalRequested){endGrab.finalRequested=true;solveOnce();}else{const before=endGrab.before;m.release();endGrab=null;syncSolver();if(before)commit('抓取并释放',before);launchQueuedGrab();}}else if(!playing&&grabDirty&&m.grabbed)solveOnce();};
  browserWorker.onmessage=receiveResult;browserWorker.onerror=e=>{solverError=e.message;computing=false;setPlaying(false);};
  const detail=document.createElement('p');detail.id='material-validation-detail';detail.className='control-note';$('material-data-controls').querySelector('.panel-content').append(detail);
  const originLink=document.createElement('a');originLink.id='workshop-origin-note';originLink.className='control-note';originLink.href='./';originLink.hidden=true;originLink.onclick=event=>{if(!workshopOrigin)return;event.preventDefault();try{sessionStorage.setItem('silk-workshop-open-source',JSON.stringify(packWorkshopResume(workshopOrigin.workshop)));location.assign('./');}catch(error){toast(error.message);}};$('material-data-controls').querySelector('.panel-content').prepend(originLink);
  scene=new PhysicsScene($('viewport'),interact);mount();setTool('grab');setPlaying(false);$('loading').remove();updateManufacturing();
  for(const b of document.querySelectorAll('[data-scene]'))b.onclick=()=>view(b.dataset.scene);
  for(const b of document.querySelectorAll('[data-tool]'))b.onclick=()=>setTool(b.dataset.tool);
  $('edit-region-button').onclick=()=>view('knit');$('whole-view-button').onclick=()=>view('stocking');
  $('play-button').onclick=()=>setPlaying(!playing);$('step-button').onclick=()=>{setPlaying(false);solveOnce();};
  $('undo-button').onclick=()=>undoAction();$('redo-button').onclick=()=>undoAction(true);
  $('reset-button').onclick=()=>change(kind==='lab'?'重置材料样片':'重置作品结构',()=>{if(kind==='lab'){lab=createPatch();lab.setMaterialLaw(doc.material);}else{doc=new DesignDocument({material:doc.material,machine:doc.machine});workshopOrigin=null;pose=targetPose=0;}setPlaying(false);});
  $('wireframe').onchange=e=>scene.setWire(e.target.checked);$('strain-view').onchange=e=>{scene.setStrain(e.target.checked);applyWorkshopAppearance();};
  $('solver-backend').onchange=()=>{finishPendingGrab();setPlaying(false);current().release();if($('solver-backend').value==='native')$('quality').value='reference';activateBackend();syncSolver();updateUI();};
  $('prepare-reference').onclick=()=>change('以6mm数值余量重新贴合',()=>{setPlaying(false);fitStocking(doc.model,{pose,dimensions:doc.bodyDimensions,margin:.006});});
  checkNativeBackend();
  for(const id of ['gravity','collider','self-collision','continuous-collision','quality'])$(id).onchange=()=>{finishPendingGrab();scene.setCollider($('collider').checked);syncSolver();updateUI();};
  for(const [input,output] of [['material-weft','weft-value'],['material-warp','warp-value'],['material-shear','shear-value'],['brush-size','brush-value']])$(input).oninput=()=>{$(output).textContent=Number($(input).value).toFixed(input==='brush-size'?2:1);};
  const applyButton=document.createElement('button');applyButton.id='apply-material-button';applyButton.className='outline-button';applyButton.textContent='应用到所选组织区';$('local-material-controls').querySelector('.panel-content').append(applyButton);applyButton.onclick=()=>change('组织区局部材料倍率',()=>kind==='lab'?lab.setRegion({u0:0,u1:1,v0:0,v1:1},materialValues()):apply({type:'material',bounds:doc.activeRegion.bounds,parameters:materialValues()}),{remount:false});
  $('stitch-type').onchange=()=>setTool('region');$('sew-latest').onclick=sewLatest;$('unstitch-button').onclick=()=>{const id=[...current().constraints].reverse().find(c=>c.kind==='seam')?.seamId;if(id)change('拆除最近缝线',()=>kind==='lab'?lab.unstitch(id):apply({type:'unstitch',id}));};
  for(const input of document.querySelectorAll('[data-dimension]')){input.oninput=()=>document.querySelector(`[data-dimension-output="${input.dataset.dimension}"]`).textContent=Number(input.value).toFixed(1);input.onchange=()=>change('修改自然尺寸并重新贴合',()=>{doc.pose=pose;doc.setDimensions({...doc.dimensions,[input.dataset.dimension]:Number(input.value)/100});});}
  $('fit-button').onclick=()=>change('重新贴合人台',()=>{fitStocking(doc.model,{pose,dimensions:doc.bodyDimensions});});
  $('pose').oninput=()=>{targetPose=Number($('pose').value);setPlaying(true);};$('stretch-button').onclick=startTrial;$('release-button').onclick=releaseTrial;
  $('material-import').onclick=()=>$('material-file').click();$('material-template').onclick=async()=>{try{const t=await (await fetch('./data/synthetic-material.csv')).text();await importMaterial(t);toast('已载入合成示例，尚非实测数据');}catch(e){toast(e.message);}};
  $('material-file').onchange=async()=>{const f=$('material-file').files[0];if(!f)return;try{if(f.size>2e6)throw new Error('材料文件超过 2 MB');await importMaterial(await f.text());toast($('solver-backend').value==='native'?'材料数据已载入；本地 IPC 暂不支持此本构':'材料曲线已接入浏览器力学与实验外观；尚待实物校准');}catch(e){toast(e.message);}finally{$('material-file').value='';}};
  $('machine-import').onclick=()=>$('machine-file').click();$('machine-file').onchange=async()=>{const f=$('machine-file').files[0];if(!f)return;try{if(f.size>2e6)throw new Error('设备文件超过 2 MB');const p=parseMachineProfile(await f.text());change('导入设备能力资料',()=>doc.setMachine(p),{remount:false});updateManufacturing();}catch(e){toast(e.message);}finally{$('machine-file').value='';}};
  $('machine-demo').onclick=async()=>{try{const p=parseMachineProfile(await (await fetch('./data/hypothetical-machine.json')).text());change('载入假设设备规则',()=>doc.setMachine(p),{remount:false});updateManufacturing();}catch(e){toast(e.message);}};
  $('manufacturing-check').onclick=()=>{updateManufacturing();toast('已检查当前版本；实样与设备编译仍需验证');};$('manufacturing-export').onclick=()=>{const pack=buildTechPack(doc.manufacturingInput(),doc.machine);if(workshopOrigin)pack.workshopOrigin=clone(workshopOrigin);download(`silk-tech-pack-v${doc.revision}.json`,JSON.stringify(pack,null,2));updateManufacturing();};
  $('save-button').onclick=()=>{try{localStorage.setItem(STORAGE,JSON.stringify(state()));toast('作品及材料试验已保存到当前浏览器');}catch(e){toast('存储空间不足，请导出文件');}};
  $('load-button').onclick=()=>$('file-input').click();$('file-input').onchange=async()=>{const f=$('file-input').files[0];if(!f)return;try{if(f.size>20*1024*1024)throw new Error('作品文件超过 20 MB');restore(JSON.parse(await f.text()),{clearHistory:true});updateManufacturing();toast('作品源结构与求解状态已恢复');}catch(e){toast(e.message);}finally{$('file-input').value='';}};
  $('export-button').onclick=()=>download(`silk-design-v${doc.revision}.json`,JSON.stringify(state(),null,2));$('snapshot-button').onclick=()=>{const a=document.createElement('a');a.href=scene.capture();a.download=`silk-${kind}.png`;a.click();};
  document.addEventListener('keydown',e=>{if(/INPUT|SELECT|TEXTAREA/.test(e.target.tagName))return;if(e.code==='Space'){e.preventDefault();setPlaying(!playing);}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undoAction(e.shiftKey);}if(e.key==='Escape'){current().release();trial=null;sewFirst=null;syncSolver();}});
  const stored=localStorage.getItem(STORAGE);if(stored){try{restore(JSON.parse(stored));updateManufacturing();toast('已恢复上次保存的作品');}catch(e){toast(`保存的作品无法恢复：${e.message}`);}}
  window.workbench={inspect:()=>{const m=current(),o=scene.optics||scene.optical||optics(),g=doc.activeRegion.graph;return {kind,tool,playing,computing,solverError,rendering:clone(scene.renderStats||null),steps,frameMs,pose,targetPose,designId:doc.id,revision:doc.revision,activeRegionId:doc.activeRegionId,regions:doc.regions.map(r=>({id:r.id,bounds:r.bounds})),operations:clone(doc.operations),stats:m.stats(),positions:[...m.positions],history:[...records],knit:{...g.stats(),cells:g.snapshot().cells,supports:g.supportLinks()},material:clone(doc.material),machine:clone(doc.machine),optics:{source:o.source,status:o.status,minOpacity:Math.min(...o.opacity||[0]),maxOpacity:Math.max(...o.opacity||[0])},settings:readSettings(),snapshot:state()};},projectUV:(u,v)=>scene.projectUV(u,v),projectVertex:i=>scene.projectVertex(i)};
  function tick(time){requestAnimationFrame(tick);if(playing&&!computing)solveOnce();if(time-lastRender>16){scene.render();lastRender=time;}if(time-lastUI>250){updateUI();lastUI=time;}}requestAnimationFrame(tick);
}catch(error){console.error(error);if($('loading'))$('loading').textContent=`场景未能启动：${error.message}`;$('status-text').textContent='启动失败';}
