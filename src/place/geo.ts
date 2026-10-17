// Small geometry helpers shared by the "Your place" modules (no DOM, runs in node tests too).
import type { TerrainMeta } from '../types.ts';

export type LngLat = [number, number];

export const M_PER_DEG_LAT = 110574;
export const mPerDegLng = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

/** Equirectangular distance in metres (accurate to <0.1% at neighbourhood scale). */
export function distM(a: LngLat, b: LngLat): number {
  const kx = mPerDegLng((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * M_PER_DEG_LAT);
}

/** Grid cell containing [lng, lat] (row 0 = north), or -1 outside — same mapping as src/terrain.ts. */
export function cellAt(meta: TerrainMeta, lng: number, lat: number): number {
  const [w, s, e, n] = meta.bbox;
  const col = Math.floor(((lng - w) / (e - w)) * meta.width);
  const row = Math.floor(((n - lat) / (n - s)) * meta.height);
  if (!(col >= 0 && row >= 0 && col < meta.width && row < meta.height)) return -1;
  return row * meta.width + col;
}

/** Centre of a grid cell as [lng, lat]. */
export function cellCenter(meta: TerrainMeta, cell: number): LngLat {
  const [w, s, e, n] = meta.bbox;
  const col = cell % meta.width;
  const row = Math.floor(cell / meta.width);
  return [w + ((col + 0.5) / meta.width) * (e - w), n - ((row + 0.5) / meta.height) * (n - s)];
}

export function inBBox(meta: TerrainMeta, p: LngLat): boolean {
  const [w, s, e, n] = meta.bbox;
  return p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n;
}

/**
 * Max of `grid` within `radiusM` of a cell (disc of cells). Used for "water within ~30 m of my door":
 * the DEM is a smoothed surface model, so the exact cell under a pin is often a little high.
 */
export function maxAround(grid: ArrayLike<number>, meta: TerrainMeta, cell: number, radiusM: number): number {
  if (cell < 0) return 0;
  const W = meta.width, H = meta.height;
  const r = Math.max(0, Math.round(radiusM / meta.cellSizeM));
  const x0 = cell % W, y0 = Math.floor(cell / W);
  let m = 0;
  for (let dy = -r; dy <= r; dy++) {
    const y = y0 + dy;
    if (y < 0 || y >= H) continue;
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r + r) continue;
      const x = x0 + dx;
      if (x < 0 || x >= W) continue;
      const v = grid[y * W + x];
      if (v > m) m = v;
    }
  }
  return m;
}
