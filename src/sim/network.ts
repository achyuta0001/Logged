/**
 * Storm-drain network for the dual-drainage approximation (minor system = drains, major system =
 * the 2D surface in core.ts). Water the inlets capture no longer vanishes: it enters the drain
 * cell (node) nearest to where it was captured, travels downstream along the drain lines and
 * through tanks, and leaves at the grid edge. Where more arrives than a reach can carry, the reach
 * fills and the excess surcharges back onto the street at that cell.
 *
 *  - Nodes: drainMask cells and tank (lakeMask) cells. Topology: a priority flood over the nodes
 *    (8-neighbour) seeded at the grid edge, so each node drains along the lowest path. Edge cells
 *    are lazy seeds: they only become outlets when no lower path reaches them first, and never
 *    where the line falls away from the edge (a node within 3 cells lies gapRiseM lower): there
 *    the edge is the line's upstream end, and its water flows inward to the line's low end instead
 *    of climbing back out (in 560098 the Vrishabhavathi trunk otherwise left 43 m uphill).
 *  - Gaps: a line or tank that has no path to the edge is joined to a lower node within 3 cells as
 *    a culvert (road crossings are where OSM drain lines usually break); one that stops within
 *    3 cells of the grid edge leaves the grid there (lines are clipped at the pack's bbox). Any
 *    other end is where the mapped channel stops: it is assumed to continue unmapped through a
 *    culvert-sized link, and what that cannot pass overflows at the end. Culverts carry half the
 *    reach's design flow.
 *  - Capacity (rational method): each drain reach is sized for the design intensity over the area
 *    its inlets serve upstream, at the reach's time of concentration
 *    (q = capacity x (1 - blockage) x (t0 / tc)^k, tc = t0 + longest upstream channel / v). Trunk
 *    reaches therefore carry less per hectare than local drains: short bursts pass, long heavy
 *    storms overload the trunks first, as in the valleys.
 *  - Routing: per node a linear reservoir, outflow = S v / L (equal to the design flow when full,
 *    S = Smax = Q L / v), sub-stepped at dt <= L / v and swept downstream-first so water moves at
 *    most one reach per sub-step. Storage above Smax surcharges onto the surface at the node.
 *  - Inlets only take what their node has room for (a full drain takes no more street water);
 *    capture beyond the network's reach (no mapped drain within the serve radius) leaves the model
 *    as before (core.ts books it as drained).
 *  - Tanks: a tank is one node (one level). Water reaching it fills its flood cushion (shared with
 *    core.ts) first, then passes on through the drain that leaves it (the weir). While that drain
 *    is full the tank backs up by up to lakeRiseM; once that is full too, the drains feeding it back
 *    up and overflow near it. Water standing on a tank (rain, runoff from its banks) is offered to
 *    the tank node, room permitting. A tank with no mapped outflow drains through its (unmapped)
 *    weir like any other line end.
 * Everything is Float64 and mass-exact: captured = storage + outflow (grid edge and unmapped line
 * ends) + into tank cushions + returned to the surface.
 */

/** tuning (exported for experiments) */
export const NET_TUNING = {
  /** full-flow velocity in the drains, m/s (routing speed and channel storage) */
  velocity: 1.0,
  /** inlet time of the smallest drains, s (time of concentration at the top of the network) */
  inletTimeS: 15 * 60,
  /** design intensity ~ tc^-k (IDF slope over 15 min .. 3 h) */
  idfExp: 0.5,
  /** search radius (cells) to join a dangling line to a lower node */
  gapCells: 3,
  /** a joined gap may climb this much (m): DEM noise along the channel */
  gapRiseM: 0.5,
  /** conveyance of a joined gap (culvert) relative to the reach's design flow */
  culvertFactor: 0.5,
  /** rise of a tank above its waste weir before it spills over its bund (bund freeboard), m */
  lakeRiseM: 1.0,
};

const INTERIOR = 0, EDGE = 1, DEAD = 2; // DEAD = mapped line ends: continues unmapped (culvert-sized)
const EPS_M3 = 1e-6;

export interface NetworkGrids {
  w: number;
  h: number;
  dx: number;
  z: Float64Array;
  drainMask: Uint8Array;
  /** lake component per cell (-1 = none) */
  lakeComp: Int32Array;
  /** free tank storage per component, m3 (shared with the surface model, mutated) */
  lakeRoom: Float64Array;
  /** cells around a node whose inlets feed it */
  serveRadiusCells: number;
}

/** cumulative network budget, m3 */
export interface NetworkTotals {
  /** captured by inlets into the network */
  inflow: number;
  /** captured where no mapped drain is in reach, plus core.ts's post-storm pond drainage (both leave the model) */
  sink: number;
  /** pushed back onto the street at bottlenecks and dead ends */
  surcharge: number;
  /** spilled onto a tank's surface (tank full and its outflow blocked, or no outflow) */
  lakeSurface: number;
  /** stored in tank flood cushions */
  lake: number;
  /** discharged across the grid edge or through unmapped line ends */
  out: number;
}

/** small binary min-heap of (priority, value) */
class Heap {
  private p: Float64Array;
  private v: Int32Array;
  size = 0;
  /** priority of the last pop */
  top = 0;
  constructor(cap: number) {
    this.p = new Float64Array(Math.max(1, cap));
    this.v = new Int32Array(Math.max(1, cap));
  }
  push(pri: number, val: number): void {
    if (this.size === this.p.length) {
      const p = new Float64Array(this.size * 2), v = new Int32Array(this.size * 2);
      p.set(this.p);
      v.set(this.v);
      this.p = p;
      this.v = v;
    }
    let i = this.size++;
    const P = this.p, V = this.v;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (P[up] <= pri) break;
      P[i] = P[up];
      V[i] = V[up];
      i = up;
    }
    P[i] = pri;
    V[i] = val;
  }
  pop(): number {
    const P = this.p, V = this.v;
    const val = V[0];
    this.top = P[0];
    const n = --this.size;
    if (n > 0) {
      const lp = P[n], lv = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && P[c + 1] < P[c]) c++;
        if (P[c] >= lp) break;
        P[i] = P[c];
        V[i] = V[c];
        i = c;
      }
      P[i] = lp;
      V[i] = lv;
    }
    return val;
  }
}

export class DrainNetwork {
  /** number of nodes */
  readonly size: number;
  /** cell of each node; nodes are stored downstream-first (every node after its downstream node) */
  readonly cell: Int32Array;
  readonly kind: Uint8Array;
  /** downstream node (INTERIOR), -1 otherwise */
  readonly down: Int32Array;
  /** link length, m */
  readonly len: Float64Array;
  /** tank component of a tank node, -1 for drain nodes */
  readonly lakeOf: Int32Array;
  /** joined gap (culvert) leaving the node */
  readonly culvert: Uint8Array;
  /** area served upstream x (t0 / tc)^k x culvert factor, m2 (design flow = intensity x this) */
  readonly designArea: Float64Array;
  /** area whose inlets feed the node or its upstream, m2 (diagnostics) */
  readonly areaUp: Float64Array;
  /** node fed by each cell's inlets (-1: none, the capture leaves the model) */
  readonly cellNode: Int32Array;
  /** storage, m3 */
  readonly S: Float64Array;
  totals: NetworkTotals = { inflow: 0, sink: 0, surcharge: 0, lakeSurface: 0, lake: 0, out: 0 };
  private lakeRoom: Float64Array;
  private A: number;
  private Smax: Float64Array;
  private qmax: Float64Array; // m3/s through the node's outlet
  private want: Float64Array; // per-step scratch, m3
  private took: Float64Array;
  private rcell: Float64Array; // per-cell capture demand this step, m
  private tankCell: Uint8Array; // cell is part of a tank (its water is the network's: no inlet limit)
  private tankStart: Int32Array; // tank c's cells are tankCells[tankStart[c] .. tankStart[c + 1])
  private tankCells: Int32Array;
  private feedStart: Int32Array; // cells feeding node k are feedCells[feedStart[k] .. feedStart[k + 1])
  private feedCells: Int32Array;
  private intensity = -1; // m/s the capacity arrays were built for
  private lUp: Float64Array; // longest channel above each node, m
  private dtSub: number;

  constructor(g: NetworkGrids) {
    const { w, h: H, dx, z, drainMask, lakeComp } = g;
    const n = w * H;
    this.A = dx * dx;
    this.lakeRoom = g.lakeRoom;
    const isNode = (i: number) => drainMask[i] === 1 || lakeComp[i] >= 0;
    const all: number[] = [];
    for (let i = 0; i < n; i++) if (isNode(i)) all.push(i);
    // ---- topology: priority flood from the edge (lazy seeds), then culvert joins / dead ends
    const SEED = 1 << 30;
    const visited = new Uint8Array(n);
    const downCell = new Int32Array(n).fill(-1);
    const kindCell = new Uint8Array(n);
    const culvert = new Uint8Array(n);
    const order: number[] = [];
    const heap = new Heap(all.length * 2 + 16);
    for (const i of all) {
      const r = (i / w) | 0, c = i % w;
      if (r === 0 || c === 0 || r === H - 1 || c === w - 1) heap.push(z[i], i | SEED);
    }
    const byZ = all.slice().sort((a, b) => z[a] - z[b]);
    let lowest = 0;
    const gap = Math.max(0, Math.round(NET_TUNING.gapCells));
    const fallsInward = (k: number) => {
      const r0 = (k / w) | 0, c0 = k % w, zLow = z[k] - NET_TUNING.gapRiseM;
      for (let dr = -gap; dr <= gap; dr++)
        for (let dc = -gap; dc <= gap; dc++) {
          const rr = r0 + dr, cc = c0 + dc;
          if (rr < 0 || cc < 0 || rr >= H || cc >= w) continue;
          const j = rr * w + cc;
          if (isNode(j) && z[j] < zLow) return true;
        }
      return false;
    };
    for (;;) {
      while (heap.size) {
        const e = heap.pop();
        let P = heap.top;
        const k = e & (SEED - 1);
        if (e & SEED) {
          if (visited[k]) continue; // reached first from a lower outlet: not an outlet
          if (fallsInward(k)) continue; // the line's upstream end: reached from below, or a dead end
          visited[k] = 1;
          kindCell[k] = EDGE;
          order.push(k);
          P = z[k];
        }
        const r = (k / w) | 0, c = k % w;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if ((!dr && !dc) || rr < 0 || cc < 0 || rr >= H || cc >= w) continue;
            const j = rr * w + cc;
            if (visited[j] || !isNode(j)) continue;
            visited[j] = 1;
            downCell[j] = k;
            kindCell[j] = INTERIOR;
            order.push(j);
            heap.push(z[j] > P ? z[j] : P, j);
          }
      }
      // lowest node not yet reached: a line or tank with no path to the edge
      while (lowest < byZ.length && visited[byZ[lowest]]) lowest++;
      if (lowest >= byZ.length) break;
      const t = byZ[lowest];
      visited[t] = 1;
      order.push(t);
      // join it to a lower node nearby (culvert under a road / unmapped gap) or leave it a dead end
      const r0 = (t / w) | 0, c0 = t % w;
      let best = -1, bestD = Infinity;
      for (let dr = -gap; dr <= gap; dr++)
        for (let dc = -gap; dc <= gap; dc++) {
          const rr = r0 + dr, cc = c0 + dc;
          if (rr < 0 || cc < 0 || rr >= H || cc >= w) continue;
          const j = rr * w + cc;
          if (!visited[j] || j === t || !isNode(j) || kindCell[j] === DEAD || z[j] > z[t] + NET_TUNING.gapRiseM) continue;
          const d = dr * dr + dc * dc + (z[j] - z[t]) * 1e-6;
          if (d < bestD) { bestD = d; best = j; }
        }
      if (best >= 0) {
        downCell[t] = best;
        kindCell[t] = INTERIOR;
        culvert[t] = 1;
      } else if (r0 < gap || c0 < gap || r0 >= H - gap || c0 >= w - gap) kindCell[t] = EDGE;
      else {
        kindCell[t] = DEAD;
        culvert[t] = 1;
      }
      heap.push(z[t], t);
    }

    // ---- node arrays in downstream-first order. A tank has one level, so it is one node: the cell
    // where the flood entered it (its outlet), standing for all its cells.
    const nTanks = g.lakeRoom.length;
    const rep = new Int32Array(Math.max(1, nTanks)).fill(-1);
    const keep: number[] = [];
    for (const i of order) {
      const lc = lakeComp[i];
      if (lc < 0) keep.push(i);
      else if (rep[lc] < 0) { rep[lc] = i; keep.push(i); }
    }
    const N = (this.size = keep.length);
    const id = new Int32Array(n).fill(-1);
    keep.forEach((cIdx, k) => (id[cIdx] = k));
    const nodeOf = (i: number) => (lakeComp[i] >= 0 ? id[rep[lakeComp[i]]] : id[i]);
    this.cell = Int32Array.from(keep);
    this.kind = new Uint8Array(N);
    this.down = new Int32Array(N).fill(-1);
    this.len = new Float64Array(N);
    this.lakeOf = new Int32Array(N).fill(-1);
    this.culvert = new Uint8Array(N);
    for (let k = 0; k < N; k++) {
      const i = keep[k];
      this.kind[k] = kindCell[i];
      this.lakeOf[k] = lakeComp[i];
      this.culvert[k] = culvert[i];
      if (kindCell[i] === INTERIOR) {
        const j = downCell[i];
        this.down[k] = nodeOf(j);
        const dr = ((j / w) | 0) - ((i / w) | 0), dc = (j % w) - (i % w);
        this.len[k] = Math.hypot(dr, dc) * dx;
      } else this.len[k] = dx;
    }
    // cells of each tank (spills spread over the whole tank)
    this.tankStart = new Int32Array(nTanks + 1);
    for (let i = 0; i < n; i++) if (lakeComp[i] >= 0) this.tankStart[lakeComp[i] + 1]++;
    for (let c = 0; c < nTanks; c++) this.tankStart[c + 1] += this.tankStart[c];
    this.tankCells = new Int32Array(this.tankStart[nTanks]);
    const fillAt = this.tankStart.slice(0, nTanks);
    for (let i = 0; i < n; i++) if (lakeComp[i] >= 0) this.tankCells[fillAt[lakeComp[i]]++] = i;

    // ---- which node each cell's inlets feed: nearest node within the serve radius (4-neighbour BFS)
    const cellNode = (this.cellNode = new Int32Array(n).fill(-1));
    const dist = new Int32Array(n).fill(-1);
    const q = new Int32Array(n);
    let qh = 0, qt = 0;
    for (const i of order) {
      cellNode[i] = nodeOf(i);
      dist[i] = 0;
      q[qt++] = i;
    }
    const maxSteps = Math.max(1, g.serveRadiusCells);
    while (qh < qt) {
      const i = q[qh++];
      if (dist[i] >= maxSteps) continue;
      const r = (i / w) | 0, c = i % w;
      for (let e = 0; e < 4; e++) {
        const j = e === 0 ? (c + 1 < w ? i + 1 : -1) : e === 1 ? (c > 0 ? i - 1 : -1) : e === 2 ? (r + 1 < H ? i + w : -1) : r > 0 ? i - w : -1;
        if (j < 0 || dist[j] >= 0) continue;
        dist[j] = dist[i] + 1;
        cellNode[j] = cellNode[i];
        q[qt++] = j;
      }
    }

    // cells feeding each node (to hand back what a full node refused)
    this.feedStart = new Int32Array(N + 1);
    for (let i = 0; i < n; i++) if (cellNode[i] >= 0) this.feedStart[cellNode[i] + 1]++;
    for (let k = 0; k < N; k++) this.feedStart[k + 1] += this.feedStart[k];
    this.feedCells = new Int32Array(this.feedStart[N]);
    const feedAt = this.feedStart.slice(0, N);
    for (let i = 0; i < n; i++) if (cellNode[i] >= 0) this.feedCells[feedAt[cellNode[i]]++] = i;

    // ---- design: area served upstream and the longest channel above each node (upstream-first sweep)
    const A = this.A;
    const areaUp = (this.areaUp = new Float64Array(N));
    const lUp = (this.lUp = new Float64Array(N));
    for (let i = 0; i < n; i++) if (cellNode[i] >= 0) areaUp[cellNode[i]] += A;
    for (let k = N - 1; k >= 0; k--) {
      const d = this.down[k];
      if (d < 0) continue;
      areaUp[d] += areaUp[k];
      const l = lUp[k] + this.len[k];
      if (l > lUp[d]) lUp[d] = l;
    }
    const t0 = NET_TUNING.inletTimeS, v = NET_TUNING.velocity;
    this.designArea = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const tc = t0 + lUp[k] / v;
      const cf = this.culvert[k] ? NET_TUNING.culvertFactor : 1;
      this.designArea[k] = areaUp[k] * Math.pow(t0 / tc, NET_TUNING.idfExp) * cf;
    }
    this.S = new Float64Array(N);
    this.Smax = new Float64Array(N);
    this.qmax = new Float64Array(N);
    this.want = new Float64Array(N);
    this.took = new Float64Array(N);
    this.rcell = new Float64Array(n);
    this.tankCell = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (lakeComp[i] >= 0) this.tankCell[i] = 1;
    let lmin = Infinity;
    for (let k = 0; k < N; k++) if (this.len[k] < lmin) lmin = this.len[k];
    this.dtSub = (Number.isFinite(lmin) ? lmin : dx) / v;
  }

  /**
   * Land outside the grid that drains in at `cells` (m2 each, with its travel time to the edge, s):
   * the reaches below each point were built for that whole catchment, not just the part inside the
   * grid, so they are sized for it too (rational method with the longer time of concentration).
   */
  addUpstream(cells: ArrayLike<number>, areasM2: ArrayLike<number>, travelS: ArrayLike<number>): void {
    const t0 = NET_TUNING.inletTimeS, v = NET_TUNING.velocity;
    for (let p = 0; p < cells.length; p++) {
      const c = cells[p];
      let k = c >= 0 && c < this.cellNode.length ? this.cellNode[c] : -1;
      const area = Math.max(0, areasM2[p] || 0);
      if (k < 0 || !area) continue;
      let l = Math.max(0, travelS[p] || 0) * v;
      for (let guard = 0; k >= 0 && guard <= this.size; guard++) {
        this.areaUp[k] += area;
        if (l > this.lUp[k]) this.lUp[k] = l;
        const tc = t0 + this.lUp[k] / v;
        this.designArea[k] = this.areaUp[k] * Math.pow(t0 / tc, NET_TUNING.idfExp) * (this.culvert[k] ? NET_TUNING.culvertFactor : 1);
        l += this.len[k];
        k = this.kind[k] === INTERIOR ? this.down[k] : -1;
      }
    }
    this.intensity = -1; // resize on the next exchange
  }

  /** counts per node kind (diagnostics) */
  summary(): { nodes: number; tankNodes: number; edge: number; dead: number; culverts: number } {
    let edge = 0, dead = 0, tank = 0, culverts = 0;
    for (let k = 0; k < this.size; k++) {
      if (this.kind[k] === EDGE) edge++;
      else if (this.kind[k] === DEAD) dead++;
      if (this.lakeOf[k] >= 0) tank++;
      if (this.culvert[k]) culverts++;
    }
    return { nodes: this.size, tankNodes: tank, edge, dead, culverts };
  }

  reset(): void {
    this.S.fill(0);
    this.totals = { inflow: 0, sink: 0, surcharge: 0, lakeSurface: 0, lake: 0, out: 0 };
  }

  /** water in the drains (and backed up in tanks), m3 */
  storage(): number {
    let s = 0;
    for (let k = 0; k < this.size; k++) s += this.S[k];
    return s;
  }

  /** true while there is water in the network */
  active(): boolean {
    for (let k = 0; k < this.size; k++) if (this.S[k] > EPS_M3) return true;
    return false;
  }

  private size_(intensity: number): void {
    if (intensity === this.intensity) return;
    this.intensity = intensity;
    const v = NET_TUNING.velocity;
    for (let k = 0; k < this.size; k++) {
      // designArea already carries the culvert factor of joined gaps and unmapped line ends
      const q = intensity * this.designArea[k];
      if (this.lakeOf[k] >= 0) {
        // tanks pass water on freely and back up only behind a full outflow drain; a tank without a
        // mapped outflow passes what its weir (culvert-sized) carries
        const lc = this.lakeOf[k];
        this.qmax[k] = this.kind[k] === DEAD ? q : Infinity;
        this.Smax[k] = this.A * (this.tankStart[lc + 1] - this.tankStart[lc]) * NET_TUNING.lakeRiseM;
      } else {
        this.qmax[k] = q;
        this.Smax[k] = (q * this.len[k]) / v;
      }
    }
  }

  /**
   * One surface step of the minor system: inlets on wet cells capture up to `cap * rate[i]` metres
   * (room-limited per node), the network routes for `dt` s, and anything it cannot hold returns to
   * `h` at the node. `intensity` = design intensity of the drains, m/s.
   * Returns the net depth removed from the surface, summed over cells (m * cells).
   */
  exchange(h: Float64Array, cap: number, rate: Float64Array, intensity: number, dt: number): number {
    this.size_(intensity);
    const { cellNode, want, took, rcell, tankCell, S, Smax, A } = this;
    const N = this.size, n = h.length;
    // inlets take their share off the surface now; what a full node refuses is handed back below
    want.fill(0);
    took.fill(0);
    let removed = 0, sink = 0;
    if (cap > 0) {
      for (let i = 0; i < n; i++) {
        const d = h[i];
        if (d <= 0) { rcell[i] = 0; continue; }
        const k = cellNode[i];
        // water standing on a tank above its cushion leaves through the weir: all of it is offered
        const m = tankCell[i] && k >= 0 ? d : cap * rate[i];
        const r = d < m ? d : m;
        rcell[i] = r;
        h[i] = d - r;
        removed += r;
        if (k >= 0) want[k] += r * A;
        else sink += r;
      }
    }
    // route in sub-steps; inlets feed each sub-step an equal share of the demand, up to the room left
    const sub = Math.max(1, Math.ceil(dt / this.dtSub - 1e-9));
    const dtn = dt / sub;
    const v = NET_TUNING.velocity;
    const { kind, down, len, qmax, lakeOf, lakeRoom, cell } = this;
    const tot = this.totals;
    let back = 0; // m3 returned to the surface
    for (let s = 0; s < sub; s++) {
      if (cap > 0)
        for (let k = 0; k < N; k++) {
          const offer = want[k] / sub;
          if (offer <= 0) continue;
          const room = Smax[k] - S[k];
          const t = room <= 0 ? 0 : room >= offer ? offer : room;
          S[k] += t;
          took[k] += t;
        }
      // downstream-first: water moves at most one reach per sub-step
      for (let k = 0; k < N; k++) {
        let sk = S[k];
        if (sk <= 0) continue;
        const lk = lakeOf[k];
        if (lk >= 0) {
          // a tank first fills its flood cushion
          const room = lakeRoom[lk];
          if (room > 0) {
            const into = room >= sk ? sk : room;
            lakeRoom[lk] = room - into;
            tot.lake += into;
            sk -= into;
            S[k] = sk;
            if (sk <= 0) continue;
          }
        }
        const kd = kind[k];
        let out = (sk * v * dtn) / len[k];
        const qm = qmax[k] * dtn;
        if (out > qm) out = qm;
        if (out > sk) out = sk;
        if (kd === INTERIOR) {
          const d = down[k];
          // backwater: a tank backs up behind a full drain, and a drain behind a full tank (its
          // overflow then surcharges near the tank) instead of forcing water in
          const ld = lakeOf[d];
          if (lk >= 0 || ld >= 0) {
            const room = Smax[d] - S[d] + (ld >= 0 ? lakeRoom[ld] : 0);
            if (out > room) out = room > 0 ? room : 0;
          }
          if (out <= 0) continue;
          S[k] = sk - out;
          S[d] += out;
        } else {
          if (out <= 0) continue;
          S[k] = sk - out;
          tot.out += out;
        }
      }
      // reaches that are over full overflow onto the street (tanks onto their own surface)
      for (let k = 0; k < N; k++) {
        const ex = S[k] - Smax[k];
        if (ex > 0) {
          S[k] = Smax[k];
          const lk = lakeOf[k];
          if (lk >= 0) {
            // a full tank rises over its whole surface
            const a = this.tankStart[lk], b = this.tankStart[lk + 1];
            const dd = ex / ((b - a) * A);
            for (let m = a; m < b; m++) h[this.tankCells[m]] += dd;
            tot.lakeSurface += ex;
          } else {
            h[cell[k]] += ex / A;
            tot.surcharge += ex;
          }
          back += ex;
        }
      }
    }
    // hand back what full nodes refused, in proportion to what each cell offered
    let inflow = 0;
    if (cap > 0) {
      const { feedStart, feedCells } = this;
      for (let k = 0; k < N; k++) {
        const wk = want[k];
        if (wk <= 0) continue;
        inflow += took[k];
        if (took[k] >= wk) continue;
        const f = 1 - took[k] / wk;
        for (let m = feedStart[k], e = feedStart[k + 1]; m < e; m++) {
          const i = feedCells[m];
          const g = rcell[i] * f;
          if (g <= 0) continue;
          h[i] += g;
          removed -= g;
        }
      }
    }
    tot.inflow += inflow;
    tot.sink += sink * A;
    return removed - back / A;
  }
}
