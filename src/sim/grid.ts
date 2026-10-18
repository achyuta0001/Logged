/**
 * Multi-resolution helpers: the model runs on a coarsened grid (block f x f) for speed and the
 * hourly depth is downscaled back to the terrain grid with a volume-consistent "fill the lowest
 * fine cells first" rule, so 15 m pits and road dips still show water, and volumes match exactly.
 */
import type { CoreGrids } from './core.ts';

export interface Coarse {
  f: number;
  grids: CoreGrids;
  /** fine grid size */
  fw: number;
  fh: number;
}

export function coarsen(g: CoreGrids, f: number): Coarse {
  if (f <= 1) return { f: 1, grids: g, fw: g.width, fh: g.height };
  const fw = g.width, fh = g.height;
  const w = Math.ceil(fw / f), h = Math.ceil(fh / f);
  const n = w * h;
  const elevation = new Float32Array(n);
  const impervious = new Float32Array(n);
  const drainMask = new Uint8Array(n);
  const lakeMask = new Uint8Array(n);
  const boundaryMask = new Uint8Array(n);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      let zs = 0, zc = 0, is = 0, cnt = 0, lk = 0, dr = 0, bd = 0;
      for (let rr = r * f; rr < Math.min(fh, r * f + f); rr++)
        for (let cc = c * f; cc < Math.min(fw, c * f + f); cc++) {
          const i = rr * fw + cc;
          const z = g.elevation[i];
          if (Number.isFinite(z) && z > -1000) { zs += z; zc++; }
          is += g.impervious ? g.impervious[i] : 0.5;
          if (g.lakeMask?.[i]) lk++;
          if (g.drainMask?.[i]) dr = 1;
          if (g.boundaryMask?.[i]) bd = 1;
          cnt++;
        }
      const o = r * w + c;
      elevation[o] = zc ? zs / zc : NaN;
      impervious[o] = is / cnt;
      lakeMask[o] = lk * 2 >= cnt ? 1 : 0;
      drainMask[o] = dr;
      boundaryMask[o] = g.boundaryMask ? bd : 1;
    }
  return {
    f,
    fw,
    fh,
    grids: {
      width: w,
      height: h,
      cellSizeM: g.cellSizeM * f,
      elevation,
      impervious,
      drainMask: g.drainMask ? drainMask : undefined,
      lakeMask: g.lakeMask ? lakeMask : undefined,
      boundaryMask: g.boundaryMask ? boundaryMask : undefined,
    },
  };
}

/**
 * Volume-consistent downscale of coarse depth (m) to the fine grid. Output in millimetres (Uint16)
 * because that is what we store per hour. `zFine` = fine elevation.
 */
export function downscaleMm(c: Coarse, hC: Float64Array, zFine: Float32Array, out: Uint16Array): void {
  const { f, fw, fh } = c;
  const w = c.grids.width, h = c.grids.height;
  if (f === 1) {
    for (let i = 0; i < hC.length; i++) {
      const v = Math.round(hC[i] * 1000);
      out[i] = v > 65535 ? 65535 : v;
    }
    return;
  }
  out.fill(0);
  const idx: number[] = [];
  const zs: number[] = [];
  const ratio = f * f; // coarse area / fine area
  for (let r = 0; r < h; r++)
    for (let cc = 0; cc < w; cc++) {
      const d = hC[r * w + cc];
      if (d <= 0.0005) continue;
      idx.length = 0;
      for (let rr = r * f; rr < Math.min(fh, r * f + f); rr++)
        for (let c2 = cc * f; c2 < Math.min(fw, cc * f + f); c2++) {
          const i = rr * fw + c2;
          if (Number.isFinite(zFine[i])) idx.push(i);
        }
      if (!idx.length) continue;
      idx.sort((a, b) => zFine[a] - zFine[b]);
      zs.length = 0;
      for (const i of idx) zs.push(zFine[i]);
      // volume expressed as depth over one fine cell; partial edge blocks hold the same volume
      const V = d * ratio;
      let sum = 0, L = zs[0];
      for (let m = 1; m <= zs.length; m++) {
        sum += zs[m - 1];
        L = (V + sum) / m;
        if (m === zs.length || L <= zs[m]) break;
      }
      for (const i of idx) {
        const dd = L - zFine[i];
        if (dd > 0) {
          const v = Math.round(dd * 1000);
          out[i] = v > 65535 ? 65535 : v;
        }
      }
    }
}

/**
 * Cap the depth of closed street depressions at `maxM` below their spill level (in place).
 * A depression here is ground that cannot drain by gravity to the grid edge, a tank or a mapped drain
 * (`outlets`, 1 = tank or drain cell): a 4-neighbour priority flood from the edge and the outlets gives
 * each cell the level it spills at, and any other cell more than `maxM` below that is raised to it.
 * Why: the pack DEM is a bare-earth approximation of a 30 m radar surface model, which leaves holes
 * several metres deep where building blobs ring a plot, a courtyard or a basement dig; the street gaps
 * that drain them are narrower than a cell. Filled to the brim they read as 5-7 m street floods.
 * Tank bowls and drain channels are untouched (they are outlets), as is ponding up to `maxM`
 * (underpasses, road dips). Non-finite cells are walls and stay as they are. Returns cells raised.
 */
export function limitPits(z: Float32Array, w: number, h: number, maxM: number, outlets?: Uint8Array): number {
  const n = w * h;
  if (!(maxM >= 0) || n === 0) return 0;
  const lvl = new Float64Array(n).fill(Infinity);
  // binary min-heap of cells keyed by spill level
  const hk = new Float64Array(n), hv = new Int32Array(n);
  let size = 0;
  const push = (key: number, v: number) => {
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= key) break;
      hk[i] = hk[p]; hv[i] = hv[p]; i = p;
    }
    hk[i] = key; hv[i] = v;
  };
  const pop = (): number => {
    const top = hv[0];
    const key = hk[--size], v = hv[size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= size) break;
      if (c + 1 < size && hk[c + 1] < hk[c]) c++;
      if (hk[c] >= key) break;
      hk[i] = hk[c]; hv[i] = hv[c]; i = c;
    }
    hk[i] = key; hv[i] = v;
    return top;
  };
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(z[i])) continue;
    const r = (i / w) | 0, c = i - r * w;
    if (r === 0 || c === 0 || r === h - 1 || c === w - 1 || (outlets && outlets[i])) { lvl[i] = z[i]; push(z[i], i); }
  }
  let raised = 0;
  while (size) {
    const i = pop();
    const r = (i / w) | 0, c = i - r * w, L = lvl[i];
    for (let k = 0; k < 4; k++) {
      const j = k === 0 ? (c + 1 < w ? i + 1 : -1) : k === 1 ? (c > 0 ? i - 1 : -1) : k === 2 ? (r + 1 < h ? i + w : -1) : r > 0 ? i - w : -1;
      if (j < 0 || lvl[j] !== Infinity || !Number.isFinite(z[j])) continue;
      const zj = z[j];
      const lj = zj > L ? zj : L;
      lvl[j] = lj;
      if (lj - zj > maxM) { z[j] = lj - maxM; raised++; }
      push(lj, j);
    }
  }
  return raised;
}
