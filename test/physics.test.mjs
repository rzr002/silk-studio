import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../dist/physics.mjs').catch(() => ({}));
function patch(options) {
  assert.equal(typeof api.createPatch, 'function', 'cloth solver API must exist');
  return api.createPatch(options);
}
const point = (model, i) => [...model.positions.slice(3 * i, 3 * i + 3)];
const length = (model, a, b) => Math.hypot(...point(model, a).map((v, k) => v - point(model, b)[k]));
const simulate = (model, frames, options = {}) => {
  for (let i = 0; i < frames; i++) model.step(1 / 60, options);
};

test('gravity changes free cloth while fixed anchors stay exactly fixed', () => {
  const model = patch({ cols: 8, rows: 10 });
  const before = [...model.positions];
  const anchors = [...model.pins].map(i => [i, point(model, i)]);
  simulate(model, 40);
  assert.ok(model.positions[1] < before[1] - 0.00001);
  for (const [i, initial] of anchors) assert.deepEqual(point(model, i), initial);
});

test('grab target is kinematic and releasing returns control to the solver', () => {
  const model = patch({ cols: 8, rows: 10 });
  const i = 3;
  const target = [0.2, 0.4, 0.15];
  model.grab(i, target);
  simulate(model, 8);
  assert.deepEqual(point(model, i), target);
  model.moveGrab([0.22, 0.42, 0.12]);
  model.step(1 / 60);
  assert.deepEqual(point(model, i), [0.22, 0.42, 0.12]);
  model.release();
  simulate(model, 20);
  assert.ok(Math.hypot(...point(model, i).map((v, k) => v - [0.22, 0.42, 0.12][k])) > 0.005);
});

test('cut removes material and every constraint bridging the slit including bends', () => {
  const model = patch({ cols: 12, rows: 13 });
  const previousFaces = model.triangles.length / 3;
  const result = model.cutSegmentUV([-0.01, 0.5], [1.01, 0.5], 0.008);
  assert.ok(result.removedFaces > 0);
  assert.ok(model.triangles.length / 3 < previousFaces);
  for (const c of model.constraints) {
    const av = model.uv[c.a * 2 + 1];
    const bv = model.uv[c.b * 2 + 1];
    assert.ok(!((av < 0.5 && bv > 0.5) || (av > 0.5 && bv < 0.5)), `bridging ${c.kind}`);
  }
  assert.ok(model.stats().removedMass > 0);
  const low = point(model, 0)[1];
  simulate(model, 30);
  assert.ok(point(model, 0)[1] < low - 0.15, 'detached lower material must actually fall');
});

test('sewing boundary vertices adds a physical seam that draws them together', () => {
  const model = patch({ cols: 8, rows: 10 });
  const before = length(model, 0, 7);
  const result = model.sew(0, 7);
  assert.equal(result.ok, true);
  assert.equal(model.stats().seams, 1);
  simulate(model, 40, { gravity: [0, 0, 0] });
  assert.ok(length(model, 0, 7) < before * 0.65);
  assert.equal(model.sew(0, 7).ok, false, 'duplicate seam must be refused');
  assert.equal(model.sew(9, 10).ok, false, 'interior sewing needs a boundary');
});

test('a softer local warp region extends further under the same load', () => {
  const stiff = patch({ cols: 6, rows: 9 });
  const soft = patch({ cols: 6, rows: 9 });
  stiff.setRegion({ u0: 0, v0: 0, u1: 1, v1: 1 }, { warp: 8, weft: 8, shear: 8 });
  soft.setRegion({ u0: 0, v0: 0, u1: 1, v1: 1 }, { warp: 0.08, weft: 0.08, shear: 0.08 });
  simulate(stiff, 120, { loadAcceleration: [0, -50, 0] });
  simulate(soft, 120, { loadAcceleration: [0, -50, 0] });
  assert.ok(stiff.positions[1] - soft.positions[1] > 0.005);
  assert.ok(soft.stats().maxStrain > stiff.stats().maxStrain);
});

test('collision projection keeps free vertices outside a rigid floor', () => {
  const model = patch({ cols: 6, rows: 9 });
  for (const i of [...model.pins]) model.pin(i, false);
  simulate(model, 180, { collider: (x, y, z) => y < 0 ? [x, 0, z] : null });
  for (let i = 0; i < model.positions.length; i += 3) assert.ok(model.positions[i + 1] >= -1e-10);
});

test('tube uses periodic mesh connectivity without an open longitudinal seam', () => {
  assert.equal(typeof api.createTube, 'function');
  const model = api.createTube({ cols: 12, rows: 10 });
  assert.equal(model.positions.length / 3, 120);
  assert.equal(model.triangles.length / 3, 12 * 9 * 2);
  assert.ok(model.constraints.some(c => c.a === 0 && c.b === 11 || c.a === 11 && c.b === 0));
  assert.equal(model.stats().boundaryVertices, 24);
});

test('full structure and dynamic state roundtrip deterministically through JSON', () => {
  const model = patch({ cols: 8, rows: 10 });
  model.setRegion({ u0: 0, v0: 0, u1: 0.5, v1: 0.5 }, { weft: 2, restScale: 0.95 });
  model.cutSegmentUV([0, 0.45], [0.45, 0.45], 0.01);
  model.sew(0, 7);
  simulate(model, 5);
  const saved = JSON.parse(JSON.stringify(model.snapshot()));
  assert.equal(typeof api.restoreModel, 'function');
  const copy = api.restoreModel(saved);
  assert.deepEqual(copy.snapshot(), saved);
  simulate(copy, 5);
  simulate(model, 5);
  assert.deepEqual([...copy.positions], [...model.positions]);
  copy.resetPose();
  assert.deepEqual([...copy.positions], [...copy.rest]);
  assert.equal(copy.stats().removedFaces, model.stats().removedFaces, 'pose reset must preserve cuts');
});

test('solver remains finite after 1000 loaded contact steps', () => {
  const model = patch({ cols: 6, rows: 9 });
  simulate(model, 1000, { loadAcceleration: [8, -5, 3], collider: (x, y, z) => y < 0 ? [x, 0, z] : null });
  assert.ok([...model.positions].every(Number.isFinite));
  assert.ok(model.stats().maxStrain < 5);
  assert.ok(Number.isFinite(model.vertexStrain(12)));
});

test('custom knit support link physically resists the same imposed displacement', () => {
  const model = patch({ cols: 8, rows: 10 });
  const a = 0, b = 7;
  assert.equal(typeof model.addLink, 'function');
  assert.equal(model.addLink(a, b, { kind: 'knit', compliance: 0.000001, restLength: 0.1 }).ok, true);
  simulate(model, 30, { gravity: [0, 0, 0] });
  assert.ok(length(model, a, b) < 0.2);
  assert.equal(model.addLink(a, a, { kind: 'knit' }).ok, false);
});

test('a seam-crossing tube cut follows the short periodic path', () => {
  const model = api.createTube({ cols: 24, rows: 16 });
  model.cutSegmentUV([0.97, 0.25], [0.03, 0.75], 0.005);
  const oppositeFace = model.triangles.some((index, j) => j % 3 === 0 &&
    [index, model.triangles[j + 1], model.triangles[j + 2]].every(i => model.uv[i * 2] > 0.4 && model.uv[i * 2] < 0.6 && model.uv[i * 2 + 1] > 0.4 && model.uv[i * 2 + 1] < 0.6));
  assert.ok(oppositeFace, 'cut at u=0 must leave opposite u=.5 material intact');
});

test('grab reaction estimate rises under an imposed extension', () => {
  const model = patch({ cols: 8, rows: 10 });
  model.grab(3, [0.4, 0.15, 0.1]);
  simulate(model, 20, { gravity: [0, 0, 0] });
  assert.ok(model.stats().grabForceN > 0.01);
  assert.ok(Number.isFinite(model.stats().grabForceN));
});

test('malformed saved topology is rejected before solving', () => {
  const saved = patch({ cols: 6, rows: 8 }).snapshot();
  saved.constraints[0].a = saved.positions.length + 8;
  assert.throws(() => api.restoreModel(saved), /快照/);
});

test('saved grids reject invalid dimensions, vertex count mismatches and unknown model kinds', () => {
  const model = patch({ cols: 6, rows: 8 });
  for (const fields of [{ cols: 1 }, { rows: null }, { rows: 1e308 }, { cols: 7 }, { kind: 'unknown' }]) {
    const saved = model.snapshot();
    Object.assign(saved, fields);
    assert.throws(() => api.restoreModel(saved), /快照/, `must reject ${JSON.stringify(fields)}`);
  }
});

test('saved anchor targets must exactly match unique pinned vertices', () => {
  const model = patch({ cols: 6, rows: 8 });
  for (const mutate of [
    saved => saved.pinTargets.push([0, [0, 0, 0]]),
    saved => saved.pinTargets.pop(),
    saved => saved.pinTargets.push(saved.pinTargets[0]),
    saved => saved.pins.push(saved.pins[0]),
    saved => { saved.pinTargets[0][0] = 0; }
  ]) {
    const saved = model.snapshot();
    mutate(saved);
    assert.throws(() => api.restoreModel(saved), /快照/);
  }
});

test('malformed drag targets cannot overwrite adjacent vertices or replace a valid grab', () => {
  const model = patch({cols: 6, rows: 8});
  for (const target of [[], [0, 1], [0, 1, 2, 3, 4, 5], [0, NaN, 2]]) {
    assert.equal(model.grab(3, target), false);
    assert.equal(model.grabbed, null);
  }
  assert.equal(model.grab(3, [0.1, 0.4, 0]), true);
  for (const target of [[1, 2], [1, 2, 3, 4]]) {
    assert.equal(model.moveGrab(target), false);
    assert.deepEqual(model.grabbed.target, [0.1, 0.4, 0]);
  }
});

test('an explicit numerical extension limit stops an uncalibrated spring from stretching arbitrarily',()=>{
  const model=patch({cols:3,rows:3}),c=model.constraints.find(c=>c.kind==='weft');
  model.constraints=[c];c.compliance=1e6;
  for(const i of [...model.pins])model.pin(i,false);
  const original=c.restLength;
  model.positions[c.b*3]+=original*4;
  model.step(1/60,{gravity:[0,0,0],substeps:1,iterations:8,strainLimit:.5});
  assert.ok(length(model,c.a,c.b)<=original*1.5+1e-8);
  assert.equal(c.restLength,original);
  assert.ok(model.stats().strainLimiting.corrections>0);
  assert.equal(model.stats().strainLimiting.calibrated,false);
});

test('extension guard configuration persists and kinematic conflicts stay explicit',()=>{
  const model=patch({cols:3,rows:3}),c=model.constraints.find(c=>c.kind==='weft');
  model.constraints=[c];for(const i of [...model.pins])model.pin(i,false);
  model.positions[c.b*3]+=c.restLength*4;model.pin(c.a,true);model.pin(c.b,true);model.setStrainLimit(.5);
  const before=[...model.positions];model.step(1/60,{gravity:[0,0,0]});
  assert.deepEqual([...model.positions],before);assert.ok(model.stats().strainLimiting.conflicts>0);
  assert.equal(api.restoreModel(model.snapshot()).strainLimit,.5);
  assert.throws(()=>api.restoreModel({...model.snapshot(),strainLimit:-1}),/伸长|快照/);
  model.setStrainLimit(null);
  assert.equal(model.stats().strainLimiting.limitEngineeringStrain,null);
  assert.equal(api.restoreModel(model.snapshot()).strainLimit,null);
});

test('a constraint sweep cannot teleport a free vertex through a collider to its other exit',()=>{
  const model=patch({cols:3,rows:3});for(const i of [...model.pins])model.pin(i,false);
  model.positions.set([0,0,.2],0);model.positions.set([0,0,-.2],3);model.pin(1,true);
  model.constraints=[{a:0,b:1,kind:'warp',restLength:.01,baseRestLength:.01,compliance:0,lambda:0,stiffness:1}];
  const sphere=(x,y,z)=>{const radius=Math.hypot(x,y,z);return radius<.1?[x*.1/radius,y*.1/radius,z*.1/radius]:null;};
  model.step(1/60,{gravity:[0,0,0],iterations:1,substeps:1,collider:sphere,strainLimit:null,sweptCollider:true});
  assert.ok(model.positions[2]>=.099999,'must preserve the incoming side during the spring correction itself');
  assert.ok(model.stats().collision.sweptColliderContacts>0);
  assert.equal(model.stats().collision.sweptColliderExactCCD,false);
});
