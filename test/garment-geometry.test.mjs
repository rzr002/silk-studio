import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../dist/garment-geometry.mjs').catch(() => ({}));
function stocking(options) {
  assert.equal(typeof api.createStocking, 'function', 'complete stocking geometry factory must exist');
  return api.createStocking(options);
}
const distance = (p, a, b) => Math.hypot(...[0, 1, 2].map(k => p[3 * a + k] - p[3 * b + k]));
function meshEdges(indices) {
  const edges = new Map();
  for (let j = 0; j < indices.length; j += 3) for (let k = 0; k < 3; k++) {
    const a = indices[j + k], b = indices[j + (k + 1) % 3], key = `${Math.min(a, b)},${Math.max(a, b)}`;
    edges.set(key, (edges.get(key) || 0) + 1);
  }
  return edges;
}

test('complete stocking has a closed toe and exactly one cuff boundary', () => {
  const model = stocking({cols: 24, rows: 36});
  assert.equal(model.kind, 'stocking');
  assert.equal(model.gridVertexCount, 24 * 36);
  const capNodes=1+[.25,.5,.75].reduce((sum,fraction)=>sum+Math.max(6,Math.round(model.cols*fraction)),0);
  assert.equal(model.positions.length / 3, model.gridVertexCount+capNodes);
  assert.equal(model.boundary.size, 24);
  assert.ok([...model.boundary].every(i => i >= 24 * 35));
  const edges = meshEdges(model.triangles);
  assert.ok([...edges.values()].every(count => count <= 2));
  assert.equal(model.positions.length/3 - edges.size + model.triangles.length / 3, 1);
  assert.ok(model.mass > 0 && Number.isFinite(model.mass));
  assert.ok(model.constraints.every(c => c.restLength > 0 && Number.isFinite(c.restLength)));
});

test('toe, foot and heel are metre-scale shaped geometry with editable dimensions', () => {
  const model = stocking();
  assert.ok(model.rest.every(Number.isFinite));
  const toe = api.stockingSurface(0, 0, api.DEFAULT_DIMENSIONS);
  const heel = api.stockingSurface(0.5, 0.26, api.DEFAULT_DIMENSIONS);
  const ankle = api.stockingSurface(0, 0.36, api.DEFAULT_DIMENSIONS);
  assert.ok(toe[2] - heel[2] > 0.15, 'toe must extend forward from heel');
  assert.ok(ankle[1] > toe[1], 'ankle rises from a horizontal foot');
  const longer = api.stockingSurface(0, 0, {...api.DEFAULT_DIMENSIONS, footLength: 0.29});
  assert.ok(longer[2] - toe[2] > 0.04);
  const deeperHeel = api.stockingSurface(0.5, 0.26, {...api.DEFAULT_DIMENSIONS, heelDepth: 0.08});
  assert.ok(Math.hypot(...heel.map((x, k) => x - deeperHeel[k])) > 0.01);
  assert.ok(model.garment.regions.some(r => r.name === 'heel'));
  assert.ok(model.garment.regions.some(r => r.name === 'cuff'));
  assert.equal(model.garment.manufacturing, 'unverified');
});

test('cuff has distinct natural width and elastic parameters', () => {
  const model = stocking({cols: 24, rows: 36});
  const cuff = model.constraints.filter(c => c.region === 'cuff' && c.kind === 'weft');
  const thigh = model.constraints.filter(c => c.region === 'thigh' && c.kind === 'weft');
  assert.ok(cuff.length && thigh.length);
  assert.ok(cuff[0].compliance < thigh[0].compliance);
  const rowCirc = row => Array.from({length: model.cols}, (_, c) => distance(model.rest, row * model.cols + c, row * model.cols + (c + 1) % model.cols)).reduce((a, b) => a + b, 0);
  assert.ok(rowCirc(model.rows - 1) < rowCirc(Math.round(0.82 * (model.rows - 1))));
});

test('wear initialization preserves all natural lengths and updates cuff pins', () => {
  const model = stocking({cols: 24, rows: 36});
  const rest = [...model.rest], lengths = model.constraints.map(c => c.restLength);
  api.fitStocking(model, {pose: 30});
  assert.deepEqual([...model.rest], rest);
  assert.deepEqual(model.constraints.map(c => c.restLength), lengths);
  assert.notDeepEqual([...model.positions], rest);
  for (const i of model.pins) assert.deepEqual(model.pinTargets.get(i), [...model.positions.slice(3 * i, 3 * i + 3)]);
});

test('visible mannequin mesh is closed and dimensions and poses reject nonfinite inputs', () => {
  stocking();
  const mesh = api.bodyGeometryData({cols: 24, rows: 36, pose: 55});
  const edges = meshEdges(mesh.indices);
  assert.equal(mesh.positions.length / 3 - edges.size + mesh.indices.length / 3, 2);
  assert.ok([...edges.values()].every(count => count === 2));
  assert.ok(mesh.positions.every(Number.isFinite));
  assert.throws(() => stocking({dimensions: {footLength: Infinity}}), /dimension|尺寸/i);
  assert.throws(() => api.bodySurface(0, 0.5, {pose: 100}), /pose|角度/i);
});

test('foot-to-ankle sweep retains outward side faces without folding through its centerline', () => {
  stocking();
  for (const pose of [0, 55]) {
  const mesh = api.bodyGeometryData({pose});
  for (let j = 0; j < mesh.cols * (mesh.rows - 1) * 6; j += 3) {
    const ids = mesh.indices.slice(j, j + 3), p = ids.map(i => mesh.positions.slice(i * 3, i * 3 + 3));
    const a = p[1].map((x, k) => x - p[0][k]), b = p[2].map((x, k) => x - p[0][k]);
    const normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const v = ids.reduce((sum, i) => sum + mesh.uv[i * 2 + 1] / 3, 0), f = api.bodyFrame(v, {pose});
    const radial = [0, 1, 2].map(k => (p[0][k] + p[1][k] + p[2][k]) / 3 - [f.x, f.y, f.z][k]);
    assert.ok(normal.reduce((sum, x, k) => sum + x * radial[k], 0) > 0, `inverted side face at v=${v}`);
  }
  }
});

test('closed toe coverage checks body tip volume rather than projected ring winding',()=>{
  const model=stocking();api.fitStocking(model);
  assert.equal(typeof api.stockingToeCoverage,'function','toe coverage must include axial enclosure');
  const initial=api.stockingToeCoverage(model);assert.equal(initial.applicable,true);assert.equal(initial.covered,true);assert.equal(initial.uncoveredProbes,0);
  const frame=api.bodyFrame(0),normal=[0,-frame.ty,-frame.tz],before=[...model.positions.slice(0,3)];
  const capIndices=[...Array.from({length:model.cols},(_,i)=>i),...(model.metadata.toeCap.vertices||[])];
  for(const index of capIndices)for(let k=0;k<3;k++)model.positions[index*3+k]-=normal[k]*.05;
  const after=api.stockingToeCoverage(model);
  assert.equal(after.covered,false,'a cap retracted into the foot must expose the body tip');
  assert.ok(after.uncoveredProbes>0);
  assert.ok(after.meanCapAxial<-.03);
  const radialDelta=(model.positions[1]-before[1])*frame.ny+(model.positions[2]-before[2])*frame.nz;
  assert.ok(Math.abs(radialDelta)<1e-10,'projected ring radius is unchanged, so winding alone misses this');
});

test('toe coverage distinguishes actual body samples from an optional axial numerical clearance',()=>{
  const model=stocking();api.fitStocking(model,{margin:.00005});
  const clearance=api.stockingToeCoverage(model),surface=api.stockingToeCoverage(model,{probeOffsetM:0}),inset=api.stockingToeCoverage(model,{probeOffsetM:-.00001});
  assert.equal(clearance.covered,false,'50µm of real coverage must not satisfy the unchanged default 500µm clearance test');
  assert.equal(clearance.probeOffsetM,.0005);assert.equal(clearance.coverageScope,'sampled-toe-tip-clearance');
  assert.equal(surface.covered,true,'a thin positive gap still covers the actual mannequin toe surface');
  assert.equal(surface.probeOffsetM,0);assert.equal(surface.coverageScope,'sampled-body-toe-tip');
  assert.equal(inset.covered,true);assert.equal(inset.coverageScope,'sampled-body-toe-inset');
  assert.equal(surface.scope,'toe-tip-volume');assert.equal(surface.manufacturing,'unverified');
  const f=api.bodyFrame(0),normal=[0,-f.ty,-f.tz],cap=[...Array.from({length:model.cols},(_,i)=>i),...model.metadata.toeCap.vertices];
  for(const i of cap)for(let k=0;k<3;k++)model.positions[i*3+k]-=normal[k]*.001;
  assert.equal(api.stockingToeCoverage(model,{probeOffsetM:0}).covered,false,'the real-body test must still detect an actually retracted toe');
});

test('toe coverage rejects nonfinite and excessive probe offsets',()=>{
  const model=stocking();api.fitStocking(model);
  for(const probeOffsetM of [NaN,Infinity,-Infinity,null,'0',-.00101,.00301])assert.throws(()=>api.stockingToeCoverage(model,{probeOffsetM}),/offset|probe/i);
  for(const probeOffsetM of [-.001,0,.003])assert.equal(api.stockingToeCoverage(model,{probeOffsetM}).probeOffsetM,probeOffsetM);
});

test('toe closure uses a free center and uniform free rings with short local links',()=>{
  const model=stocking(),center=model.vertexIds.indexOf('toe-center');
  assert.equal(center,model.gridVertexCount);
  assert.equal(model.layout,'edited-grid');assert.equal(model.sourceVertices[center],0);
  assert.equal(model.pins.has(center),false,'toe center must stay a free physical degree of freedom');
  const spokes=model.constraints.filter(c=>c.kind==='toe-cap');assert.ok(spokes.length>model.cols*3);
  assert.ok(spokes.every(c=>c.restLength<.008),'local closure links must not span the entire toe disk');
  const capNodes=model.metadata.toeCap.vertices;assert.equal(capNodes.length,61);
  assert.ok(capNodes.every(index=>!model.pins.has(index)&&model.inverseMass[index]>0),'every interior node remains a massive free degree of freedom');
  const toeFaces=[];for(let j=0;j<model.triangles.length;j+=3){const face=model.triangles.slice(j,j+3);if(face.every(i=>model.uv[i*2+1]===0))toeFaces.push(face);}
  assert.equal(toeFaces.length,model.cols+2*capNodes.length-2);
  assert.ok(toeFaces.some(face=>!face.includes(center)),'outer disk has independent contact nodes');
  const naturalFrame=api.bodyFrame(0,{dimensions:model.dimensions}),outward=[0,-naturalFrame.ty,-naturalFrame.tz];
  for(const face of toeFaces){const p=face.map(i=>[...model.rest.slice(i*3,i*3+3)]),a=p[1].map((x,k)=>x-p[0][k]),b=p[2].map((x,k)=>x-p[0][k]),normal=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];assert.ok(normal.reduce((sum,x,k)=>sum+x*outward[k],0)>1e-12,'every local closure triangle must have positive area and outward orientation');}
  assert.equal(model.garment.finishing.toeCap.method,'free-center-fan');
  api.fitStocking(model,{pose:55});const f=api.bodyFrame(0,{pose:55}),normal=[0,-f.ty,-f.tz];
  for(let k=0;k<3;k++)assert.ok(Math.abs(model.positions[center*3+k]-[f.x,f.y,f.z][k]-normal[k]*.003)<1e-10,'fitting puts center at the numerical toe stand-off, not the circumference');
  assert.equal(model.garment.numericalStandOff.fitting,.003);assert.equal(model.garment.numericalStandOff.contact,.001);assert.equal(model.garment.numericalStandOff.calibrated,false);
});

test('toe closure resists local folding through adjacent-face bend distances without pinning its surface',()=>{
  const model=stocking(),auxiliary=new Set(model.metadata.toeCap.vertices),edges=new Map();
  for(let j=0;j<model.triangles.length;j+=3)for(let k=0;k<3;k++){
    const a=model.triangles[j+k],b=model.triangles[j+(k+1)%3],opposite=model.triangles[j+(k+2)%3],key=`${Math.min(a,b)},${Math.max(a,b)}`;
    if(!edges.has(key))edges.set(key,{a,b,opposites:[],cap:false});
    const edge=edges.get(key);edge.opposites.push(opposite);edge.cap ||= auxiliary.has(opposite)||auxiliary.has(a)||auxiliary.has(b);
  }
  const bends=new Map(model.constraints.filter(c=>c.kind==='bend').map(c=>[`${Math.min(c.a,c.b)},${Math.max(c.a,c.b)}`,c]));
  let hinges=0;
  for(const edge of edges.values())if(edge.cap&&edge.opposites.length===2){
    const [a,b]=edge.opposites,key=`${Math.min(a,b)},${Math.max(a,b)}`;
    assert.ok(bends.has(key),`cap hinge ${edge.a},${edge.b} has no bending support`);hinges++;
  }
  assert.ok(hinges>200,'interior and cap-to-sidewall hinges both need local bending support');
  const edge=[...edges.values()].find(e=>e.cap&&e.opposites.length===2&&auxiliary.has(e.a)&&auxiliary.has(e.b));
  const [a,b]=edge.opposites,hingeA=model.rest.slice(edge.a*3,edge.a*3+3),hingeB=model.rest.slice(edge.b*3,edge.b*3+3),p=model.rest.slice(a*3,a*3+3);
  const axis=hingeB.map((x,k)=>x-hingeA[k]),length=Math.hypot(...axis),unit=axis.map(x=>x/length),r=p.map((x,k)=>x-hingeA[k]),dot=r.reduce((sum,x,k)=>sum+x*unit[k],0),cross=[unit[1]*r[2]-unit[2]*r[1],unit[2]*r[0]-unit[0]*r[2],unit[0]*r[1]-unit[1]*r[0]],angle=Math.PI/3;
  const folded=r.map((x,k)=>hingeA[k]+x*Math.cos(angle)+cross[k]*Math.sin(angle)+unit[k]*dot*(1-Math.cos(angle)));
  assert.ok(Math.abs(Math.hypot(...folded.map((x,k)=>x-hingeA[k]))-Math.hypot(...r))<1e-12,'a hinge fold preserves the triangle edge lengths');
  const bend=bends.get(`${Math.min(a,b)},${Math.max(a,b)}`),opposite=model.rest.slice(b*3,b*3+3);
  assert.ok(Math.abs(Math.hypot(...folded.map((x,k)=>x-opposite[k]))-bend.restLength)>.0001,'the same fold must produce a bending residual');
  assert.ok(model.metadata.toeCap.vertices.every(i=>!model.pins.has(i)));
  assert.equal(model.garment.finishing.toeCap.bendingStatus,'experimental-distance-hinges');
});

test('rigid mannequin toe cap samples its interior without changing the closed end-plane solid',()=>{
  for(const pose of [0,55]){
    const mesh=api.bodyGeometryData({pose}),base=mesh.gridVertexCount,f=api.bodyFrame(0,{pose}),normal=[0,-f.ty,-f.tz];
    assert.equal(mesh.positions.length/3-base,61,'symmetric contact needs interior body points, not only a perimeter');
    assert.deepEqual(mesh.positions.slice(base*3,base*3+3),[f.x,f.y,f.z]);
    const capFaces=[];for(let j=0;j<mesh.indices.length;j+=3){const face=mesh.indices.slice(j,j+3);if(face.every(i=>mesh.uv[i*2+1]===0))capFaces.push(face);}
    assert.equal(capFaces.length,160);
    let area=0;
    for(const ids of capFaces){const p=ids.map(i=>mesh.positions.slice(i*3,i*3+3)),a=p[1].map((x,k)=>x-p[0][k]),b=p[2].map((x,k)=>x-p[0][k]),cross=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];area+=Math.hypot(...cross)/2;assert.ok(cross.reduce((sum,x,k)=>sum+x*normal[k],0)>1e-12);assert.ok(ids.every(i=>Math.abs(normal.reduce((sum,x,k)=>sum+x*(mesh.positions[i*3+k]-[f.x,f.y,f.z][k]),0))<1e-12));assert.ok(Math.max(...ids.map((i,k)=>distance(mesh.positions,i,ids[(k+1)%3])))<.008);}
    const expected=.5*mesh.cols*Math.sin(2*Math.PI/mesh.cols)*f.rx*f.rn;
    assert.ok(Math.abs(area-expected)<1e-12,'refinement must preserve the exact original polygonal cap area');
    const edges=meshEdges(mesh.indices);assert.equal(mesh.positions.length/3-edges.size+mesh.indices.length/3,2);assert.ok([...edges.values()].every(count=>count===2));
  }
});
