import test from 'node:test';
import assert from 'node:assert/strict';
import { createTube } from '../dist/physics.mjs';
import { legPoint, legProjection } from '../dist/contact.mjs';
import {createStocking, fitStocking, bodyFrame,stockingToeCoverage} from '../dist/garment-geometry.mjs';
import {bodyProjection, getBodyCollisionMesh,auditBodyIntersections} from '../dist/contact.mjs';
import {DesignDocument} from '../dist/design-document.mjs';
import {SimulationEngine} from '../dist/simulation.mjs';

// This integration regression duplicates the browser's physical setup. It
// checks containment and contact, not manufacturing accuracy or yarn physics.
test('default stocking stays around the leg during gradual 55 degree motion', () => {
  const model = createTube({ cols: 40, rows: 36, height: 0.85, radius: 0.085 });
  for (let row = 0; row < model.rows; row++) {
    const body = legPoint(row / (model.rows - 1), 0);
    for (let col = 0; col < model.cols; col++) {
      const angle = col / model.cols * Math.PI * 2, radius = body.radius + 0.006;
      model.positions.set([body.x + Math.sin(angle) * radius, body.y, body.z + Math.cos(angle) * radius], (row * model.cols + col) * 3);
    }
  }
  model.velocities.fill(0);
  for (const index of model.pins) model.pin(index, true);
  const anchors = [...model.pins].map(index => [index, [...model.positions.slice(index * 3, index * 3 + 3)]]);
  let pose = 0;
  const collider = (x, y, z) => y < 0.046 ? [x, 0.046, z] : legProjection(x, y, z, pose);
  // 79 fixed steps reach 55 degrees, then two seconds at the held pose.
  for (let frame = 0; frame < 199; frame++) {
    pose = Math.min(55, pose + 0.7);
    model.step(1 / 60, { gravity: [0, -9.81, 0], iterations: 8, substeps: 3, collider });
    assert.ok(model.positions.every(Number.isFinite), `nonfinite coordinate at frame ${frame}`);
    if (frame % 10 === 0 || frame === 198) checkContainment(model, pose);
  }
  assert.equal(pose, 55);
  for (const [index, position] of anchors) assert.deepEqual([...model.positions.slice(index * 3, index * 3 + 3)], position);

  for (let index = 0; index < model.positions.length / 3; index++) {
    const point = [...model.positions.slice(index * 3, index * 3 + 3)];
    const projection = legProjection(...point, pose);
    const penetration = projection ? Math.hypot(...point.map((value, k) => value - projection[k])) : 0;
    assert.ok(penetration < 1e-7, `vertex ${index} penetrates ${penetration} m`);
  }
  for (let face = 0; face < model.triangles.length; face += 3) {
    const centroid = [0, 0, 0];
    for (let k = 0; k < 3; k++) for (let axis = 0; axis < 3; axis++) centroid[axis] += model.positions[model.triangles[face + k] * 3 + axis] / 3;
    const projection = legProjection(...centroid, pose, 0);
    const penetration = projection ? Math.hypot(...centroid.map((value, k) => value - projection[k])) : 0;
    assert.ok(penetration < 1e-7, `face ${face / 3} penetrates the zero-margin proxy`);
  }

  // The bottom is an open hem. Some axial sliding is expected, but it must not
  // migrate most of the calf length or pass through the body's closed side wall.
  let y = 0, z = 0;
  for (let col = 0; col < model.cols; col++) { y += model.positions[col * 3 + 1] / model.cols; z += model.positions[col * 3 + 2] / model.cols; }
  const phi = pose * Math.PI / 180;
  const axialSlip = 0.70 + (y - 0.70) * Math.cos(phi) - z * Math.sin(phi) - 0.25;
  assert.ok(Math.abs(axialSlip) < 0.12, `open hem slipped ${axialSlip} m`);
});

function checkContainment(model, pose) {
  for (let row = 0; row < model.rows; row++) {
    const center = legPoint(row / (model.rows - 1), pose), points = [];
    for (let col = 0; col < model.cols; col++) {
      const i = (row * model.cols + col) * 3;
      points.push([model.positions[i] - center.x,
        (model.positions[i + 1] - center.y) * Math.sin(center.phi) + (model.positions[i + 2] - center.z) * Math.cos(center.phi)]);
    }
    let winding = 0;
    for (let col = 0; col < model.cols; col++) {
      const a = points[col], b = points[(col + 1) % model.cols];
      winding += Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
    }
    assert.ok(Math.abs(Math.abs(winding / (2 * Math.PI)) - 1) < 1e-6,
      `ring ${row} stopped enclosing the body at ${pose} degrees`);
  }
}

test('complete stocking initialization clears the foot and closed toe with physical contact margin', () => {
  for(const pose of [0,25,55]){
  const model = createStocking();
  fitStocking(model,{pose});
  for (let face = 0; face < model.triangles.length; face += 3) {
    const centroid = [0, 0, 0];
    for (let corner = 0; corner < 3; corner++) for (let axis = 0; axis < 3; axis++) centroid[axis] += model.positions[model.triangles[face + corner] * 3 + axis] / 3;
    assert.equal(bodyProjection(...centroid, {pose,margin: 0.001}), null, `initial full-foot face ${face / 3} at ${pose}° must clear the numerical body stand-off`);
  }
  assert.equal(auditBodyIntersections(model,{pose}).pairCount,0,`initial full stocking at ${pose}° must have no cloth/body triangle crossings`);
  }
});

test('closed-toe full stocking retains body enclosure during gradual 0 to 55 degree motion', {timeout: 120000}, () => {
  const document=new DesignDocument(),engine=new SimulationEngine();engine.sync(document.model.snapshot(),1);const model=engine.model;
  const anchors = [...model.pins].map(index => [index, [...model.positions.slice(index * 3, index * 3 + 3)]]);
  let pose = 0;
  for (let frame = 0; frame < 110; frame++) {
    pose = Math.min(55, pose + 0.7);
    engine.step({epoch:1,pose,bodyDimensions:document.bodyDimensions,gravity:true,collider:true,selfCollision:true,continuousCollision:true,quality:'standard',dt:1/60});
    assert.ok(model.positions.every(Number.isFinite), `nonfinite full stocking at frame ${frame}`);
    if (frame % 10 === 0 || frame === 109) checkFullContainment(model, pose);
  }
  assert.equal(pose, 55);
  for (const [index, anchor] of anchors) assert.deepEqual([...model.positions.slice(index * 3, index * 3 + 3)], anchor);
  for (let index = 0; index < model.positions.length / 3; index++) {
    const p = [...model.positions.slice(index * 3, index * 3 + 3)], q = bodyProjection(...p, {pose, margin: 0});
    assert.ok(!q || Math.hypot(...p.map((x, axis) => x - q[axis])) < 1e-7, `full stocking vertex ${index} penetrates body`);
  }
  // A cap can intersect a body while all cloth vertices are outside. Check
  // interior face and edge locations as well as both meshes' crossing edges.
  for(let j=0;j<model.triangles.length;j+=3){
    const ids=model.triangles.slice(j,j+3),points=ids.map(i=>model.positions.slice(i*3,i*3+3));
    for(const weights of [[1/3,1/3,1/3],[.5,.5,0],[.5,0,.5],[0,.5,.5],[.6,.2,.2],[.2,.6,.2],[.2,.2,.6]]){
      const point=[0,1,2].map(k=>points.reduce((sum,p,i)=>sum+p[k]*weights[i],0)),projection=bodyProjection(...point,{pose,dimensions:document.bodyDimensions,margin:0});
      assert.ok(!projection||Math.hypot(...point.map((x,k)=>x-projection[k]))<1e-7,`full stocking face ${j/3} interior sample penetrates body`);
    }
  }
  const crossings=auditBodyIntersections(model,{pose,dimensions:document.bodyDimensions});
  assert.equal(crossings.pairCount,0,`full stocking has ${crossings.pairCount} cloth/body triangle crossings`);
});

function checkFullContainment(model, pose) {
  const toe=stockingToeCoverage(model,{pose});
  assert.equal(toe.covered,true,`toe tip is exposed: ${toe.uncoveredProbes}/${toe.probes}, cap axial ${toe.meanCapAxial}m at ${pose} degrees`);
  for (let row = 0; row < model.rows; row++) {
    const f = bodyFrame(row / (model.rows - 1), {pose}), points = [];
    for (let col = 0; col < model.cols; col++) {
      const offset = (row * model.cols + col) * 3;
      points.push([model.positions[offset] - f.x, (model.positions[offset + 1] - f.y) * f.ny + (model.positions[offset + 2] - f.z) * f.nz]);
    }
    let winding = 0;
    for (let col = 0; col < points.length; col++) {
      const a = points[col], b = points[(col + 1) % points.length];
      winding += Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
    }
    assert.ok(Math.abs(Math.abs(winding / (2 * Math.PI)) - 1) < 1e-6, `full stocking row ${row} loses body enclosure at ${pose} degrees`);
  }
}
