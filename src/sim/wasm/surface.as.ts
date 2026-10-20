// @ts-nocheck -- AssemblyScript, not TypeScript: compiled to WebAssembly by scripts/build-wasm.mjs
/**
 * WebAssembly kernel of SimCore.step (src/sim/core.ts): the per-cell vertical pass (rain, soil,
 * inlet capture), the wet extents, post-storm pond drainage and the diffusive-wave routing (face
 * fluxes, CFL speed, edge outflow, positivity, depth update, clamp).
 *
 * It works in place on the SimCore's own arrays, which live in this module's linear memory
 * (src/sim/kernel.ts lays them out; SimCore keeps typed-array views on them, so nothing is copied per
 * step). Every expression and every loop runs in the same order as the JS in core.ts, on f64 values,
 * so results are bit-identical: IEEE add/mul/div/sqrt are exact-rounded in both, and the one
 * non-exact function, pow (only for depths >= 5 m), is imported from JS's Math.pow. Keep the two in
 * step: an edit to SimCore.step needs the same edit here (`npm run wasm` rebuilds, and the tests
 * compare both engines bit for bit).
 */

@external("env", "pow")
declare function jsPow(x: f64, y: f64): f64;

const H_MIN_FLOW: f64 = 1e-4;
const POND_MIN_M: f64 = 0.01;
const SOIL_CAP_M: f64 = 0.1;
const SOIL_SAT_FACTOR: f64 = 0.15;
const PONDED_HEAD_M: f64 = 0.3;
const LUT_STEP: f64 = 1e-4;

// grid shape and array addresses (bytes), set once by setup()
let W: i32 = 0;
let NR: i32 = 0; // rows
let NC: i32 = 0; // cells
let NB: i32 = 0; // basins
let pH: usize = 0;
let pZ: usize = 0;
let pInvN: usize = 0;
let pNE: usize = 0;
let pNS: usize = 0;
let pPerv: usize = 0;
let pSoil: usize = 0;
let pRate: usize = 0;
let pFx: usize = 0;
let pFy: usize = 0;
let pOut: usize = 0;
let pEs: usize = 0;
let pEo: usize = 0;
let pRowMin: usize = 0;
let pRowMax: usize = 0;
let pChan: usize = 0;
let pImp: usize = 0;
let pBasin: usize = 0;
let pLakeComp: usize = 0;
let pBImp: usize = 0;
let pBWetImp: usize = 0;
let pBPond: usize = 0;
let pCellNode: usize = 0;
let pTankCell: usize = 0;
let pWant: usize = 0;
let pRcell: usize = 0;
let pLut: usize = 0;
let pRet: usize = 0;

/** addresses: one i32 per array, in the order of the globals above, at `table` */
export function setup(w: i32, rows: i32, nb: i32, table: usize): void {
  W = w;
  NR = rows;
  NC = w * rows;
  NB = nb;
  pH = load<u32>(table, 0);
  pZ = load<u32>(table, 4);
  pInvN = load<u32>(table, 8);
  pNE = load<u32>(table, 12);
  pNS = load<u32>(table, 16);
  pPerv = load<u32>(table, 20);
  pSoil = load<u32>(table, 24);
  pRate = load<u32>(table, 28);
  pFx = load<u32>(table, 32);
  pFy = load<u32>(table, 36);
  pOut = load<u32>(table, 40);
  pEs = load<u32>(table, 44);
  pEo = load<u32>(table, 48);
  pRowMin = load<u32>(table, 52);
  pRowMax = load<u32>(table, 56);
  pChan = load<u32>(table, 60);
  pImp = load<u32>(table, 64);
  pBasin = load<u32>(table, 68);
  pLakeComp = load<u32>(table, 72);
  pBImp = load<u32>(table, 76);
  pBWetImp = load<u32>(table, 80);
  pBPond = load<u32>(table, 84);
  pCellNode = load<u32>(table, 88);
  pTankCell = load<u32>(table, 92);
  pWant = load<u32>(table, 96);
  pRcell = load<u32>(table, 100);
  pLut = load<u32>(table, 104);
  pRet = load<u32>(table, 108);
}

/** d^(2/3): the table below 5 m (index truncated like JS `| 0`), Math.pow above (core.ts) */
function pow23(lut: usize, d: f64): f64 {
  return d < 5 ? load<f64>(lut + ((<usize>(<i32>(d / LUT_STEP))) << 3)) : jsPow(d, 2.0 / 3.0);
}

/**
 * Rain, infiltration into the soil store, and (fold != 0) the inlets' capture into the drain network's
 * demand (core.ts step, "vertical sources / sinks"). Returns the infiltrated depth summed over cells;
 * ret[1] = captured depth summed, ret[2] = captured depth with no node in reach.
 */
export function vertical(rainDepth: f64, infBase: f64, soilRec: f64, cap: f64, fold: i32, A: f64): f64 {
  const n = NC;
  const h = pH, perv = pPerv, soil = pSoil, rate = pRate, rcell = pRcell, cellNode = pCellNode, tankCell = pTankCell, want = pWant;
  let infTot: f64 = 0, capRemoved: f64 = 0, capSink: f64 = 0;
  // want[k] += r * A runs in a register while consecutive cells feed the same node (they mostly do):
  // the same additions in the same order, without a store-to-load chain through memory per cell
  let wk: i32 = -1, wsum: f64 = 0;
  for (let i = 0; i < n; i++) {
    const o = (<usize>i) << 3;
    let d = load<f64>(h + o) + rainDepth;
    const pv = load<f64>(perv + o);
    let s = load<f64>(soil + o);
    if (pv > 0 && infBase > 0) {
      const pot = infBase * (s < SOIL_CAP_M ? 1.0 : SOIL_SAT_FACTOR * (1.0 + d / PONDED_HEAD_M)) * pv;
      if (d > 0 && pot > 0) {
        const inf = d < pot ? d : pot;
        d -= inf;
        infTot += inf;
        s += inf / pv;
      }
    }
    s -= soilRec;
    store<f64>(soil + o, s > 0 ? s : 0.0);
    if (fold) {
      if (d <= 0) store<f64>(rcell + o, 0.0);
      else {
        const k = load<i32>(cellNode + ((<usize>i) << 2));
        const m = load<u8>(tankCell + <usize>i) != 0 && k >= 0 ? d : cap * load<f64>(rate + o);
        const r = d < m ? d : m;
        store<f64>(rcell + o, r);
        d -= r;
        capRemoved += r;
        if (k >= 0) {
          if (k != wk) {
            if (wk >= 0) store<f64>(want + ((<usize>wk) << 3), wsum);
            wk = k;
            wsum = load<f64>(want + ((<usize>k) << 3));
          }
          wsum += r * A;
        } else capSink += r;
      }
    }
    store<f64>(h + o, d);
  }
  if (wk >= 0) store<f64>(want + ((<usize>wk) << 3), wsum);
  store<f64>(pRet, infTot, 0);
  store<f64>(pRet, capRemoved, 8);
  store<f64>(pRet, capSink, 16);
  return infTot;
}

/** wet extent per row: first and last column deeper than H_MIN_FLOW (w and -1 when the row is dry) */
export function wetExtents(): void {
  const w = W, rows = NR, h = pH, rowMin = pRowMin, rowMax = pRowMax;
  for (let r = 0; r < rows; r++) {
    const row = h + ((<usize>(r * w)) << 3);
    let lo = 0;
    while (lo < w && !(load<f64>(row + ((<usize>lo) << 3)) > H_MIN_FLOW)) lo++;
    let hi = -1;
    if (lo < w) {
      hi = w - 1;
      while (!(load<f64>(row + ((<usize>hi) << 3)) > H_MIN_FLOW)) hi--;
    }
    store<i32>(rowMin + ((<usize>r) << 2), lo);
    store<i32>(rowMax + ((<usize>r) << 2), hi);
  }
}

/** core.ts drainPonds: returns the removed depth summed over cells (m * cells) */
export function drainPonds(capDepth: f64): f64 {
  const w = W, rows = NR, nb = NB;
  const h = pH, basin = pBasin, imp = pImp, lakeComp = pLakeComp, wetImp = pBWetImp, pond = pBPond, bImp = pBImp;
  const rowMin = pRowMin, rowMax = pRowMax;
  memory.fill(wetImp, 0, (<usize>nb) << 3);
  memory.fill(pond, 0, (<usize>nb) << 3);
  let any = false;
  for (let r = 0; r < rows; r++) {
    const hi = load<i32>(rowMax + ((<usize>r) << 2));
    for (let i = r * w + load<i32>(rowMin + ((<usize>r) << 2)), e = r * w + hi; i <= e; i++) {
      const o = (<usize>i) << 3;
      const d = load<f64>(h + o);
      if (d <= POND_MIN_M) continue;
      const b = (<usize>load<i32>(basin + ((<usize>i) << 2))) << 3;
      store<f64>(wetImp + b, load<f64>(wetImp + b) + load<f64>(imp + o));
      if (load<i32>(lakeComp + ((<usize>i) << 2)) < 0) {
        store<f64>(pond + b, load<f64>(pond + b) + d);
        any = true;
      }
    }
  }
  if (!any) return 0;
  for (let b = 0; b < nb; b++) {
    const o = (<usize>b) << 3;
    const pb = load<f64>(pond + o);
    if (pb <= 0) continue;
    const room = capDepth * (load<f64>(bImp + o) - load<f64>(wetImp + o));
    store<f64>(pond + o, room <= 0 ? 0.0 : room >= pb ? 1.0 : room / pb);
  }
  let removed: f64 = 0;
  for (let r = 0; r < rows; r++) {
    const hi = load<i32>(rowMax + ((<usize>r) << 2));
    for (let i = r * w + load<i32>(rowMin + ((<usize>r) << 2)), e = r * w + hi; i <= e; i++) {
      const o = (<usize>i) << 3;
      const d = load<f64>(h + o);
      if (d <= POND_MIN_M || load<i32>(lakeComp + ((<usize>i) << 2)) >= 0) continue;
      const f = load<f64>(pond + ((<usize>load<i32>(basin + ((<usize>i) << 2))) << 3));
      if (f <= 0) continue;
      const x = d * f;
      store<f64>(h + o, d - x);
      removed += x;
    }
  }
  return removed;
}

/**
 * Horizontal routing for dt (core.ts step, "horizontal routing" to the clamp). Returns the fastest
 * face speed (m/s) for the next CFL step; ret[3] = volume out across the grid edge (m3), ret[4] = the
 * clamped round-off negatives (m, summed).
 */
export function route(dt: f64, dx: f64, A: f64, kA: f64, invDx: f64, invA: f64): f64 {
  const w = W, rows = NR;
  const h = pH, z = pZ, nE = pNE, nS = pNS, chan = pChan, fx = pFx, fy = pFy, out = pOut, lut = pLut;
  const rowMin = pRowMin, rowMax = pRowMax, invN = pInvN, es = pEs, eo = pEo;
  memory.fill(out, 0, (<usize>NC) << 3);
  let vmax: f64 = 0;
  for (let r = 0; r < rows; r++) {
    const base = r * w;
    // east faces: need either cell wet
    let lo = load<i32>(rowMin + ((<usize>r) << 2)), hi = load<i32>(rowMax + ((<usize>r) << 2));
    if (hi >= 0) {
      lo = lo > 0 ? lo - 1 : 0;
      if (hi > w - 2) hi = w - 2;
      for (let c = lo; c <= hi; c++) {
        const i = base + c;
        const oi = (<usize>i) << 3, oj = oi + 8;
        const zi = load<f64>(z + oi), zj = load<f64>(z + oj);
        const ei = zi + load<f64>(h + oi), ej = zj + load<f64>(h + oj);
        const zf = zi > zj ? zi : zj;
        const d = ei - ej;
        const hf = (d > 0 ? ei : ej) - zf;
        if (hf <= H_MIN_FLOW || d == 0) {
          store<f64>(fx + oi, 0.0);
          continue;
        }
        const ad = d > 0 ? d : -d;
        const h23 = pow23(lut, hf);
        const q = hf * h23 * load<f64>(nE + oi) * sqrt<f64>(ad * invDx) * dx;
        if (hf > 0.02 && load<u8>(chan + <usize>i) == 0 && load<u8>(chan + <usize>(i + 1)) == 0) {
          const v = q / (hf * dx);
          if (v > vmax) vmax = v;
        }
        let vol = q * dt;
        const lim = kA * ad;
        if (vol > lim) vol = lim;
        if (d > 0) {
          store<f64>(fx + oi, vol);
          store<f64>(out + oi, load<f64>(out + oi) + vol);
        } else {
          store<f64>(fx + oi, -vol);
          store<f64>(out + oj, load<f64>(out + oj) + vol);
        }
      }
      // clear stale faces outside the computed range
      for (let c = 0; c < lo; c++) store<f64>(fx + ((<usize>(base + c)) << 3), 0.0);
      for (let c = hi + 1; c < w; c++) store<f64>(fx + ((<usize>(base + c)) << 3), 0.0);
    } else {
      memory.fill(fx + ((<usize>base) << 3), 0, (<usize>w) << 3);
    }
    // south faces
    if (r < rows - 1) {
      const lo0 = load<i32>(rowMin + ((<usize>r) << 2)), lo1 = load<i32>(rowMin + ((<usize>(r + 1)) << 2));
      const hi0 = load<i32>(rowMax + ((<usize>r) << 2)), hi1 = load<i32>(rowMax + ((<usize>(r + 1)) << 2));
      const lo2 = lo0 < lo1 ? lo0 : lo1;
      const hi2 = hi0 > hi1 ? hi0 : hi1;
      if (hi2 >= 0) {
        for (let c = 0; c < lo2; c++) store<f64>(fy + ((<usize>(base + c)) << 3), 0.0);
        for (let c = hi2 + 1; c < w; c++) store<f64>(fy + ((<usize>(base + c)) << 3), 0.0);
        const ow = (<usize>w) << 3;
        for (let c = lo2; c <= hi2; c++) {
          const i = base + c;
          const oi = (<usize>i) << 3, oj = oi + ow;
          const zi = load<f64>(z + oi), zj = load<f64>(z + oj);
          const ei = zi + load<f64>(h + oi), ej = zj + load<f64>(h + oj);
          const zf = zi > zj ? zi : zj;
          const d = ei - ej;
          const hf = (d > 0 ? ei : ej) - zf;
          if (hf <= H_MIN_FLOW || d == 0) {
            store<f64>(fy + oi, 0.0);
            continue;
          }
          const ad = d > 0 ? d : -d;
          const h23 = pow23(lut, hf);
          const q = hf * h23 * load<f64>(nS + oi) * sqrt<f64>(ad * invDx) * dx;
          if (hf > 0.02 && load<u8>(chan + <usize>i) == 0 && load<u8>(chan + <usize>(i + w)) == 0) {
            const v = q / (hf * dx);
            if (v > vmax) vmax = v;
          }
          let vol = q * dt;
          const lim = kA * ad;
          if (vol > lim) vol = lim;
          if (d > 0) {
            store<f64>(fy + oi, vol);
            store<f64>(out + oi, load<f64>(out + oi) + vol);
          } else {
            store<f64>(fy + oi, -vol);
            store<f64>(out + oj, load<f64>(out + oj) + vol);
          }
        }
      } else {
        memory.fill(fy + ((<usize>base) << 3), 0, (<usize>w) << 3);
      }
    }
  }
  // edge outflow (free boundary): top row, bottom row, then the two sides of the rows between
  let eCount = 0;
  if (load<i32>(rowMax) >= 0) for (let c = 0; c < w; c++) eCount = edgeVisit(c, eCount, dt, dx, kA);
  if (rows > 1 && load<i32>(rowMax + ((<usize>(rows - 1)) << 2)) >= 0)
    for (let c = 0; c < w; c++) eCount = edgeVisit((rows - 1) * w + c, eCount, dt, dx, kA);
  for (let r = 1; r < rows - 1; r++) {
    if (load<i32>(rowMax + ((<usize>r) << 2)) < 0) continue;
    eCount = edgeVisit(r * w, eCount, dt, dx, kA);
    if (w > 1) eCount = edgeVisit(r * w + w - 1, eCount, dt, dx, kA);
  }

  // positivity: scale factor per donor cell, stored in out (out -> scale); donors lie in the wet extents
  for (let r = 0; r < rows; r++) {
    const hi = load<i32>(rowMax + ((<usize>r) << 2));
    if (hi < 0) continue;
    const base = r * w;
    for (let c = load<i32>(rowMin + ((<usize>r) << 2)); c <= hi; c++) {
      const oi = (<usize>(base + c)) << 3;
      const o = load<f64>(out + oi);
      if (o > 0) {
        const avail = load<f64>(h + oi) * A;
        store<f64>(out + oi, o > avail ? avail / o : 1.0);
      }
    }
  }
  // apply fluxes
  const ow = (<usize>w) << 3;
  for (let r = 0; r < rows; r++) {
    const base = r * w;
    let lo = load<i32>(rowMin + ((<usize>r) << 2));
    if (r > 0) { const v = load<i32>(rowMin + ((<usize>(r - 1)) << 2)); if (v < lo) lo = v; }
    if (r < rows - 1) { const v = load<i32>(rowMin + ((<usize>(r + 1)) << 2)); if (v < lo) lo = v; }
    lo = lo - 1;
    if (lo < 0) lo = 0;
    let hi = load<i32>(rowMax + ((<usize>r) << 2));
    if (r > 0) { const v = load<i32>(rowMax + ((<usize>(r - 1)) << 2)); if (v > hi) hi = v; }
    if (r < rows - 1) { const v = load<i32>(rowMax + ((<usize>(r + 1)) << 2)); if (v > hi) hi = v; }
    hi = hi + 1;
    if (hi > w - 1) hi = w - 1;
    if (hi < 0) continue;
    for (let c = lo; c <= hi; c++) {
      const oi = (<usize>(base + c)) << 3;
      const a = load<f64>(fx + oi);
      if (a != 0 && c < w - 1) {
        const oj = oi + 8;
        const v = a > 0 ? a * load<f64>(out + oi) : a * load<f64>(out + oj);
        store<f64>(h + oi, load<f64>(h + oi) - v * invA);
        store<f64>(h + oj, load<f64>(h + oj) + v * invA);
      }
      const b = load<f64>(fy + oi);
      if (b != 0 && r < rows - 1) {
        const oj = oi + ow;
        const v = b > 0 ? b * load<f64>(out + oi) : b * load<f64>(out + oj);
        store<f64>(h + oi, load<f64>(h + oi) - v * invA);
        store<f64>(h + oj, load<f64>(h + oj) + v * invA);
      }
    }
  }
  let outflow: f64 = 0;
  for (let k = 0; k < eCount; k++) {
    const ek = eo + ((<usize>k) << 4);
    const oi = (<usize>(<i32>load<f64>(ek))) << 3;
    const v = load<f64>(ek, 8) * load<f64>(out + oi);
    store<f64>(h + oi, load<f64>(h + oi) - v * invA);
    outflow += v;
  }
  // clamp round-off negatives; only cells the fluxes touched can be negative: the same row ranges
  let neg: f64 = 0;
  for (let r = 0; r < rows; r++) {
    const base = r * w;
    let lo = load<i32>(rowMin + ((<usize>r) << 2));
    if (r > 0) { const v = load<i32>(rowMin + ((<usize>(r - 1)) << 2)); if (v < lo) lo = v; }
    if (r < rows - 1) { const v = load<i32>(rowMin + ((<usize>(r + 1)) << 2)); if (v < lo) lo = v; }
    lo = lo - 1;
    if (lo < 0) lo = 0;
    let hi = load<i32>(rowMax + ((<usize>r) << 2));
    if (r > 0) { const v = load<i32>(rowMax + ((<usize>(r - 1)) << 2)); if (v > hi) hi = v; }
    if (r < rows - 1) { const v = load<i32>(rowMax + ((<usize>(r + 1)) << 2)); if (v > hi) hi = v; }
    hi = hi + 1;
    if (hi > w - 1) hi = w - 1;
    for (let c = lo; c <= hi; c++) {
      const oi = (<usize>(base + c)) << 3;
      const v = load<f64>(h + oi);
      if (v < 0) {
        neg += v;
        store<f64>(h + oi, 0.0);
      }
    }
  }
  store<f64>(pRet, outflow, 24);
  store<f64>(pRet, neg, 32);
  return vmax;
}

/** core.ts edgeVisit: free outflow of edge cell i, recorded at eo[2 eCount]; returns the new count */
function edgeVisit(i: i32, eCount: i32, dt: f64, dx: f64, kA: f64): i32 {
  const oi = (<usize>i) << 3;
  const d = load<f64>(pH + oi);
  if (d <= H_MIN_FLOW) return eCount;
  const q = d * pow23(pLut, d) * load<f64>(pInvN + oi) * load<f64>(pEs + oi) * dx;
  let vol = q * dt;
  const lim = kA * d;
  if (vol > lim) vol = lim;
  store<f64>(pOut + oi, load<f64>(pOut + oi) + vol);
  const ek = pEo + ((<usize>eCount) << 4);
  store<f64>(ek, <f64>i);
  store<f64>(ek, vol, 8);
  return eCount + 1;
}
