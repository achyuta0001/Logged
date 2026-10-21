// Commute map layers: every hotspot as a pin coloured by its waterlogging level (in the style of the
// news-report circles: bigger = reported more often, white ring = underpass), the candidate routes
// with the chosen one coloured by level where it meets a hotspot, and the home, office and saved-place markers.
import maplibregl, { type GeoJSONSource, type Map as MLMap, type MapLayerMouseEvent } from 'maplibre-gl';
import type { LngLat } from '../../commute/spots';
import type { CommuteHotspot, RiskLevel, RouteCandidate, RouteRisk } from '../../commute/types';
import { iconSvg } from '../icons';
import { LEVEL_COLOR, rank } from './levels';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const ROUTE_BASE = '#64d2ff';
const ROUTE_ALT = '#aeb4c0';

/** Hotspot pins. Clear spots stay small and quiet; anything at watch or worse stands out. */
export class HotspotPins {
  private map: MLMap;
  private hs: CommuteHotspot[] = [];
  private idx = new Map<string, number>();
  private sel = -1;
  private onPick: (id: string) => void;
  private onClick = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (f) this.onPick(String(f.properties?.id));
  };
  private onEnter = () => (this.map.getCanvas().style.cursor = 'pointer');
  private onLeave = () => (this.map.getCanvas().style.cursor = '');

  constructor(map: MLMap, onPick: (id: string) => void) {
    this.map = map;
    this.onPick = onPick;
    map.addSource('cm-spots', { type: 'geojson', data: EMPTY });
    // one zoom interpolation per expression (a MapLibre rule): the size factor goes inside each stop
    const r = (k: number | maplibregl.ExpressionSpecification): maplibregl.ExpressionSpecification => [
      'interpolate', ['linear'], ['zoom'],
      10, ['*', k, ['interpolate', ['linear'], ['get', 'n'], 1, 3, 4, 4.5, 8, 6.5]],
      15, ['*', k, ['interpolate', ['linear'], ['get', 'n'], 1, 7, 4, 10, 8, 14]],
    ];
    map.addLayer({
      id: 'cm-spots-halo',
      type: 'circle',
      source: 'cm-spots',
      filter: ['>=', ['get', 'r'], 2],
      paint: { 'circle-color': ['get', 'c'], 'circle-opacity': 0.28, 'circle-blur': 0.7, 'circle-radius': r(2.3), 'circle-pitch-alignment': 'map' },
    });
    map.addLayer({
      id: 'cm-spots-dot',
      type: 'circle',
      source: 'cm-spots',
      paint: {
        'circle-color': ['get', 'c'],
        'circle-opacity': ['case', ['boolean', ['feature-state', 'sel'], false], 1, ['==', ['get', 'r'], 0], 0.5, 0.95],
        'circle-radius': r(['case', ['boolean', ['feature-state', 'sel'], false], 1.6, ['==', ['get', 'r'], 0], 0.8, 1.15]),
        'circle-stroke-color': ['case', ['boolean', ['feature-state', 'sel'], false], '#ffffff', ['==', ['get', 'u'], 1], '#ffffff', '#04080f'],
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'sel'], false], 3, ['==', ['get', 'u'], 1], 1.8, 0.8],
        'circle-pitch-alignment': 'map',
      },
    });
    map.on('click', 'cm-spots-dot', this.onClick);
    map.on('mouseenter', 'cm-spots-dot', this.onEnter);
    map.on('mouseleave', 'cm-spots-dot', this.onLeave);
  }

  /** draw every hotspot at its level; `only` (a route's hotspots) dims the rest */
  set(hs: CommuteHotspot[], level: (id: string) => RiskLevel, only?: Set<string>) {
    this.hs = hs;
    this.idx = new Map(hs.map((h, i) => [h.id, i]));
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: hs.map((h, i) => {
        const l = level(h.id);
        const dim = only && !only.has(h.id);
        return {
          type: 'Feature',
          id: i,
          properties: { id: h.id, n: Math.max(1, h.reportDays), u: h.type === 'underpass' ? 1 : 0, r: dim ? 0 : rank(l), c: dim ? '#6e7685' : LEVEL_COLOR[l] },
          geometry: { type: 'Point', coordinates: h.coord },
        };
      }),
    };
    (this.map.getSource('cm-spots') as GeoJSONSource | undefined)?.setData(fc);
    if (this.sel >= 0) this.map.setFeatureState({ source: 'cm-spots', id: this.sel }, { sel: true });
  }

  select(id: string | null) {
    if (this.sel >= 0) this.map.setFeatureState({ source: 'cm-spots', id: this.sel }, { sel: false });
    this.sel = id ? (this.idx.get(id) ?? -1) : -1;
    if (this.sel >= 0) this.map.setFeatureState({ source: 'cm-spots', id: this.sel }, { sel: true });
  }

  coordOf(id: string): LngLat | null {
    const i = this.idx.get(id);
    return i === undefined ? null : this.hs[i].coord;
  }

  destroy() {
    this.map.off('click', 'cm-spots-dot', this.onClick);
    this.map.off('mouseenter', 'cm-spots-dot', this.onEnter);
    this.map.off('mouseleave', 'cm-spots-dot', this.onLeave);
  }
}

/** Candidate routes: the others thin and grey, the chosen one thick, coloured by level near its hotspots. */
export class RouteLines {
  private map: MLMap;
  private onPick: (id: RouteCandidate['id']) => void;
  private onClick = (e: MapLayerMouseEvent) => {
    const id = e.features?.[0]?.properties?.route;
    if (id) this.onPick(id);
  };

  constructor(map: MLMap, before: string | undefined, onPick: (id: RouteCandidate['id']) => void) {
    this.map = map;
    this.onPick = onPick;
    map.addSource('cm-routes', { type: 'geojson', data: EMPTY });
    map.addSource('cm-route-sel', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'cm-routes-alt', type: 'line', source: 'cm-routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE_ALT, 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 15, 6] } }, before);
    map.addLayer({ id: 'cm-route-casing', type: 'line', source: 'cm-route-sel', filter: ['==', ['get', 'casing'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#04080f', 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 15, 14] } }, before);
    map.addLayer({ id: 'cm-route-line', type: 'line', source: 'cm-route-sel', filter: ['!=', ['get', 'casing'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 9] } }, before);
    map.on('click', 'cm-routes-alt', this.onClick);
  }

  /**
   * Draw the candidates. Along the chosen route, the stretch within `spanM` of each hotspot it meets
   * takes that hotspot's level at arrival; the rest is the accent colour.
   */
  set(rs: RouteCandidate[], chosen: RouteCandidate['id'] | null, risk: RouteRisk | null, spanM = 450) {
    const alt: GeoJSON.Feature[] = rs.filter((r) => r.id !== chosen).map((r) => ({ type: 'Feature', properties: { route: r.id }, geometry: { type: 'LineString', coordinates: r.line } }));
    (this.map.getSource('cm-routes') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: alt });
    const r = rs.find((x) => x.id === chosen);
    const sel: GeoJSON.Feature[] = [];
    if (r && r.line.length > 1) {
      sel.push({ type: 'Feature', properties: { casing: 1 }, geometry: { type: 'LineString', coordinates: r.line } });
      // seconds along the route -> metres, through cumS (the router's timing) and the line's own length
      const total = r.cumS[r.cumS.length - 1] || 1;
      const mAt = (s: number) => (s / total) * r.lengthM;
      const colourAt = (i: number) => {
        const m = mAt(r.cumS[i] ?? 0);
        let best: RiskLevel | null = null;
        for (const h of risk?.hits ?? []) if (rank(h.level) > 0 && Math.abs(mAt(h.atS) - m) <= spanM && (!best || rank(h.level) > rank(best))) best = h.level;
        return best ? LEVEL_COLOR[best] : ROUTE_BASE;
      };
      let run: LngLat[] = [r.line[0]];
      let c = colourAt(0);
      for (let i = 1; i < r.line.length; i++) {
        const ci = colourAt(i);
        run.push(r.line[i]);
        if (ci !== c || i === r.line.length - 1) {
          sel.push({ type: 'Feature', properties: { c }, geometry: { type: 'LineString', coordinates: run } });
          run = [r.line[i]];
          c = ci;
        }
      }
    }
    (this.map.getSource('cm-route-sel') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: sel });
  }

  destroy() {
    this.map.off('click', 'cm-routes-alt', this.onClick);
  }
}

export type EndKind = 'home' | 'office' | 'place';
/** a place with a marker: its id (home, office or a saved place's), kind, point, name ("Gym") and where it is */
export interface EndMark {
  id: string;
  kind: EndKind;
  coord: LngLat;
  name: string;
  label: string;
}
const END_ICON: Record<EndKind, string> = { home: 'home', office: 'office', place: 'pin' };

/** Home, office and saved-place markers; drag one to move it. */
export class Ends {
  private map: MLMap;
  private m = new Map<string, maplibregl.Marker>();
  private onMove: (id: string, p: LngLat) => void;

  constructor(map: MLMap, onMove: (id: string, p: LngLat) => void) {
    this.map = map;
    this.onMove = onMove;
  }

  /** a marker for each of these places, moved and relabelled in place; any other is removed */
  setAll(items: EndMark[]) {
    const keep = new Set(items.map((x) => x.id));
    for (const [id, mk] of this.m) {
      if (keep.has(id)) continue;
      mk.remove();
      this.m.delete(id);
    }
    for (const x of items) {
      let mk = this.m.get(x.id);
      if (mk && mk.getElement().dataset.kind !== x.kind) {
        mk.remove();
        mk = undefined;
      }
      if (!mk) {
        const el = document.createElement('div');
        el.className = `cm-end-mk cm-end-${x.kind}`;
        el.dataset.kind = x.kind;
        el.setAttribute('role', 'img');
        el.innerHTML = iconSvg(END_ICON[x.kind], x.kind === 'place' ? 13 : 15, 2);
        const made: maplibregl.Marker = new maplibregl.Marker({ element: el, draggable: true, anchor: 'center' }).setLngLat(x.coord).addTo(this.map);
        made.on('dragend', () => {
          const ll = made.getLngLat();
          this.onMove(x.id, [ll.lng, ll.lat]);
        });
        this.m.set(x.id, made);
        mk = made;
      }
      mk.setLngLat(x.coord);
      mk.getElement().setAttribute('aria-label', `${x.name}: ${x.label}`);
      mk.getElement().title = `${x.name}: ${x.label} (drag to move)`;
    }
  }

  destroy() {
    for (const mk of this.m.values()) mk.remove();
    this.m.clear();
  }
}
