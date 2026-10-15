import test from 'node:test';
import assert from 'node:assert/strict';
import {createPatch, createTube, restoreModel} from '../dist/physics.mjs';

const api = await import('../dist/rest-shape.mjs').catch(() => ({}));
function edit(...args) {
  assert.equal(typeof api.editRestShape, 'function', 'persistent rest-shape editor must exist');
  return api.editRestShape(...args);
}
const point = (array, index) => [...array.slice(3 * index, 3 * index + 3)];
const distance = (array, a, b) => Math.hypot(...point(array, a).map((x, k) => x - array[3 * b + k]));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} differs from ${b}`);

test('rest-shape brush moves current and natural positions exactly once with smooth falloff', () => {
  const model = createPatch({cols: 5, rows: 5});
  const initial = [...model.rest];
  model.velocities.fill(2);
  const result = edit(model, [0.5, 0.5], [0.06, 0, 0.03], 0.3);
  assert.ok(result.changedVertices >= 5);
  assert.ok(result.changedConstraints > 0);
  near(model.rest[12 * 3] - initial[12 * 3], 0.06);
  near(model.positions[12 * 3] - initial[12 * 3], 0.06);
  near(model.rest[12 * 3 + 2] - initial[12 * 3 + 2], 0.03);
  assert.ok(model.rest[11 * 3] > initial[11 * 3] && model.rest[11 * 3] < initial[11 * 3] + 0.06);
  assert.deepEqual(point(model.rest, 0), point(initial, 0));
  assert.deepEqual(point(model.velocities, 12), [0, 0, 0]);
  assert.deepEqual(point(model.velocities, 0), [2, 2, 2]);
});

test('incident material and knit natural lengths update while local rest-scale ratios survive', () => {
  const model = createPatch({cols: 5, rows: 5});
  model.setRegion({u0: 0, v0: 0, u1: 1, v1: 1}, {restScale: 0.9});
  model.addLink(12, 1, {kind: 'knit', restLength: distance(model.rest, 12, 1) * 0.7});
  const scales = model.constraints.map(c => c.restLength / c.baseRestLength);
  edit(model, [0.5, 0.5], [0.06, 0, 0.03], 0.3);
  model.constraints.forEach((c, index) => {
    near(c.baseRestLength, distance(model.rest, c.a, c.b));
    near(c.restLength / c.baseRestLength, scales[index]);
  });
  assert.equal(model._strainDirty, true);
});

test('pin and grab destinations follow a rest edit and the edit survives release and pose reset', () => {
  const model = createPatch({cols: 5, rows: 5});
  const pin = 22;
  const previous = point(model.rest, pin);
  model.grab(pin, point(model.positions, pin));
  edit(model, [0.5, 1], [0.04, 0.02, 0.01], 0.2);
  assert.deepEqual(model.pinTargets.get(pin), point(model.positions, pin));
  assert.deepEqual(model.grabbed.target, point(model.positions, pin));
  const edited = point(model.rest, pin);
  model.release();
  model.step(1 / 60, {gravity: [0, 0, 0]});
  assert.deepEqual(point(model.positions, pin), edited);
  model.resetPose();
  assert.deepEqual(point(model.positions, pin), edited);
  near(edited[0] - previous[0], 0.04);
});

test('tube brush crosses the periodic u seam without touching the opposite side', () => {
  const model = createTube({cols: 12, rows: 5});
  const before = [...model.rest];
  edit(model, [0, 0.5], [0, 0.03, 0], 0.2);
  assert.ok(model.rest[3 * 24 + 1] > before[3 * 24 + 1]);
  assert.ok(model.rest[3 * 35 + 1] > before[3 * 35 + 1], 'u near 1 shares the brush at u=0');
  assert.deepEqual(point(model.rest, 30), point(before, 30));
});

test('rest-area mass is rebuilt and sewn target lengths are retained', () => {
  const model = createPatch({cols: 5, rows: 5});
  model.sew(0, 4);
  const seam = model.constraints.find(c => c.kind === 'seam');
  const seamLength = seam.restLength, seamBase = seam.baseRestLength;
  const mass = model.mass;
  const inverseMass = model.inverseMass[0];
  const result = edit(model, [0, 0], [0, 0, 0.06], 0.4);
  assert.ok(model.mass > mass, 'out-of-plane natural shape adds rest area');
  near(result.massDelta, model.mass - mass);
  assert.ok(model.inverseMass[0] < inverseMass, 'larger incident rest area increases vertex mass');
  near(seam.restLength, seamLength);
  near(seam.baseRestLength, seamBase);
  assert.ok(Number.isFinite(model.inverseMass[0]) && model.inverseMass[0] > 0);
});

test('rest-shape metadata and state persist through the existing physical snapshot format', () => {
  const model = createPatch({cols: 5, rows: 5});
  const uv = [0.5, 0.5], delta = [0.03, 0.02, 0.01];
  edit(model, uv, delta);
  uv[0] = 0; delta[0] = 9;
  assert.deepEqual(model.regions.at(-1), {kind: 'rest-shape', centerUV: [0.5, 0.5], delta: [0.03, 0.02, 0.01], radius: 0.12});
  const saved = JSON.parse(JSON.stringify(model.snapshot()));
  const copy = restoreModel(saved);
  assert.deepEqual(copy.snapshot(), saved);
  copy.resetPose();
  assert.deepEqual([...copy.positions], [...model.rest]);
});

test('bounded invalid inputs are rejected atomically and a zero displacement is a no-op', () => {
  const model = createPatch({cols: 5, rows: 5});
  const saved = model.snapshot();
  for (const args of [
    [[-0.1, 0.5], [0.1, 0, 0], 0.2],
    [[0.5, Infinity], [0.1, 0, 0], 0.2],
    [[0.5, 0.5], [NaN, 0, 0], 0.2],
    [[0.5, 0.5], [1, 0, 0], 0.2],
    [[0.5, 0.5], [0.1, 0, 0], 0],
    [[0.5, 0.5], [0.1, 0, 0], 2]
  ]) assert.throws(() => edit(model, ...args), /brush|displacement|radius|UV/i);
  assert.deepEqual(model.snapshot(), saved);
  assert.deepEqual(edit(model, [0.5, 0.5], [0, 0, 0]), {changedVertices: 0, changedConstraints: 0, massDelta: 0});
  assert.deepEqual(model.snapshot(), saved);
});

test('a brush that collapses an incident natural edge is rejected before changing the model', () => {
  const model = createPatch({cols: 5, rows: 5});
  const saved = model.snapshot();
  assert.throws(() => edit(model, [0.5, 0.5], [0.125, 0, 0], 0.12), /degenerate/i);
  assert.deepEqual(model.snapshot(), saved);
});
test('stocking rest brush wraps the same circumferential seam as its physical tube',async()=>{const {createStocking}=await import('../dist/garment-geometry.mjs');const model=createStocking({cols:24,rows:32}),row=20,a=row*24,b=a+23,opposite=a+12,before=[...model.rest];edit(model,[0,row/31],[0,.015,0],.10);assert.ok(model.rest[a*3+1]>before[a*3+1]);assert.ok(model.rest[b*3+1]>before[b*3+1],'u near 1 must share a stocking brush centred at u=0');assert.deepEqual(point(model.rest,opposite),point(before,opposite));});
