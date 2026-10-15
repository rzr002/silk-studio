import {fitStocking,normalizeDimensions} from './garment-geometry.mjs';
import {DesignDocument} from './design-document.mjs';
import {createKnit,restoreKnit} from './knit.mjs';
import {restoreModel} from './physics.mjs';

/** Playable process model, not a knitting-machine controller. Millimetres are
 * explicit in loopLengthMm; garment dimensions are metres. Forty visual cells
 * and 48 course groups do not assert actual machine gauge or yarn consumption.
 * Every successful action is recorded; invalid actions cannot mutate state.
 */
export const YARNS=Object.freeze([
  Object.freeze({id:'nylon-fine',name:'细尼龙纱',color:'#d8c3aa',sampleStiffnessN:1.2,maxSampleExtension:.55,stiffnessFactor:.7,sourceType:'synthetic',calibrated:false}),
  Object.freeze({id:'nylon-stretch',name:'尼龙包覆弹力纱',color:'#594844',sampleStiffnessN:.7,maxSampleExtension:.85,stiffnessFactor:.45,sourceType:'synthetic',calibrated:false}),
  Object.freeze({id:'reinforced',name:'加固尼龙纱',color:'#252a32',sampleStiffnessN:1.8,maxSampleExtension:.65,stiffnessFactor:1.3,sourceType:'synthetic',calibrated:false})
]);
export const GUIDES=Object.freeze(['guide-1','tensioner','feeder']);
const STITCHES=['knit','tuck','miss'],ZONES=['cuff','leg','foot'];
const ACTIONS={
  'mount-yarn':['yarnId'],thread:['guideId'],unthread:[],
  'sample-knit':['courses'],'sample-pull':['extension'],'set-loop-length':['mm'],'accept-sample':[],
  'set-dimension':['key','value'],'set-stitch':['row','col','stitch'],'start-knit':[],'pause-knit':[],knit:['courses'],unravel:['toCourse'],
  'align-toe':['offset'],sew:['amount'],unpick:[],'set-dye':['color'],dye:['amount'],board:[],smooth:['zone'],heat:['amount'],
  dress:[],pose:['angle'],inspect:[],name:['value']
};
const copy=x=>JSON.parse(JSON.stringify(x));
function freeze(x){if(x&&typeof x==='object'){for(const v of Object.values(x))freeze(v);Object.freeze(x);}return x;}
function need(condition,message){if(!condition)throw new Error(message);}
function range(value,low,high,label,integer=false){need(Number.isFinite(value)&&value>=low&&value<=high&&(!integer||Number.isInteger(value)),`${label}必须为 ${low}–${high}${integer?' 整数':''}`);return value;}
function progress(current,amount){const next=Math.min(1,current+amount);return next>=1-1e-12?1:next;}
function id(value){need(typeof value==='string'&&value.length>0&&value.length<=160&&!/[\u0000-\u001f]/.test(value),'工坊 ID 无效');return value;}
function yarnOf(s){return YARNS.find(y=>y.id===s.recipe.yarnId);}
function threaded(s){return s.threading.mounted&&GUIDES.every((g,i)=>s.threading.path[i]===g)&&s.threading.path.length===GUIDES.length;}
const finishState=color=>({color,dyeProgress:0,dyed:false,boarded:false,smoothedZones:[],heatProgress:0,set:false});
const wearState=()=>({dressed:false,pose:0,inspection:null});
function clearAfterKnit(s){s.seam={alignment:0,feed:0,closed:false,quality:null};s.finish=finishState(s.finish.color);s.wear=wearState();}
function stage(s){return !threaded(s)?'yarn':!s.sample.acceptedId?'sample':s.production.producedCourses<s.production.totalCourses?'knit':!s.seam.closed||s.seam.quality!=='aligned'?'seam':!s.finish.set?'finish':'wear';}
function resetSample(s){s.sample.courses=0;s.sample.pull=0;s.sample.activeId=null;s.sample.acceptedId=null;s.production.running=false;clearAfterKnit(s);s.stage=stage(s);}
function goodSeam(s){need(s.production.producedCourses===48&&s.seam.closed&&s.seam.quality==='aligned','请先完成并对齐封尖；错位需拆线返工');}
function notWoven(s){need(s.production.producedCourses===0,'已织部分不可改写，请先显式拆回第 0 横列组');}
function actionValue(action){
  need(action&&typeof action==='object'&&!Array.isArray(action)&&Object.getPrototypeOf(action)===Object.prototype,'动作必须为普通对象');
  const fields=ACTIONS[action.type];need(fields,'未知制作动作');
  need(Object.keys(action).length===fields.length+1&&Object.keys(action).every(k=>k==='type'||fields.includes(k)),'动作字段缺失或包含未知字段');
  return action;
}
function initial(sessionId){return {
  schema:'silk-workshop',version:1,id:sessionId,revision:1,name:'未命名袜作',stage:'yarn',
  recipe:{yarnId:null,loopLengthMm:3,dimensions:normalizeDimensions(),program:{cols:40,rows:48,cells:Array(1920).fill('knit')}},
  threading:{mounted:false,path:[]},sample:{courses:0,totalCourses:8,pull:0,trials:[],activeId:null,acceptedId:null},
  production:{producedCourses:0,totalCourses:48,running:false,courses:[]},seam:{alignment:0,feed:0,closed:false,quality:null},
  finish:finishState('#594844'),wear:wearState(),events:[],
  assumptions:{route:'cuff-first-open-toe',machineNeedles:400,needlesPerVisualCell:10,courseGroups:48,visualColumns:40,
    machineParameterStatus:'assumed-demonstration',courseUnit:'visual-course-group',nativeProgram:null,calibrated:false},
  validation:{materialValidated:false,physicsValidated:false,machineValidated:false,manufacturingValidated:false,physicalSampleValidated:false}
};}

function apply(s,a,eventId){
  switch(a.type){
    case 'mount-yarn': {
      notWoven(s);need(YARNS.some(y=>y.id===a.yarnId),'未知纱筒');s.recipe.yarnId=a.yarnId;s.threading={mounted:true,path:[]};resetSample(s);return '纱筒已装上锭子，请依次穿过导纱、张力器和喂纱口。';
    }
    case 'thread': {
      need(s.threading.mounted,'请先装上纱筒');notWoven(s);need(GUIDES[s.threading.path.length]===a.guideId,'请按导纱路线顺序穿线');s.threading.path.push(a.guideId);s.stage=stage(s);return threaded(s)?'纱路完成，可以织试样。':'纱线已穿过这一处导向。';
    }
    case 'unthread':notWoven(s);s.threading.path=[];resetSample(s);return '纱路已退出，旧试样记录保留。';
    case 'set-loop-length': {
      range(a.mm,2,4.5,'线圈长度 mm');notWoven(s);s.recipe.loopLengthMm=a.mm;resetSample(s);return '线圈长度已改变，请织一块新试样；旧试样保留。';
    }
    case 'sample-knit': {
      range(a.courses,1,8,'试织横列',true);need(threaded(s),'请先完成穿线');notWoven(s);need(!s.sample.acceptedId,'试样已确认；需要新试样时先调整线圈长度');need(s.sample.courses+a.courses<=8,'试样最多 8 横列');
      if(!s.sample.activeId){s.sample.activeId=`${eventId}:sample`;s.sample.trials.push({id:s.sample.activeId,yarnId:s.recipe.yarnId,loopLengthMm:s.recipe.loopLengthMm,courses:0,pulls:[],maxPull:0,damaged:false,accepted:false,sourceEventId:eventId,sourceType:'synthetic',calibrated:false});}
      s.sample.courses+=a.courses;s.sample.trials.find(t=>t.id===s.sample.activeId).courses=s.sample.courses;s.stage='sample';return `试样已织 ${s.sample.courses}/8 横列。`;
    }
    case 'sample-pull': {
      range(a.extension,0,1,'试拉伸长');need(s.sample.courses===8&&s.sample.activeId,'请先织完整试样');need(!s.sample.acceptedId,'已确认的试样不能改写，请另织新试样');
      const trial=s.sample.trials.find(t=>t.id===s.sample.activeId),yarn=yarnOf(s);s.sample.pull=a.extension;trial.maxPull=Math.max(trial.maxPull,a.extension);trial.damaged ||= a.extension>yarn.maxSampleExtension;
      trial.pulls.push({extension:a.extension,forceN:a.extension*yarn.sampleStiffnessN*(3/s.recipe.loopLengthMm)**2,sourceEventId:eventId,sourceType:'synthetic',calibrated:false});
      return trial.damaged?'试样超出假设演示伸长范围，需另织新试样。':'已记录试拉；拉力是演示假设，尚无实测。';
    }
    case 'accept-sample': {
      notWoven(s);need(!s.sample.acceptedId,'这块试样已确认');need(threaded(s)&&s.sample.courses===8&&s.sample.activeId,'请先织完整试样');const trial=s.sample.trials.find(t=>t.id===s.sample.activeId);need(trial.maxPull>0,'请先实际试拉试样');need(!trial.damaged,'这块试样已受损，请重新调整并试织');trial.accepted=true;s.sample.acceptedId=trial.id;s.stage='knit';return '试样已确认，可以编织袜坯。';
    }
    case 'set-dimension': {
      notWoven(s);need(Object.hasOwn(s.recipe.dimensions,a.key),'未知尺寸');range(a.value,0,2,'尺寸 m');s.recipe.dimensions=normalizeDimensions({...s.recipe.dimensions,[a.key]:a.value});clearAfterKnit(s);s.stage=stage(s);return '自然尺寸已更新。';
    }
    case 'set-stitch': {
      range(a.row,0,47,'横列组',true);range(a.col,0,39,'针目组',true);need(STITCHES.includes(a.stitch),'未知针法');need(!s.production.running,'请先暂停编织再改针法');need(a.row>=s.production.producedCourses,'该横列已织出，请先拆回要修改的位置');s.recipe.program.cells[a.row*40+a.col]=a.stitch;s.wear.inspection=null;return '尚未织出的针目程序已更新。';
    }
    case 'start-knit':need(threaded(s)&&s.sample.acceptedId,'请先完成穿线、试织和试拉确认');need(s.production.producedCourses<48,'袜坯已织完');need(!s.production.running,'编织已经启动');s.production.running=true;s.stage='knit';return '织机已启动，转动手轮或运行编织。';
    case 'pause-knit':need(s.production.running,'织机尚未启动');s.production.running=false;return '织机已暂停。';
    case 'knit': {
      range(a.courses,1,48,'横列组',true);need(s.production.running,'请先启动织机');need(threaded(s)&&s.sample.acceptedId,'纱路或试样确认缺失');need(s.production.producedCourses+a.courses<=48,'不能超过 48 个展示横列组');
      for(let row=s.production.producedCourses;row<s.production.producedCourses+a.courses;row++)s.production.courses.push({id:`${eventId}:course-${row}`,row,cells:s.recipe.program.cells.slice(row*40,(row+1)*40),yarnId:s.recipe.yarnId,loopLengthMm:s.recipe.loopLengthMm,sourceEventId:eventId,unit:'visual-course-group'});
      s.production.producedCourses+=a.courses;if(s.production.producedCourses===48)s.production.running=false;s.stage=stage(s);return `袜坯已织 ${s.production.producedCourses}/48 组${s.stage==='seam'?'，脚尖尚未封合':''}。`;
    }
    case 'unravel': {
      range(a.toCourse,0,s.production.producedCourses,'拆回横列组',true);need(a.toCourse<s.production.producedCourses,'请拆回比当前更早的横列');s.production.courses=s.production.courses.slice(0,a.toCourse);s.production.producedCourses=a.toCourse;s.production.running=false;clearAfterKnit(s);s.stage=stage(s);return `已拆回 ${a.toCourse} 组，之后的封尖、染整和试穿已失效。`;
    }
    case 'align-toe':range(a.offset,-1,1,'封尖偏移');need(s.production.producedCourses===48,'请先织完整袜坯');need(s.seam.feed===0&&!s.seam.closed,'已缝部分需先拆线，不能直接改对位');s.seam.alignment=a.offset;return Math.abs(a.offset)<=.12?'两侧袜尖已对齐。':'两侧仍错位，缝合后需返工。';
    case 'sew': {
      range(a.amount,0,1,'缝合进度');need(s.production.producedCourses===48,'请先织完整袜坯');need(!s.seam.closed,'脚尖已封合，需要返工请先拆线');s.seam.feed=progress(s.seam.feed,a.amount);
      if(s.seam.feed>=1){s.seam.closed=true;s.seam.quality=Math.abs(s.seam.alignment)<=.12?'aligned':'misaligned';}s.stage=stage(s);return s.seam.quality==='misaligned'?'封尖错位，需拆线后重新对齐。':s.seam.closed?'脚尖已封合，可以染整。':'缝纫机正在封尖。';
    }
    case 'unpick':need(s.seam.feed>0||s.seam.closed,'没有可拆除的封尖缝线');s.seam.feed=0;s.seam.closed=false;s.seam.quality=null;s.finish=finishState(s.finish.color);s.wear=wearState();s.stage=stage(s);return '封尖线已拆除，请重新对齐；后续加工已失效。';
    case 'set-dye': {
      need(/^#[0-9a-fA-F]{6}$/.test(a.color),'染色颜色必须为六位十六进制');goodSeam(s);s.finish=finishState(a.color.toLowerCase());s.wear=wearState();s.stage='finish';return '染色配方已改变，需要重新染整和定型。';
    }
    case 'dye':range(a.amount,0,1,'染色进度');goodSeam(s);need(!s.finish.dyed,'已经染好；换色请先选择新染色配方');s.finish.dyeProgress=progress(s.finish.dyeProgress,a.amount);s.finish.dyed=s.finish.dyeProgress>=1;return s.finish.dyed?'染色完成，可以套板。':'袜坯正在染色。';
    case 'board':goodSeam(s);need(s.finish.dyed,'请先完成染色');s.finish.boarded=true;s.finish.smoothedZones=[];s.finish.heatProgress=0;s.finish.set=false;s.wear=wearState();s.stage='finish';return '袜子已套到定型板，请拉平袜口、腿部和足部。';
    case 'smooth':goodSeam(s);need(s.finish.boarded,'请先套板');need(ZONES.includes(a.zone),'未知拉平区域');need(!s.finish.set,'已热定型；重新整理请先重新套板');if(!s.finish.smoothedZones.includes(a.zone)){s.finish.smoothedZones.push(a.zone);s.finish.heatProgress=0;}return '该区域已拉平。';
    case 'heat':range(a.amount,0,1,'热处理进度');goodSeam(s);need(s.finish.dyed&&s.finish.boarded,'请先染色并套板');need(ZONES.every(z=>s.finish.smoothedZones.includes(z)),'请先拉平全部三个区域');need(!s.finish.set,'热定型已完成');s.finish.heatProgress=progress(s.finish.heatProgress,a.amount);s.finish.set=s.finish.heatProgress>=1;s.stage=stage(s);return s.finish.set?'热定型完成，可以试穿。':'正在进行演示热处理。';
    case 'dress':goodSeam(s);need(s.finish.set,'请先完成染整和热定型');s.wear.dressed=true;s.wear.inspection=null;s.stage='wear';return '已初始化到人台上展示；这不是完整穿入物理仿真。';
    case 'pose':range(a.angle,0,55,'姿态角度');need(s.wear.dressed,'请先试穿');s.wear.pose=a.angle;s.wear.inspection=null;return '人台展示姿态已改变，请重新检查。';
    case 'inspect': {
      need(s.wear.dressed,'请先试穿');const issues=[];
      for(const course of s.production.courses)if(course.cells.every(c=>c==='miss'))issues.push({code:'NO_FORMED_LOOPS',severity:'error',course:course.row,message:'整横列只有浮线，没有形成新线圈。'});
      if(s.recipe.program.cells.includes('miss'))issues.push({code:'FLOATS_REQUIRE_REVIEW',severity:'warning',message:'浮线长度和勾挂风险尚需具体设备及实样检查。'});
      s.wear.inspection={passed:!issues.some(i=>i.severity==='error'),issues,atRevision:s.revision+1,scope:'observable-workshop-process',physicsValidated:false,manufacturingValidated:false,comfortOrPressureEvaluated:false};return s.wear.inspection.passed?'制作流程检查通过；实际舒适度、压力和生产仍未验证。':'检查发现未形成线圈的横列，请拆回返工。';
    }
    case 'name':need(typeof a.value==='string'&&a.value.trim().length>0&&a.value.trim().length<=80,'作品名称必须为 1–80 个字符');s.name=a.value.trim();return '作品已命名。';
  }
}

export class WorkshopSession {
  #state;
  constructor({id:sessionId}={}){this.#state=freeze(initial(id(sessionId||`workshop-${globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2)}`)));}
  get state(){return this.#state;}
  snapshot(){return copy(this.#state);}
  dispatch(action){
    actionValue(action);need(this.#state.events.length<10000,'制作记录过多');const next=copy(this.#state),eventId=`${next.id}:event-${next.revision+1}`;
    const feedback=apply(next,action,eventId);next.revision++;next.events.push({id:eventId,revision:next.revision,action:copy(action)});this.#state=freeze(next);
    return {ok:true,feedback,stage:next.stage,revision:next.revision,eventId};
  }
}
function canonical(value){if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;return JSON.stringify(value);}
function jsonOnly(value,depth=0,seen=new Set()){
  need(depth<30,'制作文件层级过深');
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){need(Number.isFinite(value),'制作文件包含非有限数');return;}
  need(value&&typeof value==='object'&&!seen.has(value),'制作文件必须为无循环纯 JSON');seen.add(value);
  need(Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype,'制作文件包含非 JSON 对象');
  if(Array.isArray(value))need(value.length<=20000&&Object.keys(value).length===value.length,'制作数组过大或稀疏');
  for(const v of Object.values(value))jsonOnly(v,depth+1,seen);seen.delete(value);
}
export function restoreWorkshop(saved){
  jsonOnly(saved);need(saved?.schema==='silk-workshop'&&saved.version===1,'不支持的工坊文件版本');id(saved.id);
  need(Array.isArray(saved.events)&&saved.events.length<=10000&&Number.isSafeInteger(saved.revision)&&saved.revision===saved.events.length+1,'制作事件与版本不一致');
  need(JSON.stringify(saved).length<=4_000_000,'制作文件过大');
  const session=new WorkshopSession({id:saved.id});for(const event of saved.events){need(event&&typeof event==='object'&&event.action,'制作事件缺少动作');session.dispatch(event.action);}
  need(canonical(session.state)===canonical(saved),'制作状态与可重放工序记录不一致');return session;
}
function stateOf(session){return session instanceof WorkshopSession?session.state:restoreWorkshop(session).state;}

/** The legacy graph is a spatial equivalent, not a circular knitting program.
 * Its row 0 lies at toe UV=0; original production order remains in the bridge.
 * All machine/physical validation stays false. No source kernel is modified.
 */
const sourceCache=new Map();
function sourceTemplate(s){
  const revision=s.events.filter(e=>e.action.type==='set-stitch').length,key=JSON.stringify([s.recipe.dimensions,s.recipe.program.cells,revision]);
  if(sourceCache.has(key)){const found=sourceCache.get(key);sourceCache.delete(key);sourceCache.set(key,found);return found;}
  const design=new DesignDocument({id:'workshop-source-template',dimensions:s.recipe.dimensions,cols:40,rows:48});
  const graph=createKnit({cols:40,rows:48}).snapshot();graph.cells=[];
  for(let graphRow=0;graphRow<48;graphRow++)graph.cells.push(...s.recipe.program.cells.slice((47-graphRow)*40,(48-graphRow)*40));
  graph.revision=revision;
  design.regions=[{id:'workshop-program',bounds:{u0:0,u1:1,v0:0,v1:1},graph:restoreKnit(graph)}];design.activeRegionId='workshop-program';design.regionSequence=1;design.operations=[];design.rebuild(null);
  const template={graph,model:design.model.snapshot()};sourceCache.set(key,template);if(sourceCache.size>3)sourceCache.delete(sourceCache.keys().next().value);return template;
}
function compileDesign(s){
  const template=sourceTemplate(s),design=new DesignDocument({id:s.id,dimensions:s.recipe.dimensions,cols:40,rows:48,pose:s.wear.pose});
  design.regions=[{id:'workshop-program',bounds:{u0:0,u1:1,v0:0,v1:1},graph:restoreKnit(template.graph)}];design.activeRegionId='workshop-program';design.regionSequence=1;design.operations=[];design.model=restoreModel(template.model);
  const yarn=yarnOf(s)||YARNS[1],factor=yarn.stiffnessFactor*(3/s.recipe.loopLengthMm)**2;
  const source=s.events.findLast(e=>['mount-yarn','set-loop-length'].includes(e.action.type));
  design.applyOperation({type:'material',id:'workshop-recipe-material',operationId:source?.id||`${s.id}:default-recipe`,bounds:{u0:0,u1:1,v0:0,v1:1},
    parameters:{warp:factor,weft:factor,shear:factor,bend:1,restScale:s.recipe.loopLengthMm/3},sourceEventId:source?.id||null,sourceType:'synthetic',calibrated:false});
  // A global recipe edit must not overwrite all local tuck/miss behavior.
  // These typed operations are replayed by the unmodified DesignDocument.
  for(let row=0;row<48;row++)for(let col=0;col<40;col++){
    const stitch=s.recipe.program.cells[row*40+col];if(stitch==='knit')continue;
    const local=stitch==='tuck'?{weft:1.6,warp:.65,shear:1.3,restScale:1.04}:{weft:.25,warp:.2,shear:.25,restScale:1};
    const graphRow=47-row,u=.5+(col-19.5)*.9/40,v=.5+(graphRow-23.5)*.9/48,du=.45/40,dv=.45/48;
    const event=s.events.findLast(e=>e.action.type==='set-stitch'&&e.action.row===row&&e.action.col===col);
    design.applyOperation({type:'material',id:`workshop-stitch-${row}-${col}`,operationId:event?.id||`${s.id}:default-stitch-${row}-${col}`,sourceEventId:event?.id||null,sourceType:'synthetic',calibrated:false,
      bounds:{u0:u-du,u1:u+du,v0:v-dv,v1:v+dv},parameters:{warp:factor*local.warp,weft:factor*local.weft,shear:factor*local.shear,restScale:Math.min(1.5,s.recipe.loopLengthMm/3*local.restScale)}});
  }
  fitStocking(design.model,{pose:s.wear.pose});design.revision=s.revision;design.snapshot();return design;
}
export function createWorkshopModel(session){
  const s=stateOf(session),model=compileDesign(s).model;if(!s.wear.dressed)model.resetPose();return model;
}

export function finalizeWorkshop(session){
  const s=stateOf(session);need(s.stage==='wear'&&s.wear.dressed&&s.finish.set&&s.wear.inspection?.passed,'请先完成制作、试穿并通过制作流程检查');goodSeam(s);
  const design=compileDesign(s),bridge={schema:'silk-workshop-bridge',version:1,sourceId:s.id,sourceRevision:s.revision,designId:design.id,designRevision:design.revision,
    source:copy(s),courseMap:s.production.courses.map(c=>({courseId:c.id,productionRow:c.row,graphRow:47-c.row,sourceEventId:c.sourceEventId,uvCenterV:1-(c.row+.5)/48})),
    organization:{regionId:'workshop-program',cols:40,rows:48,scope:'coarse-spatial-loop-support-equivalent',productionOrder:'cuff-to-toe',graphStorageOrder:'toe-to-cuff',machineProgramCompiled:false},
    toeClosure:{process:'separate-aligned-toe-sewing',sourceEventIds:s.events.filter(e=>['align-toe','sew','unpick'].includes(e.action.type)).map(e=>e.id),approximation:'existing free concentric disk / 封尖盘数值近似；未模拟实际缝线'},
    assumptions:copy(s.assumptions),validation:copy(s.validation),nativeProgram:null,
    limitations:['No physical material, dyeing, thermal-setting, comfort or machine calibration.','The canonical rest shape is a prescribed shape, not a yarn-level manufacturing prediction.','Sample forces and recipe stiffness/rest-length mapping are synthetic assumptions.']};
  return {design,bridge};
}
