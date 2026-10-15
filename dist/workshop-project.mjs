import {WorkshopSession,restoreWorkshop,finalizeWorkshop} from './workshop.mjs';
import {restoreDesign} from './design-document.mjs';

/** Portable creation provenance. These functions do not read storage, run a
 * solver or mutate the supplied session/file. Verification is deterministic
 * source consistency, not a digital signature or physical manufacturing proof.
 * The legacy DesignDocument schema remains unchanged inside each envelope.
 */
const clone=value=>JSON.parse(JSON.stringify(value));
const need=(condition,message)=>{if(!condition)throw new Error(message);};
function canonical(value){if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;return JSON.stringify(value);}
function sameCompiledDesign(saved,compiled,path=''){
  if(saved===compiled)return true;
  if(typeof saved==='number'&&typeof compiled==='number'){
    // Only rederived geometry may differ at floating-point tails across JS
    // runtimes. Recipe, topology indices, IDs and bridge data stay exact.
    const derived=/^model\.(?:(?:positions|rest)\.\d+|constraints\.\d+\.(?:restLength|baseRestLength)|pinTargets\.\d+\.1\.\d+|initialMass)$/.test(path);
    return derived&&Math.abs(saved-compiled)<=1e-12;
  }
  const child=key=>path?`${path}.${key}`:String(key);
  if(Array.isArray(saved)||Array.isArray(compiled))return Array.isArray(saved)&&Array.isArray(compiled)&&saved.length===compiled.length&&saved.every((value,i)=>sameCompiledDesign(value,compiled[i],child(i)));
  if(saved&&compiled&&typeof saved==='object'&&typeof compiled==='object'){
    const keys=Object.keys(saved);return keys.length===Object.keys(compiled).length&&keys.every(key=>Object.hasOwn(compiled,key)&&sameCompiledDesign(saved[key],compiled[key],child(key)));
  }
  return false;
}
function jsonOnly(value,depth=0,seen=new Set()){
  need(depth<36,'项目文件层级过深');if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){need(Number.isFinite(value),'项目文件包含非有限数');return;}
  need(value&&typeof value==='object'&&!seen.has(value),'项目文件必须为无循环纯 JSON');
  need(Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype,'项目包含非 JSON 对象');
  if(Array.isArray(value))need(value.length<=100000&&Object.keys(value).length===value.length,'项目数组过大或稀疏');
  seen.add(value);for(const v of Object.values(value))jsonOnly(v,depth+1,seen);seen.delete(value);
}
function exactEnvelope(value,schema,fields){
  jsonOnly(value);need(value?.schema===schema&&value.version===1,'不支持的作品文件版本');
  need(Object.keys(value).length===fields.length&&fields.every(k=>Object.hasOwn(value,k)),'作品封装字段缺失或包含未知字段');
  need(JSON.stringify(value).length<=20*1024*1024,'作品文件超过 20 MB');
}
function completed(s){return s.stage==='wear'&&s.wear.dressed&&s.finish.set&&s.wear.inspection?.passed===true;}
function sessionOf(value){return value instanceof WorkshopSession?value:restoreWorkshop(value);}

/** Small local-storage source. Even a finished resume never compiles or embeds
 * a DesignDocument; full projects are intended for explicit file export.
 */
export function packWorkshopResume(value){return {schema:'silk-workshop-resume',version:1,workshop:sessionOf(value).snapshot()};}
export function restoreWorkshopResume(value){
  exactEnvelope(value,'silk-workshop-resume',['schema','version','workshop']);
  const session=restoreWorkshop(value.workshop),pausedOnRestore=session.state.production.running;
  if(pausedOnRestore)session.dispatch({type:'pause-knit'});
  return {session,pausedOnRestore,resume:packWorkshopResume(session)};
}

export function packWorkshopProject(value){
  const session=sessionOf(value),workshop=session.snapshot();let design=null,bridge=null;
  if(completed(workshop)){const result=finalizeWorkshop(session);design=result.design.snapshot();bridge=result.bridge;}
  return {schema:'silk-workshop-project',version:1,workshop,design,bridge};
}

export function validateWorkshopProject(value){
  exactEnvelope(value,'silk-workshop-project',['schema','version','workshop','design','bridge']);
  const session=restoreWorkshop(value.workshop),ready=completed(session.state);
  need((value.design===null)===(value.bridge===null),'成品设计与制作来源必须成对保存');
  need(ready?value.design!==null:value.design===null,'成品载荷与制作完成状态不一致');
  let design=null,bridge=null;
  if(ready){
    const compiled=finalizeWorkshop(session);
    // Recompile from the exact source, accepting only bounded tails in known
    // derived fields. Loaded geometry never replaces the canonical product.
    need(sameCompiledDesign(value.design,compiled.design.snapshot())&&canonical(value.bridge)===canonical(compiled.bridge),'成品与可重放制作记录不一致');
    design=compiled.design;bridge=compiled.bridge;
  }
  return {session,design,bridge};
}

export function restoreWorkshopProject(value){
  const checked=validateWorkshopProject(value),pausedOnRestore=checked.session.state.production.running;
  if(pausedOnRestore)checked.session.dispatch({type:'pause-knit'});
  const project=packWorkshopProject(checked.session);
  return {...checked,project,pausedOnRestore};
}

/** Carry this outer field through lab save, export, import, undo and redo.
 * sessionStorage alone is a navigation hint, not persistent provenance.
 */
export function packWorkshopOrigin(value){
  let checked;
  if(value?.schema==='silk-workshop-project')checked=validateWorkshopProject(value);
  else {const session=sessionOf(value);need(completed(session.state),'尚未完成的制作进度不能作为成品来源');checked={session,...finalizeWorkshop(session)};}
  need(checked.design,'尚未完成的制作进度不能作为成品来源');
  return {schema:'silk-workshop-origin',version:1,workshop:checked.session.snapshot(),bridge:clone(checked.bridge)};
}

function designSource(value){
  const source=clone(value);delete source.pose;
  for(const key of ['positions','velocities','pinTargets','grabbed','grabForceN','selfCollision','collisionStats','strainLimitStats'])delete source.model[key];
  for(const c of source.model.constraints)delete c.lambda;
  return source;
}

export function validateWorkshopOrigin(value,currentDesign=null){
  exactEnvelope(value,'silk-workshop-origin',['schema','version','workshop','bridge']);
  const session=restoreWorkshop(value.workshop);need(completed(session.state),'工坊来源缺少完整成品');
  const checked={session,...finalizeWorkshop(session)};
  need(canonical(value.bridge)===canonical(checked.bridge),'工坊来源与可重放制作记录不一致');
  let relation='unbound',matchesOriginalSource=null;
  if(currentDesign!==null){
    const snapshot=typeof currentDesign?.snapshot==='function'?currentDesign.snapshot():currentDesign;
    jsonOnly(snapshot);const current=restoreDesign(snapshot),original=checked.design;
    need(current.id===original.id,'工坊来源属于另一件作品');
    need(current.revision>=original.revision,'当前作品早于保留的制作来源');
    matchesOriginalSource=canonical(designSource(current.snapshot()))===canonical(designSource(original.snapshot()));
    need(matchesOriginalSource||current.revision>original.revision,'同一版本的作品源结构与工坊成品不一致');
    relation=matchesOriginalSource?'original-source':'edited-version';
  }
  return {...checked,origin:clone(value),relation,matchesOriginalSource,lineageVerified:false,authenticity:'source-consistency-only',manufacturing:'unverified'};
}
