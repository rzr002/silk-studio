import test from 'node:test';
import assert from 'node:assert/strict';

let knitModule = {};
try { knitModule = await import('../dist/knit.mjs'); } catch {}

function create(options) {
  assert.equal(typeof knitModule.createKnit, 'function', 'semantic knitting graph factory must exist');
  return knitModule.createKnit(options);
}

test('a bounded swatch exposes stitches and cross-course loop support', () => {
  const graph = create({cols: 4, rows: 5});
  assert.equal(graph.nodes.length, 20);
  assert.equal(graph.nodes.find(n => n.id === 's-2-1').type, 'knit');
  assert.equal(graph.supportLinks().length, 16);
  assert.ok(graph.supportLinks().some(e => e.from === 's-1-1' && e.to === 's-2-1'));
  assert.equal(graph.validate().valid, true);
});

test('yarn courses form one continuous finite path with loop-depth crossings', () => {
  const graph = create({cols: 4, rows: 5});
  const paths = graph.yarnPaths();
  assert.equal(paths.length, 1);
  assert.equal(paths[0].nodeIds.length, 20);
  assert.ok(paths[0].points.length > 200);
  assert.ok(paths[0].points.every(p => p.length === 3 && p.every(Number.isFinite)));
  assert.ok(paths[0].points.some(p => p[2] > 0));
  assert.ok(paths[0].points.some(p => p[2] < 0));
  for (let i = 1; i < paths[0].points.length; i++) {
    const a = paths[0].points[i - 1], b = paths[0].points[i];
    assert.ok(Math.hypot(...a.map((v, j) => v - b[j])) < 0.3, 'course must not jump between stitches');
  }
});

test('manufacturing and physical calibration remain unverified', () => {
  const graph = create({cols: 4, rows: 5});
  const stats = graph.stats();
  assert.equal(stats.loops, 20);
  assert.equal(stats.manufacturing, 'experimental');
  assert.equal(stats.calibrated, false);
  assert.ok(stats.yarnLength > 0);
  assert.equal(stats.openings, 0);
});

test('a miss floats yarn past the held loop which the next course catches', () => {
  const graph = create({cols: 4, rows: 5});
  const previousPath = graph.yarnPaths()[0].points;
  graph.setStitch(2, 1, 'miss');
  const links = graph.supportLinks();
  assert.ok(links.some(e => e.from === 's-1-1' && e.to === 's-3-1'));
  assert.ok(!links.some(e => e.to === 's-2-1' || e.from === 's-2-1'));
  assert.equal(graph.stats().loops, 19);
  assert.notDeepEqual(graph.yarnPaths()[0].points, previousPath);
  assert.ok(graph.stats().yarnLength < create({cols: 4, rows: 5}).stats().yarnLength);
});

test('a tuck retains the previous loop and the next knit catches both loops', () => {
  const graph = create({cols: 4, rows: 5});
  graph.setStitch(2, 1, 'tuck');
  const links = graph.supportLinks();
  assert.ok(links.some(e => e.from === 's-1-1' && e.to === 's-2-1' && e.relation === 'tuck'));
  assert.ok(links.some(e => e.from === 's-1-1' && e.to === 's-3-1'));
  assert.ok(links.some(e => e.from === 's-2-1' && e.to === 's-3-1'));
  assert.notDeepEqual(graph.yarnPaths(), create({cols: 4, rows: 5}).yarnPaths());
});

test('an experimental eyelet redistributes support to a neighbouring needle', () => {
  const graph = create({cols: 4, rows: 5});
  graph.setStitch(2, 1, 'eyelet');
  assert.ok(graph.supportLinks().some(e => e.from === 's-1-1' && e.to === 's-2-2'));
  assert.ok(!graph.supportLinks().some(e => e.to === 's-2-1'));
  assert.equal(graph.stats().openings, 1);
  assert.equal(graph.stats().manufacturing, 'experimental');
  assert.ok(graph.validate().issues.some(i => i.code === 'EXPERIMENTAL_EYELET'));
});

test('stitches expose continuous course neighbours independently of support edges', () => {
  const graph = create({cols: 4, rows: 5});
  const node = graph.nodes.find(n => n.id === 's-1-3');
  assert.equal(node.yarnPrev, 's-0-3');
  assert.equal(node.yarnNext, 's-1-2');
  assert.deepEqual(node.loopInputs, ['s-0-3']);
});

test('a manual loop connection changes support and refuses impossible graph edges', () => {
  const graph = create({cols: 4, rows: 5});
  const count = graph.supportLinks().length;
  graph.connect('s-0-0', 's-2-2');
  assert.equal(graph.supportLinks().length, count + 1);
  assert.ok(graph.supportLinks().some(e => e.from === 's-0-0' && e.to === 's-2-2' && e.relation === 'manual'));
  assert.throws(() => graph.connect('s-0-0', 's-2-2'), /duplicate/i);
  assert.throws(() => graph.connect('s-1-1', 's-1-1'), /self/i);
  assert.throws(() => graph.connect('s-2-2', 's-0-0'), /forward/i);
  assert.throws(() => graph.connect('missing', 's-2-2'), /unknown/i);
  graph.setStitch(2, 3, 'miss');
  assert.throws(() => graph.connect('s-0-0', 's-2-3'), /loop/i);
});

test('deleting a loop removes graph incidence and reports dropped-loop risk', () => {
  const graph = create({cols: 4, rows: 5});
  graph.connect('s-0-0', 's-2-2');
  graph.removeStitch(2, 2);
  assert.ok(!graph.nodes.some(n => n.id === 's-2-2'));
  assert.ok(!graph.supportLinks().some(e => e.from === 's-2-2' || e.to === 's-2-2'));
  assert.equal(graph.validate().valid, false);
  assert.ok(graph.validate().issues.some(i => i.code === 'DELETED_LOOP_DROP_RISK'));
  assert.equal(graph.stats().openings, 1);
  assert.ok(graph.yarnPaths()[0].points.every(p => p.every(Number.isFinite)));
  graph.setStitch(2, 2, 'knit');
  assert.equal(graph.validate().valid, true);
});

test('editing a loop used by a manual support reports a topology conflict', () => {
  const graph = create({cols: 4, rows: 5});
  graph.connect('s-0-0', 's-2-2');
  graph.setStitch(2, 2, 'miss');
  assert.equal(graph.validate().valid, false);
  assert.ok(graph.validate().issues.some(i => i.code === 'NON_LOOP_SUPPORT'));
});

test('snapshots round-trip topology and geometry without granting manufacturing readiness', () => {
  const graph = create({cols: 4, rows: 5});
  graph.setStitch(1, 1, 'tuck').setStitch(2, 1, 'miss').setStitch(3, 2, 'eyelet');
  graph.connect('s-0-0', 's-3-3');
  graph.removeStitch(2, 2);
  const snapshot = graph.snapshot();
  const restored = knitModule.restoreKnit(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.snapshot(), snapshot);
  assert.deepEqual(restored.supportLinks(), graph.supportLinks());
  assert.deepEqual(restored.yarnPaths(), graph.yarnPaths());
  assert.equal(restored.stats().manufacturing, 'experimental');
  snapshot.cells[0] = 'miss';
  assert.equal(graph.nodes[0].type, 'knit', 'snapshot must not mutate live design');
});

test('dimensions, stitch edits and imported snapshots reject invalid data', () => {
  assert.throws(() => create({cols: 1, rows: 5}), /dimensions/i);
  const graph = create({cols: 4, rows: 5});
  assert.throws(() => graph.setStitch(10, 0, 'knit'), /outside/i);
  assert.throws(() => graph.setStitch(1, 1, 'banana'), /type/i);
  const snapshot = graph.snapshot();
  assert.throws(() => knitModule.restoreKnit({...snapshot, version: 999}), /version/i);
  assert.throws(() => knitModule.restoreKnit({...snapshot, cells: ['knit']}), /cells/i);
  assert.throws(() => knitModule.restoreKnit({...snapshot, manualEdges: [{from: 's-0-0', to: 'absent', relation: 'manual'}]}), /edge/i);
});
