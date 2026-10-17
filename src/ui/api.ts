// Thin adapter over the real data / sim modules (CONTRACT.md).
import type { Depression, Hotspot, OsmProps, Terrain } from '../types';
import { loadTerrain } from '../terrain';

export type OsmFC = GeoJSON.FeatureCollection<GeoJSON.Geometry, OsmProps>;

async function fetchJson<T>(url: string, required: boolean): Promise<T | undefined> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const ct = r.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) throw new Error(`${url}: missing`); // Vite SPA fallback
    return (await r.json()) as T;
  } catch (e) {
    if (required) throw e;
    console.warn('[data] optional file unavailable', url, e);
    return undefined;
  }
}

export interface Dataset {
  terrain: Terrain;
  osm: OsmFC;
  depressions: Depression[];
  hotspots: Hotspot[];
}

export async function loadDataset(base = '/data'): Promise<Dataset> {
  const [terrain, osm, depressions, hotspots] = await Promise.all([
    loadTerrain(base),
    fetchJson<OsmFC>(`${base}/osm.geojson`, true),
    fetchJson<Depression[]>(`${base}/depressions.json`, false),
    fetchJson<Hotspot[]>(`${base}/hotspots.json`, false),
  ]);
  return { terrain, osm: osm!, depressions: depressions ?? [], hotspots: hotspots ?? [] };
}
