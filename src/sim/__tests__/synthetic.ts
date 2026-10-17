import type { CoreGrids } from '../core.ts';

/** Bowl (closed depression) on the west half, sloping channel draining to the east edge. */
export function bowlAndChannel(n = 120, dx = 15): CoreGrids {
  const elevation = new Float32Array(n * n);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      let z: number;
      if (c < n / 2) {
        // bowl centred at (n/2, n/4), radius n/4: depth 3 m, rim at 903
        const dr = r - n / 2, dc = c - n / 4;
        const rr = Math.sqrt(dr * dr + dc * dc) / (n / 4);
        z = rr < 1 ? 900 + 3 * rr * rr : 903 + 0.5 * (rr - 1);
      } else {
        // plane falling to the east + V channel along the centre row
        z = 902 - ((c - n / 2) * dx) * 0.01 + Math.abs(r - n / 2) * dx * 0.02;
      }
      elevation[r * n + c] = z;
    }
  // wall around the bowl part so it is closed (west/north/south edges higher)
  return { width: n, height: n, cellSizeM: dx, elevation, impervious: new Float32Array(n * n).fill(1) };
}

/** Noisy urban-ish terrain at the real grid size, for performance. */
export function noisyTerrain(w = 350, h = 430, dx = 15): CoreGrids {
  const elevation = new Float32Array(w * h);
  const impervious = new Float32Array(w * h);
  const drainMask = new Uint8Array(w * h);
  const lakeMask = new Uint8Array(w * h);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      elevation[i] = 880 + 0.02 * dx * r + 8 * Math.sin(c / 25) * Math.cos(r / 31) + 1.5 * Math.sin(c / 4.3 + r / 7.1) + rnd() * 0.6;
      impervious[i] = 0.4 + 0.5 * rnd();
      if (Math.abs(c - w / 2 - 20 * Math.sin(r / 40)) < 1) drainMask[i] = 1;
      if ((r - 0.7 * h) ** 2 + (c - 0.23 * w) ** 2 < 200) lakeMask[i] = 1;
    }
  return { width: w, height: h, cellSizeM: dx, elevation, impervious, drainMask, lakeMask, boundaryMask: new Uint8Array(w * h).fill(1) };
}
