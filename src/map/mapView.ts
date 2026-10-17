// Map construction: open basemaps (OpenFreeMap vector dark, EOX Sentinel-2 cloudless),
// AWS terrarium 3D terrain, hillshade, sky/fog, pincode boundary glow and outside mask.
import maplibregl, { type Map as MLMap, type StyleSpecification, type LayerSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export const CENTER: [number, number] = [77.5157, 12.9157];

const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const EOX = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg';
const OFM_DARK = 'https://tiles.openfreemap.org/styles/dark';

const ATTR_TERRAIN = 'Terrain: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen/Tilezen terrain tiles (SRTM, GMTED, ETOPO1 and others)</a>';
const ATTR_EOX = '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless by EOX IT Services GmbH</a> (contains modified Copernicus Sentinel data 2020)';
const ATTR_OFM = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>';

export type Basemap = 'dark' | 'satellite';

/** Layer id overlays are inserted beneath (keeps basemap labels on top). */
export let OVERLAY_ANCHOR: string | undefined;
/** Basemap vector layer ids that hide when satellite is on. */
let vectorBaseLayers: string[] = [];

async function loadBaseStyle(): Promise<StyleSpecification> {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(OFM_DARK, { signal: ctl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error(String(r.status));
    const s = (await r.json()) as StyleSpecification;
    const src = s.sources.openmaptiles as { attribution?: string };
    if (src) src.attribution = ATTR_OFM;
    return s;
  } catch (e) {
    console.warn('[map] OpenFreeMap style unavailable, using a plain dark background', e);
    return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#060b14' } }] };
  }
}

function retheme(style: StyleSpecification) {
  // Push the OpenFreeMap dark style toward a cold, ink-blue palette and drop its flat buildings.
  const keep: LayerSpecification[] = [];
  for (const l of style.layers) {
    if (l.id === 'building') continue;
    if (l.type === 'background') (l.paint ??= {})['background-color'] = '#060b14';
    if (l.type === 'fill' && l.paint && 'fill-pattern' in l.paint) delete (l.paint as Record<string, unknown>)['fill-pattern'];
    if (l.id === 'water' && l.type === 'fill') l.paint = { ...l.paint, 'fill-color': '#0b2140' };
    if (l.id.startsWith('landuse') || l.id.startsWith('landcover')) {
      if (l.type === 'fill') l.paint = { ...l.paint, 'fill-opacity': 0.35 };
    }
    // basemap roads stay neutral so amber/red always means "flooded road"
    if (l.type === 'line' && (l.id.startsWith('highway') || l.id.startsWith('road') || l.id.startsWith('railway') || l.id.startsWith('aeroway'))) {
      l.paint = { ...l.paint, 'line-color': l.id.includes('casing') ? 'rgba(0,0,0,0)' : '#1c2738' };
    }
    if (l.type === 'symbol' && l.paint) {
      l.paint = { ...l.paint, 'text-color': '#8ea3bf', 'text-halo-color': 'rgba(4,8,16,0.9)' };
    }
    keep.push(l);
  }
  style.layers = keep;
  // Overlays go above every basemap fill/line (so water covers road lines) and below road/place labels.
  const lastLine = keep.reduce((acc, l, i) => (l.type !== 'symbol' && l.type !== 'background' ? i : acc), -1);
  const anchor = keep.find((l) => l.id === 'highway_name_other') ?? keep.slice(lastLine + 1).find((l) => l.type === 'symbol');
  OVERLAY_ANCHOR = anchor?.id;
  vectorBaseLayers = keep.filter((l) => l.type !== 'symbol' && l.type !== 'background').map((l) => l.id);
}

export async function createMap(container: HTMLElement, boundary: GeoJSON.Geometry, exaggeration: number): Promise<MLMap> {
  const style = await loadBaseStyle();
  retheme(style);

  style.sources['eox'] = { type: 'raster', tiles: [EOX], tileSize: 256, maxzoom: 15, attribution: ATTR_EOX };
  // terrain maxzoom matches the vector basemap (z14): overscaled basemap tiles above a deeper DEM
  // trigger a MapLibre warning, and z14 terrarium (~9 m) already out-resolves the ~30 m SRTM data
  style.sources['dem'] = { type: 'raster-dem', tiles: [TERRARIUM], encoding: 'terrarium', tileSize: 256, maxzoom: 14, attribution: ATTR_TERRAIN };
  style.sources['dem-hs'] = { type: 'raster-dem', tiles: [TERRARIUM], encoding: 'terrarium', tileSize: 256, maxzoom: 15 };
  const bgIdx = style.layers.findIndex((l) => l.type === 'background');
  style.layers.splice(
    bgIdx + 1,
    0,
    {
      id: 'eox',
      type: 'raster',
      source: 'eox',
      layout: { visibility: 'none' },
      paint: { 'raster-brightness-max': 0.62, 'raster-saturation': -0.45, 'raster-contrast': 0.12, 'raster-fade-duration': 200 },
    },
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'dem-hs',
      paint: {
        'hillshade-shadow-color': 'rgba(0,0,0,0.75)',
        'hillshade-highlight-color': 'rgba(150,190,255,0.22)',
        'hillshade-accent-color': 'rgba(10,20,40,0.6)',
        'hillshade-exaggeration': 0.55,
        'hillshade-illumination-direction': 315,
      },
    },
  );
  style.terrain = { source: 'dem', exaggeration };
  style.sky = {
    'sky-color': '#050a14',
    'horizon-color': '#12305a',
    'fog-color': '#060c18',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.55,
    'fog-ground-blend': 0.35,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 0.4],
  };

  const map = new maplibregl.Map({
    container,
    style,
    center: [CENTER[0] - 0.002, CENTER[1] - 0.012],
    zoom: 13.55,
    pitch: 62,
    bearing: -18,
    maxPitch: 82,
    attributionControl: false,
    canvasContextAttributes: { antialias: true, preserveDrawingBuffer: false },
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), 'top-right');

  await new Promise<void>((res) => map.once('load', () => res()));
  // calm start: attribution stays one tap away (the "i" button), not a strip across the map
  container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  addBoundary(map, boundary);
  return map;
}

function rings(geom: GeoJSON.Geometry): GeoJSON.Position[][] {
  if (geom.type === 'Polygon') return [geom.coordinates[0]];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map((p) => p[0]);
  if (geom.type === 'GeometryCollection') return geom.geometries.flatMap(rings);
  return [];
}

function addBoundary(map: MLMap, boundary: GeoJSON.Geometry) {
  const world: GeoJSON.Position[] = [
    [-180, -85],
    [180, -85],
    [180, 85],
    [-180, 85],
    [-180, -85],
  ];
  const holes = rings(boundary).map((r) => [...r].reverse());
  map.addSource('mask', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [world, ...holes] } } });
  map.addSource('boundary', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: boundary } });
  map.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#02050b', 'fill-opacity': 0.58 } }, OVERLAY_ANCHOR);
  map.addLayer({ id: 'boundary-glow-wide', type: 'line', source: 'boundary', paint: { 'line-color': '#3fd4ff', 'line-width': 14, 'line-blur': 12, 'line-opacity': 0.28 } });
  map.addLayer({ id: 'boundary-glow', type: 'line', source: 'boundary', paint: { 'line-color': '#5fe0ff', 'line-width': 4, 'line-blur': 3, 'line-opacity': 0.6 } });
  map.addLayer({ id: 'boundary-line', type: 'line', source: 'boundary', paint: { 'line-color': '#d6f6ff', 'line-width': 1.1, 'line-opacity': 0.95 } });
}

export function setBasemap(map: MLMap, b: Basemap) {
  const sat = b === 'satellite';
  map.setLayoutProperty('eox', 'visibility', sat ? 'visible' : 'none');
  for (const id of vectorBaseLayers) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, 'visibility', sat ? 'none' : 'visible');
  }
  map.setPaintProperty('hillshade', 'hillshade-exaggeration', sat ? 0.3 : 0.55);
}

export function setExaggeration(map: MLMap, ex: number) {
  map.setTerrain({ source: 'dem', exaggeration: ex });
}

/** Overlay insertion helper — keeps overlays under basemap labels but above the mask. */
export function beforeLabels(): string | undefined {
  return OVERLAY_ANCHOR;
}
