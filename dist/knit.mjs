/** A semantic, bounded knit swatch. Coordinates are normalized, not millimetres.
 * Loop curves illustrate over/under ordering; they are not a yarn-contact solver.
 */
export class KnitGraph {
  constructor({cols = 8, rows = 9} = {}) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 64 || rows > 64) {
      throw new RangeError('Swatch dimensions must be integers from 2 to 64');
    }
    this.cols = cols;
    this.rows = rows;
    this.revision = 0;
    this._cells = Array.from({length: rows * cols}, () => 'knit');
    this._manual = [];
    this._rebuild();
  }

  _rebuild() {
    this.nodes = [];
    this.edges = [];
    this._issues = [];
    const dx = 0.9 / this.cols, dy = 0.9 / this.rows;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const type = this._cells[row * this.cols + col];
        if (!type) continue;
        const node = {id: `s-${row}-${col}`, row, col, type,
          x: (col - (this.cols - 1) / 2) * dx,
          y: (row - (this.rows - 1) / 2) * dy, z: 0};
        node.loopInputs = [];
        this.nodes.push(node);
      }
    }
    const byId = new Map(this.nodes.map(n => [n.id, n]));
    const held = Array.from({length: this.cols}, () => []);
    const yarnOrder = [];
    for (let row = 0; row < this.rows; row++) {
      // A conceptual eyelet transfers the held loop sideways before the course.
      // This is not an instruction valid for an arbitrary knitting machine.
      for (let col = 0; col < this.cols; col++) {
        if (this._cells[row * this.cols + col] !== 'eyelet') continue;
        const neighbour = col < this.cols - 1 ? col + 1 : col - 1;
        held[neighbour].push(...held[col]);
        held[col] = [];
        this._issues.push({code: 'EXPERIMENTAL_EYELET', severity: 'warning', nodeId: `s-${row}-${col}`,
          message: 'Held loops are redistributed sideways; transfer and recast-on feasibility require machine-specific checks.'});
      }
      for (let col = 0; col < this.cols; col++) {
        const node = byId.get(`s-${row}-${col}`);
        if (!node) {
          held[col] = [];
          this._issues.push({code: 'DELETED_LOOP_DROP_RISK', severity: 'error', nodeId: `s-${row}-${col}`,
            message: 'Removing a loop leaves an unverified dropped-loop boundary.'});
          continue;
        }
        if (node.type === 'miss' || node.type === 'eyelet') continue;
        node.loopInputs = [...held[col]];
        for (const from of held[col]) this.edges.push({from, to: node.id, relation: node.type});
        if (row > 0 && !held[col].length) this._issues.push({code: 'UNSUPPORTED_LOOP', severity: 'warning', nodeId: node.id,
          message: 'This loop needs a deliberate cast-on or transfer operation.'});
        held[col] = node.type === 'tuck' ? [...held[col], node.id] : [node.id];
      }
      const course = this.nodes.filter(n => n.row === row);
      if (row % 2) course.reverse();
      yarnOrder.push(...course);
    }
    yarnOrder.forEach((node, index) => {
      node.yarnPrev = yarnOrder[index - 1]?.id ?? null;
      node.yarnNext = yarnOrder[index + 1]?.id ?? null;
    });
    this.edges.push(...this._manual.map(e => ({...e})));
  }

  _index(row, col) {
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
      throw new RangeError('Stitch position is outside the swatch');
    }
    return row * this.cols + col;
  }

  setStitch(row, col, type) {
    if (!['knit', 'tuck', 'miss', 'eyelet'].includes(type)) throw new TypeError('Unknown stitch type');
    const index = this._index(row, col);
    this._cells[index] = type;
    this.revision++;
    this._rebuild();
    return this;
  }

  removeStitch(row, col) {
    this._cells[this._index(row, col)] = null;
    const id = `s-${row}-${col}`;
    this._manual = this._manual.filter(e => e.from !== id && e.to !== id);
    this.revision++;
    this._rebuild();
    return this;
  }

  connect(fromId, toId) {
    if (fromId === toId) throw new TypeError('A loop cannot support itself');
    const from = this.nodes.find(n => n.id === fromId), to = this.nodes.find(n => n.id === toId);
    if (!from || !to) throw new TypeError('Unknown stitch in support edge');
    if (!['knit', 'tuck'].includes(from.type) || !['knit', 'tuck'].includes(to.type)) {
      throw new TypeError('Support edges must join actual loops');
    }
    if (from.row >= to.row) throw new TypeError('Support edges must point forward to a later course');
    if (this.edges.some(e => e.from === fromId && e.to === toId)) throw new TypeError('Duplicate support edge');
    this._manual.push({from: fromId, to: toId, relation: 'manual'});
    this.revision++;
    this._rebuild();
    return this;
  }

  snapshot() {
    return {kind: 'knit-graph', version: 1, cols: this.cols, rows: this.rows,
      revision: this.revision, cells: [...this._cells], manualEdges: this._manual.map(e => ({...e})),
      manufacturing: 'experimental', calibrated: false};
  }

  supportLinks() { return this.edges.map(e => ({...e})); }

  _cellPoints(row, col) {
    const dx = 0.9 / this.cols, dy = 0.9 / this.rows;
    const x = (col - (this.cols - 1) / 2) * dx;
    const y = (row - (this.rows - 1) / 2) * dy;
    const depth = Math.min(dx, dy) * 0.12;
    const type = this._cells[row * this.cols + col];
    let shape = [
      [-0.5, -0.32, -0.35], [-0.37, -0.42, -0.7], [-0.22, -0.22, 0.1],
      [-0.2, 0.18, 0.8], [-0.31, 0.48, 0.8], [-0.26, 0.7, 0.25],
      [0, 0.8, -0.4], [0.26, 0.7, 0.25], [0.31, 0.48, 0.8],
      [0.2, 0.18, 0.8], [0.22, -0.22, 0.1], [0.37, -0.42, -0.7],
      [0.5, -0.32, -0.35]
    ];
    if (type === 'miss' || type === null) shape = [[-0.5, -0.32, -0.35], [0, -0.32, -0.6], [0.5, -0.32, -0.35]];
    if (type === 'eyelet') shape = [[-0.5, -0.32, -0.35], [-0.25, -0.58, -0.5], [0.25, -0.58, -0.5], [0.5, -0.32, -0.35]];
    if (type === 'tuck') shape = shape.map(([u, v, w]) => [u * 0.82, v * 1.18, -w]);
    return shape.map(([u, v, w]) => [x + u * dx, y + v * dy, w * depth]);
  }

  yarnPaths() {
    const points = [], nodeIds = [];
    for (let row = 0; row < this.rows; row++) {
      const course = [], ids = [];
      for (let col = 0; col < this.cols; col++) {
        course.push(...this._cellPoints(row, col));
        if (this._cells[row * this.cols + col]) ids.push(`s-${row}-${col}`);
      }
      if (row % 2) { course.reverse(); ids.reverse(); }
      if (points.length) {
        const a = points.at(-1), b = course[0];
        for (let step = 1; step < 6; step++) {
          const t = step / 6;
          points.push(a.map((v, i) => v + (b[i] - v) * t));
        }
      }
      points.push(...course);
      nodeIds.push(...ids);
    }
    return [{id: 'working-yarn', points, nodeIds}];
  }

  validate() {
    const issues = [...this._issues, {code: 'BOUNDARY_FINISH_UNMODELED', severity: 'warning',
      message: 'Cast-on, bind-off and yarn ends are conceptual boundaries; machine instructions are unverified.'}];
    const nodes = new Map(this.nodes.map(n => [n.id, n]));
    const seen = new Set();
    for (const edge of this.edges) {
      const from = nodes.get(edge.from), to = nodes.get(edge.to);
      if (!from || !to) issues.push({code: 'DANGLING_SUPPORT', severity: 'error', message: 'A support endpoint is missing.'});
      else if (![from, to].every(n => n.type === 'knit' || n.type === 'tuck')) {
        issues.push({code: 'NON_LOOP_SUPPORT', severity: 'error', nodeId: to.id,
          message: 'A support edge is attached to a float or opening; reconnect it to an actual loop.'});
      }
      const key = `${edge.from}|${edge.to}`;
      if (seen.has(key)) issues.push({code: 'DUPLICATE_SUPPORT', severity: 'error', message: 'Support edges overlap after the edit.'});
      seen.add(key);
    }
    return {valid: !issues.some(i => i.severity === 'error'), issues,
    manufacturing: 'experimental'};
  }

  stats() {
    const points = this.yarnPaths()[0].points;
    let yarnLength = 0;
    for (let i = 1; i < points.length; i++) {
      yarnLength += Math.hypot(...points[i].map((v, j) => v - points[i - 1][j]));
    }
    return {loops: this.nodes.filter(n => n.type === 'knit' || n.type === 'tuck').length,
      stitches: this.nodes.length, openings: this._cells.filter(type => type === 'eyelet' || type === null).length,
      yarnLength, yarnLengthUnit: 'normalized swatch units', manufacturing: 'experimental', calibrated: false,
      revision: this.revision};
  }
}

export function createKnit(options) { return new KnitGraph(options); }

export function restoreKnit(snapshot) {
  if (!snapshot || snapshot.kind !== 'knit-graph' || snapshot.version !== 1) throw new TypeError('Unsupported knit graph version');
  const graph = new KnitGraph({cols: snapshot.cols, rows: snapshot.rows});
  if (!Array.isArray(snapshot.cells) || snapshot.cells.length !== graph.cols * graph.rows ||
      !snapshot.cells.every(type => type === null || ['knit', 'tuck', 'miss', 'eyelet'].includes(type))) {
    throw new TypeError('Invalid knit graph cells');
  }
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new TypeError('Invalid graph revision');
  if (!Array.isArray(snapshot.manualEdges)) throw new TypeError('Invalid manual edges');
  graph._cells = [...snapshot.cells];
  graph._rebuild();
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const seen = new Set();
  for (const edge of snapshot.manualEdges) {
    const from = byId.get(edge?.from), to = byId.get(edge?.to);
    const key = `${edge?.from}|${edge?.to}`;
    if (!from || !to || from.row >= to.row || edge.relation !== 'manual' || seen.has(key)) {
      throw new TypeError('Invalid manual support edge');
    }
    seen.add(key);
    graph._manual.push({from: edge.from, to: edge.to, relation: 'manual'});
  }
  graph.revision = snapshot.revision;
  graph._rebuild();
  return graph;
}
