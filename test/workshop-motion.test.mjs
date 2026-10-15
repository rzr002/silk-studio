import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkshopMotion} from '../dist/workshop-motion.mjs';

function state(values={}){const s={id:'motion-piece',revision:1,production:{running:false,producedCourses:0},sample:{courses:0,pull:0},seam:{feed:0,closed:false},finish:{dyeProgress:0,heatProgress:0,dyed:false,set:false},events:[]};for(const [key,value] of Object.entries(values))s[key]=value&&typeof value==='object'&&!Array.isArray(value)?{...s[key],...value}:value;return s;}
function action(s,type,fields={},changes={}){const next=structuredClone(s);next.revision++;next.events.push({id:`${next.id}:event-${next.revision}`,action:{type,...fields}});for(const [key,value] of Object.entries(changes))next[key]=value&&typeof value==='object'&&!Array.isArray(value)?{...next[key],...value}:value;return next;}
function finiteChannels(frame){for(const value of Object.values(frame.channels)){if(Array.isArray(value))assert.ok(value.every(Number.isFinite));else assert.ok(Number.isFinite(value));}}

test('idle and paused sources have no permanent free-running machinery',()=>{
  const m=new WorkshopMotion();m.setState(state(),0);const a=m.sample(0),b=m.sample(10000);assert.equal(a.active,false);assert.equal(b.active,false);assert.equal(b.channels.wheelAngle,0);assert.equal(b.channels.spindleAngle,0);assert.equal(b.channels.knitEnergy,0);assert.equal(b.channels.actionPulse,0);
});
test('running knitting drives continuous wheel, spindle and forty phased needles',()=>{
  const m=new WorkshopMotion();m.setState(state({production:{running:true}}),0);const a=m.sample(50),b=m.sample(100);assert.equal(b.active,true);assert.notEqual(a.channels.wheelAngle,b.channels.wheelAngle);assert.notEqual(a.channels.spindleAngle,b.channels.spindleAngle);assert.equal(b.channels.needleLift.length,40);assert.ok(new Set(b.channels.needleLift.map(x=>x.toFixed(3))).size>10);assert.ok(b.channels.needleLift.every(x=>x>=0&&x<=1));finiteChannels(b);
});
test('pause immediately stops cyclic production and freezes its mechanical pose',()=>{
  const m=new WorkshopMotion(),s=state({production:{running:true}});m.setState(s,0);const before=m.sample(100);m.setState(action(s,'pause-knit',{}, {production:{running:false}}),100);const after=m.sample(5000);assert.equal(after.active,false);assert.equal(after.channels.wheelAngle,before.channels.wheelAngle);assert.equal(after.channels.spindleAngle,before.channels.spindleAngle);assert.deepEqual(after.channels.needleLift,before.channels.needleLift);assert.equal(after.channels.knitEnergy,0);
});
test('manual sample knitting animates real course changes without enabling production',()=>{
  const m=new WorkshopMotion(),s=state();m.setState(s,0);m.setState(action(s,'sample-knit',{courses:1},{sample:{courses:1}}),10);const a=m.sample(80);assert.equal(a.active,true);assert.ok(a.channels.knitEnergy>0);assert.ok(a.channels.wheelAngle>0);assert.ok(a.channels.actionPulse>0);
});
test('manual sample action stops within six hundred milliseconds',()=>{
  const m=new WorkshopMotion(),s=state();m.setState(s,0);m.setState(action(s,'sample-knit',{courses:1},{sample:{courses:1}}),10);m.sample(100);const a=m.sample(610),b=m.sample(900);assert.equal(a.active,false);assert.equal(a.channels.knitEnergy,0);assert.equal(b.channels.wheelAngle,a.channels.wheelAngle);
});
test('repeated snapshots of one event never renew its finite activity tail',()=>{
  const m=new WorkshopMotion(),s=state();m.setState(s,0);const next=action(s,'sample-knit',{courses:1},{sample:{courses:1}});m.setState(next,10);for(const t of [100,200,300,400,500,600])m.setState(structuredClone(next),t);assert.equal(m.sample(650).active,false);
});
test('sewing progress drives the needle and feed wheel with a bounded continuation',()=>{
  const m=new WorkshopMotion(),s=state({production:{producedCourses:48}});m.setState(s,0);m.setState(action(s,'sew',{amount:.1},{seam:{feed:.1}}),10);const a=m.sample(70),b=m.sample(120);assert.ok(a.activity.sew>0);assert.notEqual(a.channels.sewingNeedle,b.channels.sewingNeedle);assert.notEqual(a.channels.sewingWheel,b.channels.sewingWheel);assert.equal(m.sample(810).active,false);
});
test('dye increments make fluid activity while the visible mix reaches its exact final value',()=>{
  const m=new WorkshopMotion(),s=state();m.setState(s,0);m.setState(action(s,'dye',{amount:1},{finish:{dyeProgress:1,dyed:true}}),10);const a=m.sample(80);assert.ok(a.channels.dyeRipple>0);assert.ok(a.channels.dyeMix>0&&a.channels.dyeMix<1);const b=m.sample(810);assert.equal(b.channels.dyeMix,1);assert.equal(b.channels.dyeRipple,0);assert.equal(b.active,false);
});
test('heat and steam remain finite and decay within eight hundred milliseconds of completion',()=>{
  const m=new WorkshopMotion(),s=state();m.setState(s,0);m.setState(action(s,'heat',{amount:1},{finish:{heatProgress:1,set:true}}),10);const a=m.sample(80);assert.ok(a.channels.steam>0);assert.ok(a.channels.heatGlow>0);finiteChannels(a);const b=m.sample(810);assert.equal(b.channels.steam,0);assert.equal(b.channels.heatGlow,0);assert.equal(b.active,false);
});
test('sample extension moves continuously toward source and settles without an endless idle loop',()=>{
  const m=new WorkshopMotion(),s=state();m.setState(s,0);const pulled=action(s,'sample-pull',{extension:.4},{sample:{pull:.4}});m.setState(pulled,10);const a=m.sample(80);assert.ok(a.channels.sampleExtension>0&&a.channels.sampleExtension<.4);const b=m.sample(810);assert.equal(b.channels.sampleExtension,.4);assert.equal(b.active,false);m.setState(action(pulled,'sample-pull',{extension:.1},{sample:{pull:.1}}),820);assert.equal(m.sample(1140).channels.sampleExtension,.1);
});
test('reduced motion shows final source values without starting cyclic or transient animation',()=>{
  const m=new WorkshopMotion({reducedMotion:true});m.setState(state(),0);m.setState(state({revision:2,production:{running:true},sample:{pull:.4},finish:{dyeProgress:1,heatProgress:1}}),10);const a=m.sample(5000);assert.equal(a.active,false);assert.equal(a.reducedMotion,true);assert.equal(a.channels.wheelAngle,0);assert.equal(a.channels.sewingNeedle,0);assert.equal(a.channels.steam,0);assert.equal(a.channels.dyeMix,1);assert.equal(a.channels.sampleExtension,.4);assert.ok(a.channels.needleLift.every(x=>x===0));
  m.setReducedMotion(false,5000);assert.equal(m.sample(5050).active,true);assert.ok(m.sample(5050).channels.wheelAngle>0);m.setReducedMotion(true,5050);const b=m.sample(9000);assert.equal(b.active,false);assert.equal(b.channels.wheelAngle,m.sample(10000).channels.wheelAngle);assert.throws(()=>m.setReducedMotion('false',10000));
});
test('tab restore clamps cyclic integration but expires old action tails in real time',()=>{
  const m=new WorkshopMotion();m.setState(state({production:{running:true}}),0);const a=m.sample(60000);assert.ok(a.channels.wheelAngle<=1);assert.equal(a.time.dtMs,100);assert.equal(a.time.clamped,true);const p=new WorkshopMotion(),s=state();p.setState(s,0);p.setState(action(s,'sew',{amount:.1},{seam:{feed:.1}}),10);assert.equal(p.sample(60000).active,false);
});
test('backwards time cannot reverse machinery or create nonfinite values',()=>{
  const m=new WorkshopMotion();m.setState(state({production:{running:true}}),100);const a=m.sample(200),b=m.sample(50);assert.equal(b.channels.wheelAngle,a.channels.wheelAngle);assert.equal(b.channels.spindleAngle,a.channels.spindleAngle);finiteChannels(b);
});
test('opening a different source cancels previous actions instead of replaying its history',()=>{
  const m=new WorkshopMotion(),s=state();m.setState(s,0);m.setState(action(s,'heat',{amount:.1},{finish:{heatProgress:.1}}),10);assert.ok(m.sample(60).channels.steam>0);m.setState(state({id:'another-piece'}),60);const a=m.sample(100);assert.equal(a.active,false);assert.equal(a.channels.steam,0);assert.equal(a.channels.wheelAngle,0);
});
test('unravelling cancels downstream sewing dye and heat activity',()=>{
  const m=new WorkshopMotion(),s=state({production:{producedCourses:48},seam:{feed:.8},finish:{dyeProgress:.6,heatProgress:.5}});m.setState(s,0);const doing=action(s,'heat',{amount:.1},{finish:{heatProgress:.6}});m.setState(doing,10);m.sample(40);m.setState(action(doing,'unravel',{toCourse:8},{production:{producedCourses:8,running:false},seam:{feed:0},finish:{dyeProgress:0,heatProgress:0}}),50);const a=m.sample(100);assert.equal(a.channels.steam,0);assert.equal(a.channels.heatGlow,0);assert.equal(a.channels.sewingNeedle,0);assert.equal(a.channels.dyeRipple,0);assert.equal(m.sample(900).active,false);
});
test('a genuinely new pull event is visible even if its final extension is unchanged',()=>{
  const m=new WorkshopMotion(),s=state();m.setState(s,0);const first=action(s,'sample-pull',{extension:.3},{sample:{pull:.3}});m.setState(first,10);m.sample(900);const second=action(first,'sample-pull',{extension:.3});m.setState(second,910);assert.ok(m.sample(920).channels.actionPulse>0);m.setState(structuredClone(second),1500);assert.equal(m.sample(1710).active,false);
});
test('state observations are copied and never mutate source or depend on later external mutations',()=>{
  const m=new WorkshopMotion(),s=state({production:{running:true}}),before=structuredClone(s);m.setState(s,0);m.sample(50);assert.deepEqual(s,before);s.production.running=false;assert.equal(m.sample(100).active,true);
});
test('returned channel arrays cannot corrupt later samples; invalid time is refused without advancing',()=>{
  const m=new WorkshopMotion();m.setState(state({production:{running:true}}),0);const a=m.sample(50);a.channels.needleLift[0]=999;assert.notEqual(m.sample(50).channels.needleLift[0],999);assert.throws(()=>m.sample(Infinity));assert.throws(()=>m.setState(state(),NaN));finiteChannels(m.sample(60));
});
test('sampling and setting the same state at the same timestamp are idempotent',()=>{
  const m=new WorkshopMotion(),s=state({production:{running:true}});m.setState(s,0);const a=m.sample(100);assert.deepEqual(m.sample(100),a);m.setState(structuredClone(s),100);assert.deepEqual(m.sample(100),a);
});
test('initial loaded progress is displayed statically without replaying old completion events',()=>{
  const m=new WorkshopMotion(),s=state({production:{producedCourses:48},seam:{feed:1,closed:true},sample:{pull:.3},finish:{dyeProgress:1,heatProgress:1,dyed:true,set:true},events:[{id:'old-heat',action:{type:'heat',amount:1}}]});m.setState(s,1000);const a=m.sample(1000);assert.equal(a.active,false);assert.equal(a.channels.dyeMix,1);assert.equal(a.channels.sampleExtension,.3);assert.equal(a.channels.steam,0);
});
