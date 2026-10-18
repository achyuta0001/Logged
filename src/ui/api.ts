// Thin adapter over the real data / sim modules (CONTRACT.md).
import type { Depression, Hotspot, OsmProps, Terrain } from '../types';
import { loadTerrain } from '../terrain';
import { deriveOsmCells } from '../pack/osm';
import { fetchPackJson } from '../pack/fetch';

export type OsmFC = GeoJSON.FeatureCollection<GeoJSON.Geometry, OsmProps>;

/** `gz`: format-2 packs store this file as `<file>.gz` (src/pack/fetch.ts); the plain file is the fallback */
async function fetchJson<T>(url: string, required: boolean, gz = false): Promise<T | undefined> {
  try {
    return await fetchPackJson<T>(url, { gz });
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
    fetchJson<OsmFC>(`${base}/osm.geojson`, true, true),
    fetchJson<Depression[]>(`${base}/depressions.json`, false, true),
    fetchJson<Hotspot[]>(`${base}/hotspots.json`, false),
  ]);
  // v2 packs leave the grid cells out of osm.geojson; rebuild them against this grid
  if ((terrain.meta.format ?? 1) >= 2) deriveOsmCells(osm!, terrain.meta);
  return { terrain, osm: osm!, depressions: depressions ?? [], hotspots: hotspots ?? [] };
}
