import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkshopSession,YARNS,GUIDES} from '../dist/workshop.mjs';
import {restoreDesign} from '../dist/design-document.mjs';
import {packWorkshopProject,validateWorkshopProject,restoreWorkshopProject,packWorkshopOrigin,validateWorkshopOrigin,packWorkshopResume,restoreWorkshopResume} from '../dist/workshop-project.mjs';

const act=(s,type,payload={})=>s.dispatch({type,...payload});
function progress(id='project-progress'){const s=new WorkshopSession({id});act(s,'mount-yarn',{yarnId:YARNS[1].id});for(const guideId of GUIDES)act(s,'thread',{guideId});act(s,'sample-knit',{courses:8});act(s,'sample-pull',{extension:.3});act(s,'accept-sample');act(s,'start-knit');act(s,'knit',{courses:3});return s;}
function complete(id='project-finished'){const s=progress(id);act(s,'knit',{courses:45});act(s,'align-toe',{offset:0});act(s,'sew',{amount:1});act(s,'dye',{amount:1});act(s,'board');for(const zone of ['cuff','leg','foot'])act(s,'smooth',{zone});act(s,'heat',{amount:1});act(s,'dress');act(s,'inspect');return s;}
function reorder(value){if(Array.isArray(value))return value.map(reorder);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)]));return value;}

test('progress packaging is pure and does not invent a finished design',()=>{
  const s=progress(),before=s.snapshot(),value=packWorkshopProject(s);assert.equal(value.schema,'silk-workshop-project');assert.equal(value.version,1);assert.equal(value.design,null);assert.equal(value.bridge,null);assert.deepEqual(value.workshop,before);assert.deepEqual(s.snapshot(),before);value.workshop.name='changed';assert.notEqual(s.state.name,'changed');
});
test('validation preserves running history; restore records exactly one legal pause event',()=>{
  const s=progress(),value=packWorkshopProject(s),before=structuredClone(value),checked=validateWorkshopProject(value);assert.equal(checked.session.state.production.running,true);assert.deepEqual(value,before);
  const result=restoreWorkshopProject(value);assert.equal(result.pausedOnRestore,true);assert.equal(result.session.state.production.running,false);assert.equal(result.session.state.revision,s.state.revision+1);assert.equal(result.session.state.events.at(-1).action.type,'pause-knit');assert.equal(result.session.state.production.producedCourses,3);assert.deepEqual(result.project.workshop,result.session.snapshot());assert.deepEqual(value,before);
  const again=restoreWorkshopProject(result.project);assert.equal(again.pausedOnRestore,false);assert.deepEqual(again.project,result.project);
});
test('a finished project carries reproducible legacy design and complete processing origin',()=>{
  const s=complete(),value=packWorkshopProject(s),checked=validateWorkshopProject(value),restored=restoreWorkshopProject(value);assert.deepEqual(checked.design.snapshot(),value.design);assert.deepEqual(restoreDesign(value.design).snapshot(),value.design);assert.deepEqual(value.bridge.source,s.snapshot());assert.equal(restored.pausedOnRestore,false);assert.deepEqual(restored.project,value);assert.equal(value.bridge.validation.manufacturingValidated,false);
});
test('key order is immaterial while typed arrays and non-JSON extras are refused',()=>{
  const value=packWorkshopProject(progress());assert.deepEqual(restoreWorkshopProject(reorder(value)).project,restoreWorkshopProject(value).project);const typed=structuredClone(value);typed.workshop.recipe.program.cells=new Uint8Array(1920);assert.throws(()=>validateWorkshopProject(typed));const bad=structuredClone(value);bad.workshop.extra=undefined;assert.throws(()=>validateWorkshopProject(bad));
});
test('envelope versions, unknown fields, missing fields and incomplete final pairs are refused',()=>{
  const base=packWorkshopProject(progress());for(const change of [x=>{x.version=2;},x=>{x.schema='silk-design-workbench';},x=>{x.machineValidated=true;},x=>{delete x.bridge;},x=>{x.bridge={};},x=>{x.design={};}]){const value=structuredClone(base);change(value);assert.throws(()=>validateWorkshopProject(value));}
});
test('production, source bridge and final geometry cannot be independently rewritten',()=>{
  const base=packWorkshopProject(complete());for(const change of [x=>{x.workshop.production.courses[0].cells[0]='tuck';},x=>{x.bridge.sourceId='other';},x=>{x.bridge.source.recipe.dimensions.footLength=.26;},x=>{x.bridge.courseMap[0].graphRow=0;},x=>{x.bridge.validation.physicsValidated=true;},x=>{x.design.model.positions[0]+=.01;},x=>{x.design.regions[0].graph.cells[0]='tuck';},x=>{x.design.model.metadata.designId='other';},x=>{x.design=null;x.bridge=null;}]){const value=structuredClone(base);change(value);const before=structuredClone(value);assert.throws(()=>validateWorkshopProject(value));assert.deepEqual(value,before);}
});
test('a valid final pair from another workshop cannot be substituted behind unchanged progress',()=>{
  const a=packWorkshopProject(complete('project-a')),b=packWorkshopProject(complete('project-b'));a.design=b.design;a.bridge=b.bridge;assert.throws(()=>validateWorkshopProject(a));
});
test('unfinished workshops cannot be transferred as completed origins',()=>{
  assert.throws(()=>packWorkshopOrigin(progress()));assert.throws(()=>packWorkshopOrigin(packWorkshopProject(progress())));
});
test('lab origin is a portable outer envelope and preserves the original DesignDocument schema',()=>{
  const s=complete(),project=packWorkshopProject(s),origin=packWorkshopOrigin(project),checked=validateWorkshopOrigin(origin,project.design);assert.equal(origin.schema,'silk-workshop-origin');assert.equal(checked.relation,'original-source');assert.equal(checked.matchesOriginalSource,true);assert.equal(checked.lineageVerified,false);assert.equal(checked.design.snapshot().schema,'silk-design-document');assert.equal(checked.design.snapshot().workshopOrigin,undefined);const copied=JSON.parse(JSON.stringify({format:'silk-design-workbench',version:2,design:project.design,workshopOrigin:origin}));assert.deepEqual(validateWorkshopOrigin(copied.workshopOrigin,copied.design).bridge.source,s.snapshot());
});
test('lab simulation can change dynamic state without invalidating the retained creation source',()=>{
  const project=packWorkshopProject(complete()),origin=packWorkshopOrigin(project),before=structuredClone(origin),design=restoreDesign(project.design);design.model.positions[0]+=.0002;design.model.velocities[1]=.04;design.model.constraints[0].lambda=.2;design.pose=4;assert.equal(validateWorkshopOrigin(origin,design.snapshot()).relation,'original-source');assert.deepEqual(origin,before);
});
test('later lab edits preserve historical origin but do not gain an asserted causal lineage',()=>{
  const project=packWorkshopProject(complete()),origin=packWorkshopOrigin(project),design=restoreDesign(project.design);design.applyOperation({type:'material',bounds:{u0:.1,u1:.3,v0:.4,v1:.6},parameters:{weft:2}});const checked=validateWorkshopOrigin(origin,design.snapshot());assert.equal(checked.relation,'edited-version');assert.equal(checked.matchesOriginalSource,false);assert.equal(checked.lineageVerified,false);assert.equal(checked.bridge.sourceRevision,origin.workshop.revision);
});
test('unrelated, rewound and same-revision substituted lab source cannot inherit an origin',()=>{
  const project=packWorkshopProject(complete()),origin=packWorkshopOrigin(project),other=packWorkshopProject(complete('other-lab'));assert.throws(()=>validateWorkshopOrigin(origin,other.design));const design=restoreDesign(project.design);design.applyOperation({type:'material',bounds:{u0:.1,u1:.3,v0:.4,v1:.6},parameters:{weft:2}});design.revision=origin.bridge.designRevision;assert.throws(()=>validateWorkshopOrigin(origin,design.snapshot()));
});
test('compact origin contains only source and bridge and reconstructs the original design',()=>{
  const s=complete('compact-origin'),project=packWorkshopProject(s),origin=packWorkshopOrigin(project);assert.deepEqual(Object.keys(origin).sort(),['bridge','schema','version','workshop']);assert.ok(JSON.stringify(origin).length<200000);assert.equal(origin.bridge.designRevision,s.state.revision);assert.deepEqual(validateWorkshopOrigin(origin).design.snapshot(),project.design);const bad=structuredClone(origin);bad.bridge.courseMap[0].graphRow=2;assert.throws(()=>validateWorkshopOrigin(bad));
});
test('resume stores only small source and restores running work through one legal pause event',()=>{
  const s=progress(),before=s.snapshot(),resume=packWorkshopResume(s);assert.deepEqual(Object.keys(resume).sort(),['schema','version','workshop']);assert.equal(resume.schema,'silk-workshop-resume');assert.deepEqual(s.snapshot(),before);assert.ok(JSON.stringify(resume).length<100000);const r=restoreWorkshopResume(resume);assert.equal(r.pausedOnRestore,true);assert.equal(r.session.state.production.running,false);assert.equal(r.session.state.events.at(-1).action.type,'pause-knit');assert.equal(r.session.state.revision,before.revision+1);assert.equal(restoreWorkshopResume(packWorkshopResume(r.session)).pausedOnRestore,false);assert.deepEqual(resume.workshop,before);
});
test('resume rejects forged state and extra final payload; finished source remains source-only',()=>{
  const resume=packWorkshopResume(complete());assert.equal(resume.design,undefined);assert.equal(restoreWorkshopResume(resume).session.state.wear.inspection.passed,true);for(const change of [x=>{x.design={};},x=>{x.version=2;},x=>{x.workshop.production.producedCourses=2;},x=>{x.extra=undefined;}]){const value=structuredClone(resume);change(value);assert.throws(()=>restoreWorkshopResume(value));}
});
test('packing a project as origin validates before cloning can erase non-JSON fields',()=>{
  const project=packWorkshopProject(complete());project.extra=undefined;assert.throws(()=>packWorkshopOrigin(project));delete project.extra;project.workshop.extra=undefined;assert.throws(()=>packWorkshopOrigin(project));
});
