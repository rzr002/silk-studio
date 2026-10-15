import test from 'node:test';
import assert from 'node:assert/strict';
import {DesignDocument} from '../dist/design-document.mjs';
import {bodyProjection,getBodyCollisionMesh} from '../dist/contact.mjs';
import {stockingToeCoverage} from '../dist/garment-geometry.mjs';

test('static closed toe remains enclosing during prestretch relaxation with frozen-mesh CCD',()=>{
  const document=new DesignDocument(),model=document.model,settings={pose:0,dimensions:document.bodyDimensions},mesh=getBodyCollisionMesh(settings);
  for(let frame=0;frame<5;frame++)model.step(1/60,{iterations:6,substeps:3,collider:(...p)=>bodyProjection(...p,settings),selfCollision:false,continuousCollision:true,collisionMesh:mesh,surfaceCollision:false});
  const coverage=stockingToeCoverage(model,settings);
  assert.equal(coverage.covered,true,`toe exposed ${coverage.uncoveredProbes}/${coverage.probes}, axial ${coverage.meanCapAxial}m`);
  assert.ok(model.stats().maxStrain<2,`contact must not create a multi-thousand-percent edge extension: ${model.stats().maxStrain}`);
});
