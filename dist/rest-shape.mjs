/** Rest-geometry brush, distinct from a temporary kinematic grab.
 * Coordinates and delta use the cloth model's metres; brush radius uses UV.
 * Existing local target/base length ratios survive the geometry edit.
 */
export function editRestShape(model, centerUV, delta, radius = 0.12) {
  if (!Array.isArray(centerUV) || centerUV.length !== 2 ||
      !centerUV.every(x => Number.isFinite(x) && x >= 0 && x <= 1)) {
    throw new RangeError('Brush center UV must be two finite values in [0, 1]');
  }
  if (!Array.isArray(delta) || delta.length !== 3 || !delta.every(Number.isFinite) || Math.hypot(...delta) > 0.25) {
    throw new RangeError('Brush displacement must be finite and at most 0.25 metres per edit');
  }
  if (!Number.isFinite(radius) || radius <= 0 || radius > 1) throw new RangeError('Brush radius must be in (0, 1]');
  const noChange = {changedVertices: 0, changedConstraints: 0, massDelta: 0};
  if (!delta.some(x => x !== 0)) return noChange;

  const changed = new Map();
  const proposed = Float64Array.from(model.rest);
  for (let i = 0; i < model.active.length; i++) {
    if (!model.active[i]) continue;
    let du = Math.abs(model.uv[2 * i] - centerUV[0]);
    if (model.kind === 'tube' || model.kind === 'stocking') du = Math.min(du, 1 - du);
    const distance = Math.hypot(du, model.uv[2 * i + 1] - centerUV[1]);
    if (distance >= radius) continue;
    const t = 1 - distance / radius;
    const weight = t * t * (3 - 2 * t);
    changed.set(i, weight);
    for (let k = 0; k < 3; k++) proposed[3 * i + k] += delta[k] * weight;
  }
  if (!changed.size) return noChange;

  const lengths = new Map();
  for (const constraint of model.constraints) {
    if (!changed.has(constraint.a) && !changed.has(constraint.b)) continue;
    if (constraint.kind === 'seam') continue;
    const a = 3 * constraint.a, b = 3 * constraint.b;
    const length = Math.hypot(proposed[a] - proposed[b], proposed[a + 1] - proposed[b + 1], proposed[a + 2] - proposed[b + 2]);
    if (length < 1e-9) throw new RangeError('Rest-shape brush creates a degenerate natural edge');
    lengths.set(constraint, length);
  }

  const oldMass = model.mass;
  for (const [i, weight] of changed) {
    for (let k = 0; k < 3; k++) {
      const offset = 3 * i + k;
      model.rest[offset] = proposed[offset];
      if (model.positions !== model.rest) model.positions[offset] += delta[k] * weight;
      model.velocities[offset] = 0;
    }
    const destination = [...model.positions.slice(3 * i, 3 * i + 3)];
    if (model.pins.has(i)) model.pinTargets.set(i, [...destination]);
    if (model.grabbed?.index === i) model.grabbed.target = [...destination];
  }
  for (const [constraint, length] of lengths) {
    const scale = constraint.restLength / constraint.baseRestLength;
    constraint.baseRestLength = length;
    constraint.restLength = length * scale;
  }
  for (const constraint of model.constraints) {
    if (changed.has(constraint.a) || changed.has(constraint.b)) constraint.lambda = 0;
  }
  model.regions.push({kind: 'rest-shape', centerUV: [...centerUV], delta: [...delta], radius});
  model._rebuildTopology();
  model._strainDirty = true;
  return {changedVertices: changed.size, changedConstraints: lengths.size, massDelta: model.mass - oldMass};
}
