import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {restoreWorkshopProject,validateWorkshopProject} from '../dist/workshop-project.mjs';

// An actual Chromium-exported project, not a locally regenerated fixture.
const sample=()=>JSON.parse(readFileSync(new URL('../examples/finished-stocking.json',import.meta.url),'utf8'));

test('a Chromium-exported completed project restores in Node without modifying its creation source',()=>{
  const value=sample(),before=structuredClone(value),restored=restoreWorkshopProject(value);
  assert.deepEqual(restored.session.snapshot(),value.workshop);
  assert.equal(restored.design.id,value.design.id);
  assert.equal(restored.design.revision,value.design.revision);
  assert.deepEqual(restored.bridge,value.bridge);
  assert.equal(restored.project.bridge.nativeProgram,null);
  assert.deepEqual(value,before);
});

test('derived geometry changes beyond runtime rounding are rejected atomically',()=>{
  const value=sample();value.design.model.positions[219]+=5e-12;
  const before=structuredClone(value);
  assert.throws(()=>validateWorkshopProject(value),/不一致/);
  assert.deepEqual(value,before);
});

test('tiny changes to triangle indices and creation mappings remain exact failures',()=>{
  for(const change of [p=>{p.design.model.triangles[0]+=1e-13;},p=>{p.bridge.courseMap[0].graphRow+=1e-13;}]){
    const value=sample();change(value);assert.throws(()=>validateWorkshopProject(value));
  }
});

test('source dimensions, recipes and bridge source are never rounded for compatibility',()=>{
  for(const change of [p=>{p.design.dimensions.stockingLength+=1e-13;},p=>{p.workshop.recipe.loopLengthMm+=1e-13;},p=>{p.bridge.source.recipe.loopLengthMm+=1e-13;}]){
    const value=sample();change(value);assert.throws(()=>validateWorkshopProject(value));
  }
});

test('runtime rounding cannot hide missing fields, extra fields or array length changes',()=>{
  for(const change of [p=>{delete p.design.model.constraints[0].baseRestLength;},p=>{p.design.model.constraints[0].extra=1e-15;},p=>{p.design.model.positions.push(0);}]){
    const value=sample();change(value);assert.throws(()=>validateWorkshopProject(value));
  }
});
