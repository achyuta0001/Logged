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
