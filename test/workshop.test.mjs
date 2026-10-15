import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkshopSession,YARNS,GUIDES,restoreWorkshop,createWorkshopModel,finalizeWorkshop} from '../dist/workshop.mjs';
import {restoreDesign} from '../dist/design-document.mjs';

const act=(s,type,payload={})=>s.dispatch({type,...payload});
function thread(s){act(s,'mount-yarn',{yarnId:YARNS[1].id});for(const guideId of GUIDES)act(s,'thread',{guideId});return s;}
function sampled(s=new WorkshopSession({id:'test-workshop'})){thread(s);act(s,'sample-knit',{courses:8});act(s,'sample-pull',{extension:.3});act(s,'accept-sample');return s;}
function knitted(s=sampled()){act(s,'start-knit');act(s,'knit',{courses:48});return s;}
function sewn(s=knitted()){act(s,'align-toe',{offset:0});act(s,'sew',{amount:1});return s;}
function finished(s=sewn()){act(s,'set-dye',{color:'#765432'});act(s,'dye',{amount:1});act(s,'board');for(const zone of ['cuff','leg','foot'])act(s,'smooth',{zone});act(s,'heat',{amount:1});return s;}
function rejectedAtomically(s,action,pattern){const before=s.snapshot();assert.throws(()=>s.dispatch(action),pattern);assert.deepEqual(s.snapshot(),before);}

test('starts with zero manufactured courses and explicit numerical assumptions',()=>{
  const s=new WorkshopSession({id:'zero'});assert.equal(s.state.stage,'yarn');assert.equal(s.state.production.producedCourses,0);assert.equal(s.state.production.courses.length,0);assert.equal(s.state.recipe.program.cells.length,1920);assert.equal(s.state.assumptions.machineNeedles,400);assert.equal(s.state.validation.physicsValidated,false);assert.throws(()=>{s.state.production.producedCourses=48;});
});
test('guide order is physical source state and bad threading has no side effects',()=>{
  const s=new WorkshopSession({id:'thread'});rejectedAtomically(s,{type:'thread',guideId:GUIDES[0]},/纱筒/);act(s,'mount-yarn',{yarnId:YARNS[0].id});rejectedAtomically(s,{type:'thread',guideId:GUIDES[1]},/顺序/);for(const guideId of GUIDES)act(s,'thread',{guideId});assert.equal(s.state.stage,'sample');
});
test('full sample and an actual pull precede acceptance; old trials survive loop changes',()=>{
  const s=thread(new WorkshopSession({id:'sample'}));act(s,'sample-knit',{courses:4});rejectedAtomically(s,{type:'sample-pull',extension:.3},/完整/);act(s,'sample-knit',{courses:4});rejectedAtomically(s,{type:'accept-sample'},/试拉/);act(s,'sample-pull',{extension:.3});act(s,'accept-sample');assert.equal(s.state.stage,'knit');const first=s.state.sample.trials[0];act(s,'set-loop-length',{mm:3.5});assert.equal(s.state.sample.acceptedId,null);assert.equal(s.state.sample.courses,0);assert.deepEqual(s.state.sample.trials[0],first);
});
test('knitting records actual grouped courses and forbids changing already woven stitches',()=>{
  const s=sampled();act(s,'set-stitch',{row:0,col:3,stitch:'tuck'});rejectedAtomically(s,{type:'knit',courses:1},/启动/);act(s,'start-knit');act(s,'knit',{courses:3});assert.equal(s.state.production.courses[0].cells[3],'tuck');assert.equal(s.state.production.courses[2].row,2);assert.equal(s.state.production.courses[0].sourceEventId,s.state.events.at(-1).id);act(s,'pause-knit');rejectedAtomically(s,{type:'set-stitch',row:0,col:3,stitch:'knit'},/拆/);act(s,'set-stitch',{row:4,col:3,stitch:'miss'});
});
test('dimension and yarn edits require explicit full unravel after production',()=>{
  const s=sampled();act(s,'start-knit');act(s,'knit',{courses:2});act(s,'pause-knit');rejectedAtomically(s,{type:'set-dimension',key:'footLength',value:.26},/拆/);rejectedAtomically(s,{type:'mount-yarn',yarnId:YARNS[0].id},/拆/);act(s,'unravel',{toCourse:0});act(s,'set-dimension',{key:'footLength',value:.26});assert.equal(s.state.recipe.dimensions.footLength,.26);
});
test('unravel invalidates seam, finishing, wearing and permits the unmade row to change',()=>{
  const s=finished();act(s,'dress');act(s,'inspect');act(s,'unravel',{toCourse:10});assert.equal(s.state.stage,'knit');assert.equal(s.state.production.courses.length,10);assert.equal(s.state.seam.closed,false);assert.equal(s.state.finish.set,false);assert.equal(s.state.wear.dressed,false);assert.equal(s.state.wear.inspection,null);act(s,'set-stitch',{row:10,col:0,stitch:'tuck'});rejectedAtomically(s,{type:'set-stitch',row:9,col:0,stitch:'tuck'},/拆/);
});
test('misaligned completed seam remains a visible failed workpiece until unpicked',()=>{
  const s=knitted();act(s,'align-toe',{offset:.6});act(s,'sew',{amount:1});assert.equal(s.state.seam.closed,true);assert.equal(s.state.seam.quality,'misaligned');assert.equal(s.state.stage,'seam');rejectedAtomically(s,{type:'align-toe',offset:0},/拆线/);rejectedAtomically(s,{type:'dye',amount:1},/封尖/);act(s,'unpick');act(s,'align-toe',{offset:0});act(s,'sew',{amount:1});assert.equal(s.state.stage,'finish');
});
test('dye, board, smoothing and heat have ordered prerequisites',()=>{
  const s=sewn();rejectedAtomically(s,{type:'board'},/染/);act(s,'dye',{amount:1});act(s,'board');rejectedAtomically(s,{type:'heat',amount:1},/拉平/);for(const zone of ['cuff','leg','foot'])act(s,'smooth',{zone});act(s,'heat',{amount:.4});assert.equal(s.state.stage,'finish');act(s,'heat',{amount:.6});assert.equal(s.state.stage,'wear');rejectedAtomically(s,{type:'inspect'},/试穿/);act(s,'dress');act(s,'pose',{angle:25});act(s,'inspect');assert.equal(s.state.wear.inspection.passed,true);assert.equal(s.state.wear.inspection.physicsValidated,false);
});
test('redye and unpicking invalidate downstream work without deleting course history',()=>{
  const s=finished();act(s,'dress');act(s,'inspect');act(s,'set-dye',{color:'#112233'});assert.equal(s.state.finish.dyed,false);assert.equal(s.state.finish.boarded,false);assert.equal(s.state.wear.dressed,false);assert.equal(s.state.production.courses.length,48);act(s,'unpick');assert.equal(s.state.stage,'seam');assert.equal(s.state.finish.dyeProgress,0);
});
test('invalid, unknown, infinite and future actions are rejected atomically',()=>{
  const s=new WorkshopSession({id:'invalid'});for(const action of [{type:'next-stage'},{type:'set-loop-length',mm:Infinity},{type:'set-dimension',key:'footLength',value:99},{type:'knit',courses:49},{type:'name',value:''},{type:'pose',angle:NaN},{type:'mount-yarn',yarnId:YARNS[0].id,rogue:true}])rejectedAtomically(s,action);
});
test('canonical manufacturing reference stays natural until explicit dressing',()=>{
  const s=finished(),natural=createWorkshopModel(s);assert.deepEqual([...natural.positions],[...natural.rest]);act(s,'dress');const dressed=createWorkshopModel(s);assert.notDeepEqual([...dressed.positions],[...dressed.rest]);assert.equal(dressed.kind,'stocking');assert.equal(dressed.metadata.toeCap.nodes.length,61);
});

test('an overstretched trial cannot be rescued by reducing the displayed pull',()=>{
  const s=thread(new WorkshopSession({id:'damaged'}));act(s,'sample-knit',{courses:8});act(s,'sample-pull',{extension:1});act(s,'sample-pull',{extension:.2});rejectedAtomically(s,{type:'accept-sample'},/受损/);act(s,'set-loop-length',{mm:3});act(s,'sample-knit',{courses:8});act(s,'sample-pull',{extension:.2});act(s,'accept-sample');assert.equal(s.state.sample.trials.length,2);assert.equal(s.state.sample.trials[0].damaged,true);
});
test('restore replays physical prerequisites and preserves the complete process and history',()=>{
  const s=finished();act(s,'dress');act(s,'pose',{angle:12});act(s,'inspect');act(s,'name',{value:'袜口小花'});const saved=s.snapshot(),restored=restoreWorkshop(JSON.parse(JSON.stringify(saved)));assert.deepEqual(restored.snapshot(),saved);act(restored,'pose',{angle:13});assert.equal(s.state.wear.pose,12);
});
test('restore rejects forged production, stale sources, missing history and promoted validation',()=>{
  const saved=finished().snapshot();for(const change of [x=>{x.production.courses[0].cells[0]='miss';},x=>{x.production.producedCourses=49;},x=>{x.recipe.program.cells[0]='tuck';},x=>{x.events.splice(2,1);},x=>{x.validation.physicsValidated=true;},x=>{x.machineValidated=true;},x=>{x.seam.alignment=.9;},x=>{x.revision++;},x=>{x.events[0].action.rogue=true;},x=>{x.finish.heatProgress=Infinity;}]){const value=structuredClone(saved);change(value);assert.throws(()=>restoreWorkshop(value));}
});
test('restore rejects a forged final stage even if its superficial progress fields agree',()=>{
  const s=new WorkshopSession({id:'fake'}).snapshot();s.stage='wear';s.production.producedCourses=48;s.seam.closed=true;s.seam.quality='aligned';s.finish.set=true;s.wear.dressed=true;s.wear.inspection={passed:true};assert.throws(()=>restoreWorkshop(s));
});
test('unravel and reknit preserve old event identities and create new course identities',()=>{
  const s=knitted(),old=s.state.production.courses[47].id;act(s,'unravel',{toCourse:47});act(s,'set-stitch',{row:47,col:2,stitch:'tuck'});act(s,'start-knit');act(s,'knit',{courses:1});assert.notEqual(s.state.production.courses[47].id,old);assert.equal(s.state.production.courses[47].cells[2],'tuck');assert.equal(s.state.events.filter(e=>e.action.type==='knit').length,2);assert.deepEqual(restoreWorkshop(s.snapshot()).snapshot(),s.snapshot());
});
test('finalize requires an inspected dressed product and reports observable failed courses',()=>{
  assert.throws(()=>finalizeWorkshop(sampled()));const s=finished();assert.throws(()=>finalizeWorkshop(s));act(s,'dress');assert.throws(()=>finalizeWorkshop(s));act(s,'inspect');assert.ok(finalizeWorkshop(s).design);
  const bad=sampled();for(let col=0;col<40;col++)act(bad,'set-stitch',{row:2,col,stitch:'miss'});finished(sewn(knitted(bad)));act(bad,'dress');act(bad,'inspect');assert.equal(bad.state.wear.inspection.passed,false);assert.equal(bad.state.wear.inspection.issues[0].code,'NO_FORMED_LOOPS');assert.throws(()=>finalizeWorkshop(bad));
});
test('bridge deterministically keeps cuff-first program, dimensions, material assumptions and source identities',()=>{
  const s=sampled();act(s,'set-dimension',{key:'footLength',value:.26});act(s,'set-loop-length',{mm:3.2});act(s,'sample-knit',{courses:8});act(s,'sample-pull',{extension:.3});act(s,'accept-sample');act(s,'set-stitch',{row:0,col:3,stitch:'tuck'});act(s,'set-stitch',{row:47,col:8,stitch:'miss'});finished(sewn(knitted(s)));act(s,'dress');act(s,'pose',{angle:15});act(s,'inspect');
  const result=finalizeWorkshop(s),saved=result.design.snapshot(),loaded=restoreDesign(saved);assert.deepEqual(loaded.snapshot(),saved);assert.equal(saved.id,s.state.id);assert.equal(saved.revision,s.state.revision);assert.equal(saved.dimensions.footLength,.26);assert.equal(saved.regions.length,1);const g=saved.regions[0].graph;assert.equal(g.cols,40);assert.equal(g.rows,48);assert.equal(g.cells[47*40+3],'tuck');assert.equal(g.cells[8],'miss');assert.ok(saved.operations.some(o=>o.type==='material'));assert.equal(saved.model.materialLaw,null);
  assert.deepEqual(result.bridge.source,s.snapshot());assert.equal(result.bridge.sourceId,s.state.id);assert.equal(result.bridge.sourceRevision,s.state.revision);assert.equal(result.bridge.courseMap[0].graphRow,47);assert.equal(result.bridge.courseMap[0].sourceEventId,s.state.production.courses[0].sourceEventId);assert.equal(result.bridge.validation.manufacturingValidated,false);assert.equal(result.bridge.nativeProgram,null);assert.match(result.bridge.toeClosure.approximation,/disk|盘/);assert.deepEqual(finalizeWorkshop(s).bridge,result.bridge);
});
test('preview and finished DesignDocument share the same physical rest and organization source',()=>{
  const s=sampled();act(s,'set-stitch',{row:8,col:12,stitch:'tuck'});act(s,'set-loop-length',{mm:3.4});act(s,'sample-knit',{courses:8});act(s,'sample-pull',{extension:.3});act(s,'accept-sample');finished(sewn(knitted(s)));act(s,'dress');act(s,'inspect');const model=createWorkshopModel(s),{design}=finalizeWorkshop(s);assert.deepEqual([...model.rest],[...design.model.rest]);assert.deepEqual(model.constraints.map(({lambda,...c})=>c),design.model.constraints.map(({lambda,...c})=>c));assert.deepEqual([...model.positions],[...design.model.positions]);
});
test('repeated handwheel previews reuse the same compiled source without sharing mutable solver buffers',()=>{
  const s=sampled(new WorkshopSession({id:'cache-source'}));act(s,'set-dimension',{key:'footLength',value:.271});const t0=performance.now(),first=createWorkshopModel(s),cold=performance.now()-t0;act(s,'start-knit');act(s,'knit',{courses:1});const t1=performance.now(),second=createWorkshopModel(s),warm=performance.now()-t1;assert.ok(warm<cold*.5,`warm ${warm} ms should avoid cold source compilation ${cold} ms`);first.positions[0]=999;assert.notEqual(second.positions[0],999);assert.deepEqual([...first.rest],[...second.rest]);assert.equal(second.metadata.designRevision,s.state.revision);
});
test('synthetic recipe changes preserve a real local stiffness difference for tucked loops',()=>{
  const s=sampled();act(s,'set-stitch',{row:8,col:12,stitch:'tuck'});const m=createWorkshopModel(s),graphRow=39,u=.5+(12-19.5)*.9/40,v=.5+(graphRow-23.5)*.9/48,near=m.constraints.filter(c=>c.kind==='weft'&&Math.abs((m.uv[c.a*2]+m.uv[c.b*2])/2-u)<.45/40&&Math.abs((m.uv[c.a*2+1]+m.uv[c.b*2+1])/2-v)<.45/48);assert.ok(near.length);assert.ok(near.some(c=>Math.abs(c.stiffness-YARNS[1].stiffnessFactor*1.6)<1e-10),'the global yarn recipe must not erase tucked-loop local response');
});
test('an already accepted sample cannot rewind the stage of an existing finished stocking',()=>{
  const s=finished();rejectedAtomically(s,{type:'accept-sample'},/已确认|拆/);assert.equal(s.state.stage,'wear');
});
test('small progress increments complete at their declared total despite floating point addition',()=>{
  const s=sewn();for(let i=0;i<10;i++)act(s,'dye',{amount:.1});assert.equal(s.state.finish.dyed,true);act(s,'board');for(const zone of ['cuff','leg','foot'])act(s,'smooth',{zone});for(let i=0;i<10;i++)act(s,'heat',{amount:.1});assert.equal(s.state.finish.set,true);assert.equal(s.state.finish.heatProgress,1);
});

export {act,sampled,knitted,sewn,finished};
