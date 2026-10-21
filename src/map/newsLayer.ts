// "Reported floods in the news": spots from public/data/news-spots.json as circles sized by the
// number of flood days reported; underpasses get a white ring. Tap a circle for "Flooded in
// reports N times, 2017–2024" and up to three linked sources. Used in a pincode (Map layers,
// off by default), in the city overview, and for the spots on a commute route (always shown there).
// The sidebar's "Reported flood spots" list (src/ui/spotList.ts) opens the same card from the keyboard.
import maplibregl, { type GeoJSONSource, type Map as MLMap, type MapLayerMouseEvent } from 'maplibre-gl';
import type { NewsSpot } from '../commute/spots';
import type { Verdict } from '../commute/verdict';
import { loadNewsSpots } from '../commute/data';
import { beforeLabels } from './mapView';

export const NEWS_COLOR = '#ffb340';
const VERDICT_COLOR: Record<Verdict, string> = { clear: '#2fe0d0', watch: '#ffd60a', flooded: '#ff453a' };
const KIND_LABEL: Record<NewsSpot['kind'], string> = { underpass: 'Underpass', junction: 'Junction', road: 'Road', layout: 'Neighbourhood', other: 'Place' };

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmtDate = (d: string) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : d;
};

/** "Flooded in reports 6 times, 2017–2024" */
export function reportLine(s: NewsSpot): string {
  const years = s.firstYear === s.lastYear ? `in ${s.firstYear}` : `${s.firstYear}–${s.lastYear}`;
  return s.count === 1 ? `Flooded in reports once, ${years}` : `Flooded in reports ${s.count} times, ${years}`;
}

export function spotPopupHtml(s: NewsSpot, extra = ''): string {
  return `<div class="pop">
    <div class="pop-title">${esc(s.name)}</div>
    <div class="pop-sub">${KIND_LABEL[s.kind]} · ${esc(reportLine(s))}</div>${extra}
    <ul class="pop-events">${s.reports
      .slice(0, 3)
      .map((r) => `<li><time>${esc(fmtDate(r.date))}</time><p>${esc(r.summary)}</p><a href="${encodeURI(r.url)}" target="_blank" rel="noopener">${esc(r.outlet)}</a></li>`)
      .join('')}</ul>
    ${s.reports.length > 3 ? `<div class="pop-sub">${s.reports.length - 3} more report${s.reports.length - 3 === 1 ? '' : 's'}</div>` : ''}</div>`;
}

const fc = (spots: NewsSpot[], extra?: (s: NewsSpot) => Record<string, unknown>): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: spots.map((s, i) => ({ type: 'Feature', id: i, properties: { i, count: s.count, u: s.kind === 'underpass' ? 1 : 0, ...extra?.(s) }, geometry: { type: 'Point', coordinates: s.coord } })),
});

/** circles sized by reported flood days, a little larger as you zoom in */
const radius = (k = 1): maplibregl.ExpressionSpecification => [
  'interpolate', ['linear'], ['zoom'],
  10, ['*', k, ['interpolate', ['linear'], ['get', 'count'], 1, 2.5, 4, 4.5, 8, 7]],
  15, ['*', k, ['interpolate', ['linear'], ['get', 'count'], 1, 6, 4, 10, 8, 15]],
];

/** One set of spots on the map: the full layer, or the spots on a route (`id` keeps them apart). */
class SpotLayer {
  protected spots: NewsSpot[] = [];
  private popup: maplibregl.Popup | null = null;
  private visible = false;
  private onStyle = () => this.ensure();
  private onClick = (e: MapLayerMouseEvent) => {
    // a tap on an HTML marker drawn over this spot (a curated hotspot) opens that marker's own
    // popup; opening ours as well would stack two cards on the same place
    if ((e.originalEvent?.target as Element | null)?.closest?.('.maplibregl-marker')) return;
    const s = this.spots[Number(e.features?.[0]?.properties?.i)];
    if (s) this.open(s);
  };
  private onEnter = () => (this.map.getCanvas().style.cursor = 'pointer');
  private onLeave = () => (this.map.getCanvas().style.cursor = '');

  protected map: MLMap;
  private id: string;
  private paint: (id: string) => maplibregl.LayerSpecification[];

  constructor(map: MLMap, id: string, paint: (id: string) => maplibregl.LayerSpecification[]) {
    this.map = map;
    this.id = id;
    this.paint = paint;
    map.on('styledata', this.onStyle);
  }

  protected html(s: NewsSpot) {
    return spotPopupHtml(s);
  }

  /** A spot's card, as a tap on its circle opens it; `focus: false` leaves keyboard focus where it is (the sidebar list) */
  open(s: NewsSpot, focus = true) {
    this.popup?.remove();
    this.popup = new maplibregl.Popup({ offset: 12, maxWidth: '320px', className: 'glass-popup', focusAfterOpen: focus }).setLngLat(s.coord).setHTML(this.html(s)).addTo(this.map);
  }

  protected data(): GeoJSON.FeatureCollection {
    return fc(this.spots);
  }

  protected ensure() {
    const map = this.map;
    if (!this.visible || map.getSource(this.id)) return;
    try {
      map.addSource(this.id, { type: 'geojson', data: this.data() });
    } catch {
      map.once('idle', this.onStyle); // style still loading or being swapped
      return;
    }
    const anchor = beforeLabels();
    const before = anchor && map.getLayer(anchor) ? anchor : undefined;
    for (const l of this.paint(this.id)) map.addLayer(l, before);
    const hit = `${this.id}-dot`;
    map.on('click', hit, this.onClick);
    map.on('mouseenter', hit, this.onEnter);
    map.on('mouseleave', hit, this.onLeave);
  }

  protected refresh() {
    const src = this.map.getSource(this.id) as GeoJSONSource | undefined;
    if (src) src.setData(this.data());
    else this.ensure();
  }

  setVisible(v: boolean) {
    this.visible = v;
    if (v) this.ensure();
    for (const l of this.paint(this.id)) if (this.map.getLayer(l.id)) this.map.setLayoutProperty(l.id, 'visibility', v ? 'visible' : 'none');
    if (!v) this.popup?.remove();
  }

  destroy() {
    this.popup?.remove();
    this.map.off('styledata', this.onStyle);
    const hit = `${this.id}-dot`;
    this.map.off('click', hit, this.onClick);
    this.map.off('mouseenter', hit, this.onEnter);
    this.map.off('mouseleave', hit, this.onLeave);
    try {
      for (const l of this.paint(this.id)) if (this.map.getLayer(l.id)) this.map.removeLayer(l.id);
      if (this.map.getSource(this.id)) this.map.removeSource(this.id);
    } catch {
      /* map already removed */
    }
  }
}

/** Every reported spot (Map layers > "Flood reports in the news", and the city overview). */
export class NewsLayer extends SpotLayer {
  readonly ready: Promise<NewsSpot[]>;
  constructor(map: MLMap, id = 'news') {
    super(map, id, (p) => [
      {
        id: `${p}-dot`,
        type: 'circle',
        source: p,
        paint: {
          'circle-color': NEWS_COLOR,
          'circle-opacity': 0.82,
          'circle-radius': radius(),
          'circle-stroke-color': ['case', ['==', ['get', 'u'], 1], '#ffffff', '#3a2400'],
          'circle-stroke-width': ['case', ['==', ['get', 'u'], 1], 2.2, 0.8],
          'circle-pitch-alignment': 'map',
        },
      },
    ]);
    this.ready = loadNewsSpots().then((s) => {
      this.spots = s;
      this.refresh();
      return s;
    });
  }
}

/** The reported spots along a commute, coloured by the verdict at the departure hour. */
export class RouteSpotsLayer extends SpotLayer {
  private verdicts: Verdict[] = [];
  private notes: string[] = [];
  constructor(map: MLMap) {
    super(map, 'news-route', (p) => [
      {
        id: `${p}-halo`,
        type: 'circle',
        source: p,
        paint: { 'circle-color': ['get', 'c'], 'circle-opacity': 0.25, 'circle-blur': 0.6, 'circle-radius': radius(1.9), 'circle-pitch-alignment': 'map' },
      },
      {
        id: `${p}-dot`,
        type: 'circle',
        source: p,
        paint: {
          'circle-color': ['get', 'c'],
          'circle-radius': radius(1.15),
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': ['case', ['==', ['get', 'u'], 1], 2.6, 1.4],
          'circle-pitch-alignment': 'map',
        },
      },
    ]);
  }
  protected override data() {
    return fc(this.spots, (s) => ({ c: VERDICT_COLOR[this.verdicts[this.spots.indexOf(s)] ?? 'watch'] }));
  }
  protected override html(s: NewsSpot) {
    const n = this.notes[this.spots.indexOf(s)];
    return spotPopupHtml(s, n ? `<div class="pop-model"><span>At your departure time</span><b>${esc(n)}</b></div>` : '');
  }
  /** spots on the route with their verdict and a short note ("Likely flooded · 22 cm"); null clears */
  set(items: { spot: NewsSpot; verdict: Verdict; note?: string }[] | null) {
    this.spots = items?.map((x) => x.spot) ?? [];
    this.verdicts = items?.map((x) => x.verdict) ?? [];
    this.notes = items?.map((x) => x.note ?? '') ?? [];
    this.setVisible(this.spots.length > 0);
    this.refresh();
  }
}
