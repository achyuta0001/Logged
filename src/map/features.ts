// OSM-derived layers whose look changes every simulated hour:
// 3D buildings (wet ground floor), roads (passability), facility markers (affected/pulse).
import type { Map as MLMap, GeoJSONSource, ExpressionSpecification } from 'maplibre-gl';
import type { OsmKind, OsmProps } from '../types';
import type { OsmFC } from '../ui/api';
import { markerImage } from '../ui/icons';
import { beforeLabels } from './mapView';

export const FACILITY_KINDS: OsmKind[] = ['school', 'hospital', 'clinic', 'metro', 'bus_stop', 'police', 'fire_station', 'substation', 'market'];

export const FACILITY_LABEL: Record<string, string> = {
  school: 'School',
  hospital: 'Hospital',
  clinic: 'Clinic',
  metro: 'Metro station',
  bus_stop: 'Bus stop',
  police: 'Police',
  fire_station: 'Fire station',
  substation: 'Substation',
  market: 'Market',
};

/** facility kinds hidden in the overview (below z15) unless flooded */
const MINOR_FACILITIES: OsmKind[] = ['bus_stop', 'school', 'market'];

const ROAD_WIDTH: Record<string, number> = { motorway: 4, trunk: 3.6, primary: 3.2, secondary: 2.6, tertiary: 2.1, residential: 1.2, unclassified: 1.2, service: 0.8 };

export class FeatureLayers {
  private map: MLMap;
  private bCells: Int32Array;
  private bState: Float32Array;
  private rCells: number[][];
  private rState: Float32Array;
  private facilities: GeoJSON.Feature<GeoJSON.Point, OsmProps & { d: number; hit: boolean }>[];
  private pulseRaf = 0;
  private lastPulse = 0;
  private visible = { buildings: true, roads: true, facilities: true };

  constructor(map: MLMap, osm: OsmFC, cellToLngLat: (cell: number) => [number, number]) {
    this.map = map;
    const before = beforeLabels();

    // ---------- roads ----------
    const roads = osm.features.filter((f) => f.properties.kind === 'road');
    this.rCells = roads.map((f) => f.properties.cells ?? [f.properties.cell]);
    this.rState = new Float32Array(roads.length);
    map.addSource('roads', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: roads.map((f, i) => ({ type: 'Feature', id: i, geometry: f.geometry, properties: { name: f.properties.name ?? '', w: ROAD_WIDTH[f.properties.highway ?? ''] ?? 1 } })) },
    });
    const depth: ExpressionSpecification = ['coalesce', ['feature-state', 'd'], 0];
    map.addLayer(
      {
        id: 'roads-wet-glow',
        type: 'line',
        source: 'roads',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['step', depth, 'rgba(0,0,0,0)', 0.15, '#ffb02e', 0.3, '#ff7a1a', 0.5, '#ff3b4f'],
          // capped for motorway/trunk so a flooded NICE Road reads as a line, not a smear
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, ['*', ['min', ['get', 'w'], 2.4], 1.8], 16, ['*', ['min', ['get', 'w'], 2.4], 4.2]],
          'line-blur': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 6],
          'line-opacity': ['step', depth, 0, 0.15, ['case', ['>=', ['get', 'w'], 3.6], 0.35, 0.55]],
        },
      },
      before,
    );
    map.addLayer(
      {
        id: 'roads',
        type: 'line',
        source: 'roads',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['step', depth, '#9fb2c9', 0.15, '#ffc24d', 0.3, '#ff8a2a', 0.5, '#ff4458'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, ['*', ['get', 'w'], 0.45], 16, ['*', ['get', 'w'], 2.2]],
          'line-opacity': ['step', depth, 0.32, 0.15, 0.95],
        },
      },
      before,
    );

    // ---------- buildings ----------
    const blds = osm.features.filter((f) => f.properties.kind === 'building');
    this.bCells = Int32Array.from(blds, (f) => f.properties.cell);
    this.bState = new Float32Array(blds.length);
    map.addSource('buildings', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: blds.map((f, i) => ({ type: 'Feature', id: i, geometry: f.geometry, properties: { h: f.properties.height ?? 7 } })) },
    });
    map.addLayer(
      {
        id: 'buildings',
        type: 'fill-extrusion',
        source: 'buildings',
        minzoom: 12.5,
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], depth, 0, '#8f9db1', 0.05, '#e9cf8d', 0.25, '#ffa024', 0.6, '#ff3b4f', 1.2, '#d0144a'],
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.82,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      before,
    );

    // ---------- facilities ----------
    this.facilities = osm.features
      .filter((f) => FACILITY_KINDS.includes(f.properties.kind))
      .map((f) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: f.geometry.type === 'Point' ? (f.geometry.coordinates as [number, number]) : cellToLngLat(f.properties.cell) },
        properties: { ...f.properties, d: 0, hit: false },
      }));
    map.addSource('facilities', { type: 'geojson', data: { type: 'FeatureCollection', features: this.facilities } });
    map.addLayer({
      id: 'facilities-pulse',
      type: 'circle',
      source: 'facilities',
      filter: ['==', ['get', 'hit'], true],
      paint: { 'circle-color': 'rgba(255,59,79,0)', 'circle-stroke-color': '#ff3b4f', 'circle-stroke-width': 2, 'circle-radius': 12, 'circle-stroke-opacity': 0.8, 'circle-pitch-alignment': 'viewport' },
    });
    map.addLayer({
      id: 'facilities',
      type: 'symbol',
      source: 'facilities',
      // overview stays readable: everyday places (bus stops, schools, markets) only
      // appear once zoomed in, unless the water reaches them
      filter: ['any', ['get', 'hit'], ['>=', ['zoom'], 15], ['!', ['in', ['get', 'kind'], ['literal', MINOR_FACILITIES]]]],
      layout: {
        'icon-image': ['concat', 'fac-', ['get', 'kind'], ['case', ['get', 'hit'], '-hit', '']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12, ['case', ['get', 'hit'], 0.38, 0.28], 16, ['case', ['get', 'hit'], 0.56, 0.46]],
        'icon-allow-overlap': ['step', ['zoom'], false, 14.5, true],
        'icon-ignore-placement': false,
        'symbol-sort-key': ['case', ['get', 'hit'], 0, ['==', ['get', 'kind'], 'bus_stop'], 2, 1],
        'icon-pitch-alignment': 'viewport',
      },
    });
    void this.loadIcons();
    this.pulse = this.pulse.bind(this);
    this.pulseRaf = requestAnimationFrame(this.pulse);
  }

  private async loadIcons() {
    await Promise.all(
      FACILITY_KINDS.flatMap((k) => [
        markerImage(k, '#dfeaf7', 'rgba(9,16,30,0.92)', 'rgba(140,190,255,0.55)').then((img) => !this.map.hasImage(`fac-${k}`) && this.map.addImage(`fac-${k}`, img, { pixelRatio: 1 })),
        markerImage(k, '#ffffff', '#e8203c', '#ffd0d6').then((img) => !this.map.hasImage(`fac-${k}-hit`) && this.map.addImage(`fac-${k}-hit`, img, { pixelRatio: 1 })),
      ]),
    );
  }

  private pulse(t: number) {
    this.pulseRaf = requestAnimationFrame(this.pulse);
    if (!this.visible.facilities || !this.facilities.some((f) => f.properties.hit)) return;
    if (t - this.lastPulse < 40) return; // ~25 fps is plenty for a pulse
    this.lastPulse = t;
    const p = (t % 1600) / 1600;
    if (this.map.getLayer('facilities-pulse')) {
      this.map.setPaintProperty('facilities-pulse', 'circle-radius', 10 + p * 18);
      this.map.setPaintProperty('facilities-pulse', 'circle-stroke-opacity', 0.9 * (1 - p));
    }
  }

  /** Apply one hour's water depth grid to all feature layers. */
  update(depth: Float32Array | null) {
    const map = this.map;
    const bs = this.bState;
    for (let i = 0; i < bs.length; i++) {
      const d = depth ? depth[this.bCells[i]] || 0 : 0;
      const q = d < 0.03 ? 0 : Math.round(d * 50) / 50;
      if (q !== bs[i]) {
        bs[i] = q;
        map.setFeatureState({ source: 'buildings', id: i }, { d: q });
      }
    }
    const rs = this.rState;
    for (let i = 0; i < rs.length; i++) {
      let mx = 0;
      if (depth) for (const c of this.rCells[i]) if (depth[c] > mx) mx = depth[c];
      const q = mx < 0.1 ? 0 : Math.round(mx * 50) / 50;
      if (q !== rs[i]) {
        rs[i] = q;
        map.setFeatureState({ source: 'roads', id: i }, { d: q });
      }
    }
    let changed = false;
    for (const f of this.facilities) {
      const d = depth ? depth[f.properties.cell] || 0 : 0;
      const hit = d > 0.15;
      if (hit !== f.properties.hit || Math.abs(d - f.properties.d) > 0.02) {
        f.properties.hit = hit;
        f.properties.d = d;
        changed = true;
      }
    }
    if (changed) (map.getSource('facilities') as GeoJSONSource).setData({ type: 'FeatureCollection', features: this.facilities });
  }

  setVisible(group: 'buildings' | 'roads' | 'facilities', v: boolean) {
    this.visible[group] = v;
    const ids = group === 'buildings' ? ['buildings'] : group === 'roads' ? ['roads', 'roads-wet-glow'] : ['facilities', 'facilities-pulse'];
    for (const id of ids) this.map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
  }

  destroy() {
    cancelAnimationFrame(this.pulseRaf);
  }
}
