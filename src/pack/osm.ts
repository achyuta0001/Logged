// Pack format v2 stores osm.geojson without the per-feature grid cells (they are most of a road's
// bytes and are pure functions of geometry + grid). This rebuilds them on load exactly as
// scripts/build-data.mjs computes them: `cell` = grid cell of the vertex centroid (turf.centroid:
// mean of all vertices, ring closing vertices excluded), roads/drains `cells` = cells touched when
// sampling each segment every 0.5 (roads) / 0.25 (drains) cells, unique and in order.
import type { OsmProps, TerrainMeta } from '../types.ts';
import { lngLatToCell } from '../terrain.ts';

type FC = GeoJSON.FeatureCollection<GeoJSON.Geometry, OsmProps>;

export function deriveOsmCells(osm: FC, meta: TerrainMeta): void {
  const [w, s, e, n] = meta.bbox;
  const W = meta.width;
  const H = meta.height;
  const dLon = (e - w) / W;
  const dLat = (n - s) / H;
  const col = (lon: number) => (lon - w) / dLon;
  const row = (lat: number) => (n - lat) / dLat;
  for (const f of osm.features) {
    const p = f.properties;
    const g = f.geometry;
    if (!g) continue;
    if (p.cell === undefined) {
      const c = centroid(g);
      p.cell = c ? lngLatToCell(meta, c[0], c[1]) : -1;
    }
    if (p.cells === undefined && (p.kind === 'road' || p.kind === 'drain')) {
      const step = p.kind === 'road' ? 0.5 : 0.25;
      const out: number[] = [];
      const seen = new Set<number>();
      const push = (lon: number, lat: number) => {
        const idx = lngLatToCell(meta, lon, lat);
        if (idx >= 0 && !seen.has(idx)) {
          seen.add(idx);
          out.push(idx);
        }
      };
      for (const ln of lines(g)) {
        for (let i = 0; i + 1 < ln.length; i++) {
          const a = ln[i];
          const b = ln[i + 1];
          const dc = col(b[0]) - col(a[0]);
          const dr = row(b[1]) - row(a[1]);
          const k = Math.max(1, Math.ceil(Math.hypot(dc, dr) / step));
          for (let j = 0; j <= k; j++) {
            const t = j / k;
            push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
          }
        }
        if (ln.length === 1) push(ln[0][0], ln[0][1]);
      }
      p.cells = out;
    }
  }
}

function lines(g: GeoJSON.Geometry): GeoJSON.Position[][] {
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates;
  if (g.type === 'Polygon') return g.coordinates;
  if (g.type === 'MultiPolygon') return g.coordinates.flat();
  return [];
}

/** turf.centroid: mean of all vertices; the closing vertex of each polygon ring is skipped */
function centroid(g: GeoJSON.Geometry): [number, number] | null {
  let sx = 0;
  let sy = 0;
  let k = 0;
  const add = (c: GeoJSON.Position) => {
    sx += c[0];
    sy += c[1];
    k++;
  };
  if (g.type === 'Point') return [g.coordinates[0], g.coordinates[1]];
  if (g.type === 'LineString' || g.type === 'MultiPoint') g.coordinates.forEach(add);
  else if (g.type === 'MultiLineString') g.coordinates.forEach((l) => l.forEach(add));
  else if (g.type === 'Polygon') g.coordinates.forEach((r) => r.slice(0, -1).forEach(add));
  else if (g.type === 'MultiPolygon') g.coordinates.forEach((p) => p.forEach((r) => r.slice(0, -1).forEach(add)));
  return k ? [sx / k, sy / k] : null;
}
