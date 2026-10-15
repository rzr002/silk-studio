/** Kinematic presentation driven by immutable workshop observations. This does
 * not simulate needle/yarn mechanics or assert real factory processing times.
 * Angles: radians. Other channels: normalized [0,1]. Time: performance.now ms.
 * Actual time expires finite actions; cyclic integration clamps tab gaps to
 * 100 ms, so a resumed tab never catches up minutes of machinery in one frame.
 */
const TAU=Math.PI*2,MAX_DT=100,TWEEN_MS=320;
const DURATION={knit:600,sew:720,dye:720,heat:750,sample:600,action:400};
const PRESENTATION_ACTIONS=new Set(['mount-yarn','thread','set-loop-length','set-stitch','sample-knit','sample-pull','knit','align-toe','sew','dye','board','smooth','heat','dress','inspect']);
const bounded=x=>Math.min(1,Math.max(0,x));
const smooth=x=>{x=bounded(x);return x*x*(3-2*x);};
const wrap=x=>((x%TAU)+TAU)%TAU;
function validTime(t){if(!Number.isFinite(t)||t<0||t>Number.MAX_SAFE_INTEGER)throw new RangeError('Animation time must be finite nonnegative milliseconds');return t;}
function number(x,defaultValue=0){if(x===undefined)return defaultValue;if(!Number.isFinite(x))throw new TypeError('Animation source contains a nonfinite value');return x;}
function observation(state){
  if(!state||typeof state!=='object')throw new TypeError('Workshop state is required');
  const events=Array.isArray(state.events)?state.events:[];
  return {id:state.id??'anonymous',revision:number(state.revision),running:state.production?.running===true,
    courses:number(state.production?.producedCourses),sampleCourses:number(state.sample?.courses),pull:bounded(number(state.sample?.pull)),
    seam:bounded(number(state.seam?.feed)),dye:bounded(number(state.finish?.dyeProgress)),heat:bounded(number(state.finish?.heatProgress)),
    eventCount:events.length,lastEventId:events.at(-1)?.id??null};
}
const tween=(value,time)=>({from:value,target:value,start:time});
function tweenValue(t,time){if(time>=t.start+TWEEN_MS)return t.target;return t.from+(t.target-t.from)*smooth((time-t.start)/TWEEN_MS);}

export class WorkshopMotion {
  #reduced;#source=null;#now=null;#time={timeMs:0,dtMs:0,rawDtMs:0,clamped:false};
  #tails=Object.fromEntries(Object.keys(DURATION).map(key=>[key,-Infinity]));
  #wheel=0;#spindle=0;#sewing=0;#dyePhase=0;#heatPhase=0;#needles=Array(40).fill(0);#manualDrive=false;
  #mix=tween(0,0);#extension=tween(0,0);

  constructor({reducedMotion=false}={}){if(typeof reducedMotion!=='boolean')throw new TypeError('reducedMotion must be boolean');this.#reduced=reducedMotion;}
  #weight(kind,time=this.#now??0){if(this.#reduced)return 0;const age=time-this.#tails[kind];return age>=0&&age<DURATION[kind]?1-smooth(age/DURATION[kind]):0;}
  #activity(time=this.#now??0){return {knit:this.#reduced?0:this.#source?.running?1:this.#weight('knit',time),sew:this.#weight('sew',time),dye:this.#weight('dye',time),heat:this.#weight('heat',time),sample:this.#weight('sample',time)};}
  #cancel(){for(const key of Object.keys(this.#tails))this.#tails[key]=-Infinity;this.#manualDrive=false;}
  #touch(kind){if(!this.#reduced)this.#tails[kind]=this.#now;}
  #target(name,value,direct=false){const field=name==='mix'?this.#mix:this.#extension;if(direct){field.from=field.target=value;field.start=this.#now;return;}if(field.target===value)return;field.from=tweenValue(field,this.#now);field.target=value;field.start=this.#now;}
  #advance(timeMs){
    validTime(timeMs);
    if(this.#now===null){this.#now=timeMs;this.#time={timeMs,dtMs:0,rawDtMs:0,clamped:false};return;}
    if(timeMs<=this.#now)return;
    const rawDtMs=timeMs-this.#now,dtMs=Math.min(MAX_DT,rawDtMs),dt=dtMs/1000,activity=this.#activity(timeMs);
    if(activity.knit>0){
      this.#wheel=wrap(this.#wheel+6.2*dt*activity.knit);this.#spindle=wrap(this.#spindle+13*dt*activity.knit);
      this.#needles=this.#needles.map((_,i)=>Math.max(0,Math.sin(this.#wheel*3-i*TAU/40))*activity.knit);
    }else if(this.#manualDrive){this.#needles.fill(0);this.#manualDrive=false;}
    if(activity.sew>0)this.#sewing=wrap(this.#sewing+11*dt*activity.sew);
    if(activity.dye>0)this.#dyePhase=wrap(this.#dyePhase+7*dt*activity.dye);
    if(activity.heat>0)this.#heatPhase=wrap(this.#heatPhase+9*dt*activity.heat);
    this.#now=timeMs;this.#time={timeMs,dtMs,rawDtMs,clamped:rawDtMs>MAX_DT};
  }

  setReducedMotion(value,timeMs){
    if(typeof value!=='boolean')throw new TypeError('reducedMotion must be boolean');this.#advance(timeMs);
    const changed=this.#reduced!==value;this.#reduced=value;
    if(changed){this.#cancel();this.#target('mix',this.#source?.dye??0,true);this.#target('extension',this.#source?.pull??0,true);if(value)this.#needles.fill(0);}
    return {changed,reducedMotion:this.#reduced};
  }

  setState(state,timeMs){
    validTime(timeMs);const next=observation(state),previous=this.#source;this.#advance(timeMs);
    const different=previous&&next.id!==previous.id,rewound=previous&&(next.revision<previous.revision||next.eventCount<previous.eventCount);
    if(!previous||different||rewound){
      this.#cancel();this.#source=next;this.#target('mix',next.dye,true);this.#target('extension',next.pull,true);
      if(different||rewound){this.#wheel=this.#spindle=this.#sewing=this.#dyePhase=this.#heatPhase=0;this.#needles.fill(0);}
      return {changed:true,activity:this.#activity()};
    }
    const changed=Object.keys(next).some(k=>next[k]!==previous[k]);
    const rollback=next.courses<previous.courses||next.sampleCourses<previous.sampleCourses||next.seam<previous.seam||next.dye<previous.dye||next.heat<previous.heat;
    if(rollback)this.#cancel();
    if(previous.running&&!next.running){this.#tails.knit=-Infinity;this.#manualDrive=false;}
    const events=Array.isArray(state.events)?state.events:[];
    let start=previous.eventCount;
    if(previous.lastEventId&&events[start-1]?.id!==previous.lastEventId){const found=events.findLastIndex(e=>e.id===previous.lastEventId);start=found<0?events.length:found+1;}
    let manual=false,sew=false,dye=false,heat=false,pull=false,pulse=false;
    for(let i=start;i<events.length;i++){
      const a=events[i]?.action;if(!a)continue;
      manual ||= a.type==='sample-knit'&&a.courses>0;
      sew ||= a.type==='sew'&&a.amount>0;dye ||= a.type==='dye'&&a.amount>0;heat ||= a.type==='heat'&&a.amount>0;pull ||= a.type==='sample-pull';
      pulse ||= PRESENTATION_ACTIONS.has(a.type);
    }
    manual ||= next.sampleCourses>previous.sampleCourses;
    sew ||= next.seam>previous.seam;dye ||= next.dye>previous.dye;heat ||= next.heat>previous.heat;pull ||= next.pull!==previous.pull;
    if(manual){this.#touch('knit');this.#touch('sample');this.#manualDrive=!this.#reduced;}
    if(sew)this.#touch('sew');if(dye)this.#touch('dye');if(heat)this.#touch('heat');if(pull)this.#touch('sample');
    if(pulse||manual||sew||dye||heat||pull)this.#touch('action');
    this.#source=next;this.#target('mix',next.dye,this.#reduced);this.#target('extension',next.pull,this.#reduced);
    return {changed,activity:this.#activity()};
  }

  sample(timeMs){
    this.#advance(timeMs);const activity=this.#activity(),now=this.#now,actionPulse=this.#weight('action');
    const mix=this.#reduced?this.#mix.target:tweenValue(this.#mix,now),extension=this.#reduced?this.#extension.target:tweenValue(this.#extension,now);
    const interpolating=!this.#reduced&&[this.#mix,this.#extension].some(t=>t.target!==t.from&&now<t.start+TWEEN_MS);
    return {active:!this.#reduced&&(Object.values(activity).some(x=>x>0)||actionPulse>0||interpolating),reducedMotion:this.#reduced,
      channels:{wheelAngle:this.#wheel,spindleAngle:this.#spindle,feedPhase:this.#wheel/TAU,needleLift:[...this.#needles],knitEnergy:activity.knit,
        sewingNeedle:activity.sew*(.5+.5*Math.sin(this.#sewing*4)),sewingWheel:this.#sewing,
        dyeRipple:activity.dye*(.65+.35*Math.sin(this.#dyePhase)),dyeMix:mix,
        steam:activity.heat*(.75+.25*Math.sin(this.#heatPhase)),heatGlow:activity.heat,sampleExtension:extension,actionPulse},
      activity,time:{...this.#time},progress:{courses:this.#source?.courses??0,sampleCourses:this.#source?.sampleCourses??0,seam:this.#source?.seam??0,dye:this.#source?.dye??0,heat:this.#source?.heat??0}};
  }
}
