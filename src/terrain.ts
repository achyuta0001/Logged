import type { GridLayerName, Terrain, TerrainMeta } from './types.ts';

/**
 * Load public/data/meta.json + grids.bin and build typed-array views per layer.
 * `offset` in meta.layers is a BYTE offset; `length` is in elements.
 */
export async function loadTerrain(base = '/data'): Promise<Terrain> {
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
  for (const [name, l] of Object.entries(meta.layers) as [GridLayerName, TerrainMeta['layers'][GridLayerName]][]) {
    const bytesPer = l.dtype === 'f32' ? 4 : 1;
    if (l.offset + l.length * bytesPer > buf.byteLength) {
      throw new Error(`grids.bin too short for layer ${name}`);
    }
    if (l.dtype === 'f32') {
      // Float32Array needs 4-byte alignment; copy if misaligned.
      grids[name] =
        l.offset % 4 === 0
          ? new Float32Array(buf, l.offset, l.length)
          : new Float32Array(buf.slice(l.offset, l.offset + l.length * 4));
    } else {
      grids[name] = new Uint8Array(buf, l.offset, l.length);
    }
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
