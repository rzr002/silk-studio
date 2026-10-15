import test from 'node:test';
import assert from 'node:assert/strict';
import {bodySurface, bodyFrame, bodyGeometryData,createStocking,fitStocking} from '../dist/garment-geometry.mjs';

const contact = await import('../dist/contact.mjs').catch(() => ({}));
function requireContact() {
  assert.equal(typeof contact.legPoint, 'function', 'rigid leg contact module must exist');
  assert.equal(typeof contact.legProjection, 'function');
}
function ringPoint(t, around, angle, radialOffset) {
  const p = contact.legPoint(t, angle), radius = p.radius + radialOffset;
  return [p.x + Math.sin(around) * radius,
    p.y + Math.sin(p.phi) * Math.cos(around) * radius,
    p.z + Math.cos(p.phi) * Math.cos(around) * radius];
}

test('all generated body rings detect points one millimetre inside, including bent knee crossings', () => {
  requireContact();
  for (const angle of [0, 25, 50, 55]) {
    for (let row = 0; row <= 100; row++) {
      for (let col = 0; col < 40; col++) {
        const p = ringPoint(row / 100, col / 40 * Math.PI * 2, angle, -0.001);
        assert.ok(contact.legProjection(...p, angle), `missed ring t=${row / 100}, col=${col}, angle=${angle}`);
      }
    }
  }
});

test('projection exits the union of the two segments rather than the other segment interior', () => {
  requireContact();
  for (const angle of [0, 25, 50, 55]) {
    for (let row = 0; row <= 50; row++) {
      for (let col = 0; col < 16; col++) {
        let p = ringPoint(row / 50, col / 16 * Math.PI * 2, angle, -0.015);
        for (let iteration = 0; iteration < 8; iteration++) {
          const q = contact.legProjection(...p, angle);
          if (!q) break;
          assert.ok(q.every(Number.isFinite));
          p = q;
        }
        assert.equal(contact.legProjection(...p, angle), null, `projection did not converge at t=${row / 50}, col=${col}, angle=${angle}`);
      }
    }
  }
});

test('exact centerline and both end caps have finite closed contact', () => {
  requireContact();
  for (const angle of [0, 55]) for (const t of [0, 0.25, 0.5294117647058824, 0.8, 1]) {
    const c = contact.legPoint(t, angle);
    const result = contact.legProjection(c.x, c.y, c.z, angle);
    assert.ok(result && result.every(Number.isFinite));
    assert.equal(contact.legProjection(...result, angle), null);
  }
  const lower = contact.legPoint(0, 0), upper = contact.legPoint(1, 0);
  assert.ok(contact.legProjection(lower.x, lower.y - lower.radius / 2, lower.z, 0));
  assert.ok(contact.legProjection(upper.x, upper.y + upper.radius / 2, upper.z, 0));
});

test('far away points are unchanged and margin expands the contact surface', () => {
  requireContact();
  assert.equal(contact.legProjection(3, 3, 3, 55), null);
  const c = contact.legPoint(0.8, 0), p = [c.x + c.radius + 0.002, c.y, c.z];
  assert.equal(contact.legProjection(...p, 0, 0), null);
  assert.ok(contact.legProjection(...p, 0, 0.003));
});

test('bent lower ring above world knee height still collides with its own segment', () => {
  requireContact();
  const point = [0.12, 0.7010425147370225, 0.13337361359855868];
  assert.ok(contact.legProjection(...point, 50));
});

test('complete foot, heel and leg contact detects inward surface samples at every supported pose', () => {
  assert.equal(typeof contact.bodyProjection, 'function', 'complete mannequin contact must exist');
  for (const pose of [0, 25, 55]) for (const v of [0.02, 0.14, 0.26, 0.36, 0.5, 0.69, 0.85, 0.98]) {
    const frame = bodyFrame(v, {pose}), center = [frame.x, frame.y, frame.z];
    for (let col = 0; col < 16; col++) {
      const p = bodySurface(col / 16, v, {pose}).map((x, k) => center[k] + (x - center[k]) * 0.95);
      const projected = contact.bodyProjection(...p, {pose});
      assert.ok(projected, `missed inward full-body point u=${col / 16},v=${v},pose=${pose}`);
      assert.ok(projected.every(Number.isFinite));
      assert.equal(contact.bodyProjection(...projected, {pose}), null, 'projection must exit the full closed mannequin');
    }
  }
});

test('visible closed mannequin vertices match the zero-margin contact mesh', () => {
  assert.equal(typeof contact.bodyProjection, 'function');
  for (const pose of [0, 55]) {
    const mesh = bodyGeometryData({pose});
    for (let i = 0; i < mesh.positions.length; i += 3 * 37) {
      assert.equal(contact.bodyProjection(...mesh.positions.slice(i, i + 3), {pose, margin: 0}), null);
    }
    const center = bodyFrame(0.26, {pose});
    assert.ok(contact.bodyProjection(center.x, center.y, center.z, {pose}));
  }
});

test('full mannequin contact leaves clear exterior points unchanged and has finite closed caps', () => {
  assert.equal(typeof contact.bodyProjection, 'function');
  assert.equal(contact.bodyProjection(3, 3, 3, {pose: 55}), null);
  for (const v of [0, 1]) {
    const frame = bodyFrame(v);
    const p = [frame.x, frame.y, frame.z];
    const q = contact.bodyProjection(...p, {margin: 0.003});
    assert.ok(q?.every(Number.isFinite));
    assert.equal(contact.bodyProjection(...q, {margin: 0.003}), null);
  }
  for (const v of [0.08, 0.5, 0.85]) {
    const p = bodySurface(0.2, v, {margin: 0.012});
    assert.equal(contact.bodyProjection(...p), null);
  }
  assert.equal(contact.bodyProjection(NaN, 0, 0), null);
});

test('cached collision geometry does not turn a null dimension into a valid default', () => {
  assert.equal(typeof contact.getBodyCollisionMesh, 'function');
  contact.getBodyCollisionMesh({pose: 0});
  assert.throws(() => contact.getBodyCollisionMesh({pose: 0, dimensions: {footLength: null}}), /dimension/i);
});

test('surface intersection audit catches a toe fan cutting through body despite exterior ring vertices',()=>{
  assert.equal(typeof contact.auditBodyIntersections,'function');
  const model=createStocking();fitStocking(model);
  assert.equal(contact.auditBodyIntersections(model).pairCount,0);
  const f=bodyFrame(0),normal=[0,-f.ty,-f.tz];
  for(let col=0;col<model.cols;col++)for(let k=0;k<3;k++)model.positions[col*3+k]-=normal[k]*.05;
  const audit=contact.auditBodyIntersections(model);
  assert.ok(audit.pairCount>0);
  assert.ok(audit.clothFaceCount>0);
  assert.ok(audit.toePairCount>0);
});

test('toe end-plane contact uses the cap normal across internal triangulation edges',()=>{
  for(const pose of [0,55]){const f=bodyFrame(0,{pose}),center=[f.x,f.y,f.z],normal=[0,-f.ty,-f.tz],p=center.map((x,k)=>x-normal[k]*.001),q=contact.bodyProjection(...p,{pose,margin:.003});
    assert.ok(q);
    for(let k=0;k<3;k++)assert.ok(Math.abs(q[k]-center[k]-normal[k]*(.003+1e-7))<1e-5,'an internal cap diagonal must not push the toe sideways');
  }
});
