import type { GridLayerName, Terrain, TerrainMeta } from './types.ts';
import { decodeLayer, layerBytes } from './pack/codec.ts';

/**
 * Load a pack's meta.json + grids.bin (public/data/pins/<code>/) and build typed-array views per layer.
 * `offset` in meta.layers is a BYTE offset; `length` is in elements.
 */
export async function loadTerrain(base = '/data/pins/560098'): Promise<Terrain> {
  const [metaRes, binRes] = await Promise.all([fetch(`${base}/meta.json`), fetch(`${base}/grids.bin`)]);
  if (!metaRes.ok) throw new Error(`meta.json: HTTP ${metaRes.status}`);
  if (!binRes.ok) throw new Error(`grids.bin: HTTP ${binRes.status}`);
  const meta = (await metaRes.json()) as TerrainMeta;
  const buf = await binRes.arrayBuffer();
  return terrainFromBuffer(meta, buf);
}

/** Build a Terrain from an already-loaded meta + grids.bin buffer (also used by tests / node scripts). */
export function terrainFromBuffer(meta: TerrainMeta, buf: ArrayBuffer): Terrain {
  const grids = {} as Terrain['grids'];
  const entries = Object.entries(meta.layers) as [GridLayerName, TerrainMeta['layers'][GridLayerName]][];
  for (const [name, l] of entries) {
    if (l.derived) continue;
    if (l.offset + layerBytes(l) > buf.byteLength) {
      throw new Error(`grids.bin too short for layer ${name}`);
    }
    // v1 layers are views (f32 copied only if misaligned); v2 layers are decoded (src/pack/codec.ts)
    grids[name] = decodeLayer(buf, l, meta.width);
  }
  // v2: the depression-filled surface is elevation + fill depth
  if (meta.layers.filled?.derived) {
    const e = grids.elevation as Float32Array;
    const d = grids.depressionDepth as Float32Array;
    const f = new Float32Array(e.length);
    for (let i = 0; i < f.length; i++) f[i] = e[i] + d[i];
    grids.filled = f;
  }
  return { meta, grids };
}

/** Centre of a grid cell as [lng, lat]. Row 0 = north. */
export function cellToLngLat(meta: TerrainMeta, cell: number): [number, number] {
  const [w, s, e, n] = meta.bbox;
  const col = cell % meta.width;
  const row = Math.floor(cell / meta.width);
  const lng = w + ((col + 0.5) / meta.width) * (e - w);
  const lat = n - ((row + 0.5) / meta.height) * (n - s);
  return [lng, lat];
}

/** Grid cell index containing [lng, lat], or -1 if outside the grid. */
export function lngLatToCell(meta: TerrainMeta, lng: number, lat: number): number {
  const [w, s, e, n] = meta.bbox;
  const col = Math.floor(((lng - w) / (e - w)) * meta.width);
  const row = Math.floor(((n - lat) / (n - s)) * meta.height);
  if (col < 0 || row < 0 || col >= meta.width || row >= meta.height || !Number.isFinite(col + row)) return -1;
  return row * meta.width + col;
}
