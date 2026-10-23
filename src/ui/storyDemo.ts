// Standalone harness for story.ts / tour.ts (story-demo.html). Not part of the app.
// URL params: ?tour=<i> start tour at stop i · ?model=1 fake model depths · ?orbit=1
import '../style.css';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Depression, Hotspot, TerrainMeta } from '../types';
import { mountStoryPanel } from './story';
import { createTour, orbit } from './tour';
import { fetchPackJson } from '../pack/fetch';

maplibregl.setWorkerUrl(workerUrl); // as src/map/mapView.ts: maplibre-gl 6 needs the bundled worker

const q = new URLSearchParams(location.search);
// the 560098 reference pack (format 2: depressions.json is stored gzipped)
const PACK = '/data/pins/560098';
const [hotspots, depressions, meta] = await Promise.all([
  fetchPackJson<Hotspot[]>(`${PACK}/hotspots.json`),
  fetchPackJson<Depression[]>(`${PACK}/depressions.json`, { gz: true }),
  fetchPackJson<TerrainMeta>(`${PACK}/meta.json`),
]);

// NOTE: CARTO raster tiles now return an "API KEY REQUIRED" placeholder, so the demo uses OpenFreeMap.
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  center: [77.5157, 12.9157],
  zoom: 13.4,
  pitch: 60,
  maxPitch: 82,
});
(window as any).__map = map;
(window as any).__ML = maplibregl;

// demo-only stand-in for the flood engine: deeper near big basins
const fake = q.get('model')
  ? (lng: number, lat: number) => {
      let d = 0;
      for (const p of depressions.slice(0, 40)) {
        const m = Math.hypot((p.centroid[0] - lng) * 108_000, (p.centroid[1] - lat) * 111_000);
        d = Math.max(d, Math.min(p.maxDepthM, 1.2) * Math.exp(-m / 180));
      }
      return d;
    }
  : undefined;

const tour = createTour(map, { hotspots, depressions, getModelDepthAt: fake, onStep: (i) => console.log('step', i) });
(window as any).__tour = tour;
mountStoryPanel(document.getElementById('left')!, {
  hotspots,
  depressions,
  getModelDepthAt: fake,
  onFocus: (c) => map.flyTo({ center: c, zoom: 16, pitch: 64 }),
  onTour: () => tour.start(),
});

map.on('load', () => {
  map.addSource('dem', { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 15 });
  map.setTerrain({ source: 'dem', exaggeration: 2.4 });
  map.addSource('boundary', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: meta.boundary } });
  map.addLayer({ id: 'b-glow', type: 'line', source: 'boundary', paint: { 'line-color': '#5fe0ff', 'line-width': 5, 'line-blur': 4, 'line-opacity': 0.5 } });
  map.addLayer({ id: 'b', type: 'line', source: 'boundary', paint: { 'line-color': '#d6f6ff', 'line-width': 1.1 } });
  if (q.has('tour')) tour.start(Number(q.get('tour')) || 0);
  if (q.get('orbit')) orbit(map, true);
});
