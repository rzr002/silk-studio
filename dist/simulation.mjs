import {restoreModel} from './physics.mjs';
import {bodyProjection,getBodyCollisionMesh} from './contact.mjs';
import {normalizeDimensions,DEFAULT_BODY_DIMENSIONS} from './garment-geometry.mjs';

export const SOLVER_QUALITY=Object.freeze({fast:Object.freeze({iterations:4,substeps:2}),standard:Object.freeze({iterations:6,substeps:3}),reference:Object.freeze({iterations:12,substeps:6})});
const clone=x=>JSON.parse(JSON.stringify(x));
const checkEpoch=value=>{if(!Number.isSafeInteger(value)||value<0)throw new Error('无效 simulation epoch');return value;};

/** One request advances one fixed step. No animation clock, backlog or retries.
 * State returned for transfer is copied; the owned model is never detached. */
export class SimulationEngine {
  constructor(){this.model=null;this.epoch=-1;this.pose=0;this.bodyHistory=null;this.bodyDimensions=null;this.bodyRevision=0;}
  sync(snapshot,epoch,context=undefined){
    checkEpoch(epoch);if(epoch<this.epoch)throw new Error('过期 simulation epoch');
    if(context!=null&&(typeof context!=='object'||Array.isArray(context)))throw new Error('无效 body context');
    const hasContext=context&&(Object.hasOwn(context,'pose')||Object.hasOwn(context,'bodyDimensions'));
    const next=restoreModel(snapshot);let pose=0,dimensions=null,bodyHistory=null;
    if(hasContext){
      pose=context.pose;if(!Number.isFinite(pose)||pose<0||pose>55)throw new Error('同步 body pose 必须为 0–55°');
      dimensions=normalizeDimensions(context.bodyDimensions===undefined?DEFAULT_BODY_DIMENSIONS:context.bodyDimensions,DEFAULT_BODY_DIMENSIONS);
      if(next.kind==='stocking')bodyHistory=Float64Array.from(getBodyCollisionMesh({pose,dimensions}).positions);
    }
    this.model=next;this.epoch=epoch;this.pose=pose;this.bodyHistory=bodyHistory;this.bodyDimensions=dimensions;this.bodyRevision=0;
    return {epoch,vertices:next.positions.length/3};
  }
  step({epoch,pose=0,bodyDimensions=DEFAULT_BODY_DIMENSIONS,gravity=true,collider=true,selfCollision=true,continuousCollision=true,quality='standard',grabbed=null,dt=1/60}={}){
    checkEpoch(epoch);if(!this.model||epoch!==this.epoch)throw new Error('过期或尚未同步的 simulation epoch');
    if(!Number.isFinite(pose)||pose<0||pose>55)throw new Error('姿态必须为 0–55°');
    if(!Number.isFinite(dt)||dt<=0||dt>1/30)throw new Error('固定 dt 必须在 0–1/30 秒内');
    if(typeof quality!=='string'||!Object.hasOwn(SOLVER_QUALITY,quality))throw new Error('未知求解质量');
    if(![gravity,collider,selfCollision,continuousCollision].every(x=>typeof x==='boolean'))throw new Error('物理开关必须为布尔值');
    const dimensions=normalizeDimensions(bodyDimensions,DEFAULT_BODY_DIMENSIONS),m=this.model;
    if(grabbed!==null&&(!grabbed||!Number.isInteger(grabbed.index)||!m.active[grabbed.index]||!Array.isArray(grabbed.target)||grabbed.target.length!==3||!grabbed.target.every(Number.isFinite)))throw new Error('抓取点无效');
    const start=performance.now(),isStocking=m.kind==='stocking',bodyOptions={pose,dimensions};
    // Contact's process-wide cache supplies current geometry only. Previous
    // geometry is owned by this engine and is reset at every sync boundary.
    const bodyMesh=isStocking?getBodyCollisionMesh(bodyOptions):null;
    const bodyChanged=!!bodyMesh&&(!this.bodyHistory||this.pose!==pose||!this.bodyDimensions||Object.keys(DEFAULT_BODY_DIMENSIONS).some(key=>this.bodyDimensions[key]!==dimensions[key]));
    const bodyRevision=this.bodyRevision+Number(bodyChanged);
    const mesh=collider&&bodyMesh?{...bodyMesh,revision:bodyRevision,previousPositions:Float64Array.from(this.bodyHistory||bodyMesh.positions)}:null;
    const project=(x,y,z)=>{
      if(y<.015)return [x,.015,z];
      if(!collider)return null;
      if(isStocking)return bodyProjection(x,y,z,bodyOptions);
      if(m.kind==='patch'){const dx=x,dy=y-.49,dz=z+.10,length=Math.hypot(dx,dy,dz),radius=.139;if(length<radius)return [dx*radius/(length||1),.49+dy*radius/(length||1),-.10+dz*radius/(length||1)];}
      return null;
    };
    if(grabbed===null)m.release();else if(m.grabbed?.index===grabbed.index)m.moveGrab(grabbed.target);else {m.release();m.grab(grabbed.index,grabbed.target);}
    m.step(dt,{...SOLVER_QUALITY[quality],gravity:gravity?[0,-9.81,0]:[0,0,0],collider:project,selfCollision,continuousCollision,collisionMesh:mesh});
    this.pose=pose;if(bodyMesh){this.bodyHistory=Float64Array.from(bodyMesh.positions);this.bodyDimensions=clone(dimensions);this.bodyRevision=bodyRevision;}
    return {epoch,pose,positions:Float64Array.from(m.positions),velocities:Float64Array.from(m.velocities),lambdas:Float64Array.from(m.constraints,c=>c.lambda),grabForceN:m.grabForceN,collisionStats:clone(m.collisionStats),ms:performance.now()-start};
  }
}
