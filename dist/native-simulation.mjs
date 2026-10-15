import {restoreModel} from './physics.mjs';
import {bodyGeometryData,normalizeDimensions,DEFAULT_BODY_DIMENSIONS} from './garment-geometry.mjs';

const clone=x=>JSON.parse(JSON.stringify(x));
const finiteArray=(x,n)=>Array.isArray(x)&&x.length===n&&x.every(Number.isFinite);
const validEpoch=x=>Number.isSafeInteger(x)&&x>=0;
const refusalMessages={'unsupported-body-motion':'本地参考模式暂只支持静态人台；此步未提交。','nonconverged':'本地求解未收敛，作品、姿态和仿真时间保持原状态。','initial-intersection':'当前衣物已经与人台相交；请先重新贴合，此步未提交。','initial-clearance':'当前几何间隙不足；请先以数值余量重新贴合，此步未提交。','strain-limit-exceeded':'求解结果超过数值伸长限制，此步未提交。','substep-path':'完整时间步的接触路径未通过检查，此步未提交。'};

/** Worker-shaped, stateless native transport. Only accepted results update state.
 * Abort stops waiting; a server may finish an already running native request. */
export class NativeSimulationController {
  constructor({endpoint='/api/reference-step',fetchImpl=globalThis.fetch?.bind(globalThis)}={}){this.endpoint=endpoint;this.fetchImpl=fetchImpl;this.epoch=-1;this.snapshot=null;this.context=null;this.baseStateId=0;this.requestSequence=0;this.pending=null;this.onmessage=null;this.onerror=null;}
  emit(data){this.onmessage?.({data});}
  terminate(){this.pending?.abort.abort();this.pending=null;this.epoch=-1;this.snapshot=null;}
  async postMessage(message){
    if(message?.type==='sync'){
      try{
        if(!validEpoch(message.epoch)||message.epoch<this.epoch)throw new Error('过期或无效 simulation epoch');
        const model=restoreModel(message.snapshot),pose=message.pose??0;
        if(!Number.isFinite(pose)||pose<0||pose>55)throw new Error('同步姿态必须为 0–55°');
        const dimensions=normalizeDimensions(message.bodyDimensions===undefined?DEFAULT_BODY_DIMENSIONS:message.bodyDimensions,DEFAULT_BODY_DIMENSIONS);
        if(message.designRevision!==undefined&&!validEpoch(message.designRevision))throw new Error('无效作品版本');
        this.pending?.abort.abort();this.pending=null;this.snapshot=model.snapshot();this.epoch=message.epoch;this.context={pose,bodyDimensions:dimensions};this.designId=message.designId??null;this.designRevision=message.designRevision??0;this.baseStateId=0;
      }catch(e){this.emit({type:'error',epoch:message.epoch,message:e.message});}return;
    }
    let pending;
    try{
      if(message?.type!=='step'||!this.snapshot||message.epoch!==this.epoch)throw new Error('过期或尚未同步的 native step');
      if(this.pending)throw new Error('已有在途计算，不能重复推进物理时间');
      if(!Number.isFinite(message.pose)||message.pose<0||message.pose>55||!Number.isFinite(message.dt)||message.dt<=0||message.dt>1/30)throw new Error('native step 姿态或固定 dt 无效');
      const bodyDimensions=normalizeDimensions(message.bodyDimensions===undefined?this.context.bodyDimensions:message.bodyDimensions,DEFAULT_BODY_DIMENSIONS),step={...clone(message),bodyDimensions};
      const body0=this.snapshot.kind==='stocking'?bodyGeometryData({pose:this.context.pose,dimensions:this.context.bodyDimensions}):null,body1=body0?bodyGeometryData({pose:step.pose,dimensions:bodyDimensions}):null;
      const bodyReference=body0?bodyGeometryData({pose:0,dimensions:this.context.bodyDimensions}):null;
      const payload={version:1,epoch:this.epoch,requestId:++this.requestSequence,designId:this.designId,designRevision:this.designRevision,baseStateId:this.baseStateId,snapshot:clone(this.snapshot),context:clone(this.context),step,body:body0?{referencePositions:[...bodyReference.positions],previousPositions:[...body0.positions],targetPositions:[...body1.positions],triangles:[...body0.indices]}:null};
      pending={epoch:this.epoch,requestId:payload.requestId,abort:new AbortController()};this.pending=pending;
      const response=await this.fetchImpl(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:pending.abort.signal});
      const result=await response.json();if(this.pending!==pending||this.epoch!==pending.epoch)return;
      if(!response.ok)throw new Error(result.message||`本地参考计算 HTTP ${response.status}`);
      if(result.version!==1||result.epoch!==payload.epoch||result.requestId!==payload.requestId||result.designRevision!==payload.designRevision||result.baseStateId!==payload.baseStateId)throw new Error('本地计算返回了不匹配的作品或步进身份');
      if(result.committed!==true){const error=new Error(refusalMessages[result.status]||result.message||result.diagnostics?.message||'本地参考计算未接受此步，作品保持原状态');error.status=result.status;error.detail=result.message;throw error;}
      if(result.converged!==true||result.diagnostics?.collisionFree!==true||!Number.isFinite(result.advancedTime)||Math.abs(result.advancedTime-step.dt)>1e-12)throw new Error('本地参考计算未提供收敛且通过连续接触检查的完整时间步');
      if(body0&&result.diagnostics.bodyTargetReached!==true)throw new Error('本地计算尚未完成完整人台目标，此步未提交。');
      const n=this.snapshot.positions.length,c=this.snapshot.constraints.length;
      if(!finiteArray(result.positions,n)||!finiteArray(result.velocities,n)||result.lambdas!==undefined&&!finiteArray(result.lambdas,c))throw new Error('本地计算的位置、速度或约束数据无效');
      if(!Number.isFinite(result.pose)||Math.abs(result.pose-step.pose)>1e-10||!Number.isFinite(result.ms)||result.ms<0)throw new Error('本地计算未完成目标姿态，或耗时无效');
      // Prepare every owned field before one atomic commit. No automatic retry.
      const next=clone(this.snapshot);next.positions=[...result.positions];next.velocities=[...result.velocities];if(result.lambdas)next.constraints.forEach((constraint,i)=>constraint.lambda=result.lambdas[i]);next.grabbed=clone(step.grabbed??null);next.grabForceN=Number.isFinite(result.grabForceN)?result.grabForceN:0;next.collisionStats={...clone(result.collisionStats||{}),reference:{designId:payload.designId,designRevision:payload.designRevision,baseStateId:payload.baseStateId,acceptedPose:result.pose,advancedTime:result.advancedTime,converged:true,runtime:clone(result.runtime||{}),diagnostics:clone(result.diagnostics)}};
      this.snapshot=next;this.context={pose:result.pose,bodyDimensions:clone(bodyDimensions)};this.baseStateId++;this.pending=null;
      this.emit({...result,type:'result',collisionStats:clone(next.collisionStats),positions:Float64Array.from(result.positions),velocities:Float64Array.from(result.velocities),lambdas:Float64Array.from(result.lambdas||next.constraints.map(c=>c.lambda))});
    }catch(e){if(pending&&(this.pending!==pending||this.epoch!==pending.epoch))return;if(pending)this.pending=null;this.emit({type:'error',epoch:message?.epoch,message:e.message||String(e),status:e.status,detail:e.detail});}
  }
}
