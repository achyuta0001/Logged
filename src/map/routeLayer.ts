// "Your place" map overlay: pinned-place marker (pulsing ring), escape route coloured by
// passability (dry teal, wet amber, impassable red), the usual route when we detour around a
// blockage (dashed), and markers for the destination and the first blockage.
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import type { LngLat, RouteResult } from '../place/route';
import { beforeLabels } from './mapView';
import '../ui/place.css';

export const ROUTE_COLORS = { dry: '#2fe0d0', wet: '#ffb02e', blocked: '#ff3b4f' } as const;

const SRC = 'place-route';
const SRC_USUAL = 'place-route-usual';
const LAYERS = ['place-route-usual', 'place-route-usual-cut-glow', 'place-route-usual-cut', 'place-route-casing', 'place-route-glow', 'place-route-line'];
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const ICON_HOME =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5"/><path d="M6.5 9v10.5h11V9"/><path d="M10 19.5v-5h4v5"/></svg>';
const ICON_FLAG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 21V4"/><path d="M6 4.5h11l-2.4 4 2.4 4H6"/></svg>';
const svg13 = (body: string) =>
  `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export type DestKind = 'metro' | 'hospital' | 'main_road' | 'bus_stop' | 'custom';
const DEST_ICON: Record<DestKind, string> = {
  metro: svg13('<rect x="6" y="3.5" width="12" height="13" rx="3.2"/><path d="M6 10.5h12M9 20.5l1.5-3.5M15 20.5 13.5 17"/>'),
  hospital: svg13('<path d="M12 5v14M5 12h14"/>'),
  main_road: svg13('<path d="M8.5 3.5 5.5 20.5M15.5 3.5l3 17M12 5v2.5M12 10.75v2.5M12 16.5V19"/>'),
  bus_stop: svg13('<rect x="5.5" y="4" width="13" height="13" rx="3"/><path d="M5.5 11h13M8 17v2.5M16 17v2.5"/>'),
  custom: ICON_FLAG,
};
const ICON_STOP =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M12 6.5v7M12 17.6v.1"/></svg>';

function el(cls: string, html: string, label?: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  if (label) {
    d.setAttribute('role', 'img');
    d.setAttribute('aria-label', label);
  }
  return d;
}

export class RouteLayer {
  private map: MLMap;
  private place: maplibregl.Marker | null = null;
  private dest: maplibregl.Marker | null = null;
  private block: maplibregl.Marker | null = null;
  private onStyle = () => this.ensureLayers();
  private last: { r: RouteResult | null; dest: LngLat | null; kind: DestKind } = { r: null, dest: null, kind: 'custom' };

  constructor(map: MLMap) {
    this.map = map;
    this.ensureLayers();
    // a basemap/style swap drops custom sources: put ours back
    map.on('styledata', this.onStyle);
  }

  private ensureLayers() {
    const map = this.map;
    if (map.getSource(SRC)) return;
    try {
      map.addSource(SRC, { type: 'geojson', data: EMPTY });
    } catch {
      // style still loading (or being swapped): try again once it settles
      map.once('idle', this.onStyle);
      return;
    }
    map.addSource(SRC_USUAL, { type: 'geojson', data: EMPTY });
    const anchor = beforeLabels();
    const before = anchor && map.getLayer(anchor) ? anchor : undefined;
    const color: maplibregl.ExpressionSpecification = ['match', ['get', 'state'], 'wet', ROUTE_COLORS.wet, 'blocked', ROUTE_COLORS.blocked, ROUTE_COLORS.dry];
    const sortKey: maplibregl.DataDrivenPropertyValueSpecification<number> = ['match', ['get', 'state'], 'blocked', 2, 'wet', 1, 0];
    // the usual (dry-day) route when we detour: dashed, with its flooded stretch in solid red
    map.addLayer(
      {
        id: 'place-route-usual',
        type: 'line',
        source: SRC_USUAL,
        filter: ['!=', ['get', 'state'], 'blocked'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#e6edf7',
          'line-opacity': 0.75,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.8, 16, 3.4],
          'line-dasharray': [0.3, 2],
        },
      },
      before,
    );
    map.addLayer(
      {
        id: 'place-route-usual-cut-glow',
        type: 'line',
        source: SRC_USUAL,
        filter: ['==', ['get', 'state'], 'blocked'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ROUTE_COLORS.blocked, 'line-opacity': 0.45, 'line-blur': 6, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 8, 16, 16] },
      },
      before,
    );
    map.addLayer(
      {
        id: 'place-route-usual-cut',
        type: 'line',
        source: SRC_USUAL,
        filter: ['==', ['get', 'state'], 'blocked'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ROUTE_COLORS.blocked, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.4, 16, 5] },
      },
      before,
    );
    map.addLayer(
      {
        id: 'place-route-casing',
        type: 'line',
        source: SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#02060d', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 5.5, 16, 12] },
      },
      before,
    );
    map.addLayer(
      {
        id: 'place-route-glow',
        type: 'line',
        source: SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': sortKey },
        paint: {
          'line-color': color,
          'line-opacity': 0.5,
          'line-blur': ['interpolate', ['linear'], ['zoom'], 12, 5, 16, 10],
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 9, 16, 20],
        },
      },
      before,
    );
    map.addLayer(
      {
        id: 'place-route-line',
        type: 'line',
        source: SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': sortKey },
        paint: { 'line-color': color, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.6, 16, 5.5] },
      },
      before,
    );
    if (this.last.r) this.setRoute(this.last.r, this.last.dest, this.last.kind);
  }

  /** Pin (or clear) the user's place. */
  setPlace(p: LngLat | null) {
    if (!p) {
      this.place?.remove();
      this.place = null;
      return;
    }
    if (!this.place) {
      const e = el('pl-mk pl-mk-place', `<i></i><i></i><span>${ICON_HOME}</span>`, 'Your place');
      this.place = new maplibregl.Marker({ element: e, anchor: 'center' }).setLngLat(p).addTo(this.map);
    } else this.place.setLngLat(p);
  }

  /**
   * Draw a route (or clear it). `dest` places the destination marker (defaults to the route end);
   * `kind` picks its glyph.
   */
  setRoute(r: RouteResult | null, dest: LngLat | null = null, kind: DestKind = 'custom') {
    this.last = { r, dest, kind };
    const map = this.map;
    const src = map.getSource(SRC) as GeoJSONSource | undefined;
    const usual = map.getSource(SRC_USUAL) as GeoJSONSource | undefined;
    if (!r || !r.coords.length) {
      src?.setData(EMPTY);
      usual?.setData(EMPTY);
      this.dest?.remove();
      this.dest = null;
      this.block?.remove();
      this.block = null;
      return;
    }
    src?.setData({
      type: 'FeatureCollection',
      features: r.segments.map((s) => ({ type: 'Feature', properties: { state: s.state }, geometry: { type: 'LineString', coordinates: s.coords } })),
    });
    usual?.setData({
      type: 'FeatureCollection',
      features: (r.usual?.segments ?? []).map((s) => ({ type: 'Feature', properties: { state: s.state }, geometry: { type: 'LineString', coordinates: s.coords } })),
    });
    const end = dest ?? r.coords[r.coords.length - 1];
    if (!this.dest) {
      const e = el('pl-mk pl-mk-dest', '', 'Destination');
      this.dest = new maplibregl.Marker({ element: e, anchor: 'center' }).setLngLat(end).addTo(map);
    } else this.dest.setLngLat(end);
    this.dest.getElement().innerHTML = DEST_ICON[kind] ?? ICON_FLAG;
    this.dest.getElement().classList.toggle('cut', !r.ok);
    if (r.blocked) {
      const label = `Blocked: ${r.blocked.roadName}, ${Math.round(r.blocked.depthM * 100)} cm of water`;
      if (!this.block) {
        const e = el('pl-mk pl-mk-block', `<i></i>${ICON_STOP}`, label);
        this.block = new maplibregl.Marker({ element: e, anchor: 'center' }).setLngLat(r.blocked.coord).addTo(map);
      } else this.block.setLngLat(r.blocked.coord);
      this.block.getElement().setAttribute('aria-label', label);
      this.block.getElement().title = label;
    } else {
      this.block?.remove();
      this.block = null;
    }
  }

  /** Fit the camera to the route (plus an extra point, e.g. the pinned place). */
  fit(r: RouteResult, extra?: LngLat, padding = 90) {
    const pts = [...r.coords, ...(r.usual?.coords ?? []), ...(extra ? [extra] : [])];
    if (pts.length < 2) return;
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const p of pts) b.extend(p);
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.map.fitBounds(b, { padding, maxZoom: 16.6, bearing: this.map.getBearing(), pitch: Math.min(this.map.getPitch(), 50), duration: reduce ? 0 : 1200 });
  }

  destroy() {
    const map = this.map;
    map.off('styledata', this.onStyle);
    this.setPlace(null);
    this.setRoute(null);
    for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
    for (const s of [SRC, SRC_USUAL]) if (map.getSource(s)) map.removeSource(s);
  }
}
