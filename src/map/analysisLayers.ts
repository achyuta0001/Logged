// Static terrain-analysis layers: depression heatmap, HAND low-lying zones,
// D8 flow-accumulation streams, drains, lakes, historical hotspots.
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap } from 'maplibre-gl';
import type { Hotspot, Terrain } from '../types';
import type { NewsSpot } from '../commute/spots';
import type { OsmFC } from '../ui/api';
import { depressionRGBA } from './colors';
import { gridCorners } from './floodLayer';
import { beforeLabels } from './mapView';
import { safeHref } from '../ui/format';
import { NewsLayer } from './newsLayer';

type CellToLngLat = (meta: Terrain['meta'], cell: number) => [number, number];

function gridImage(t: Terrain, color: (i: number) => [number, number, number, number] | null, scale = 4): string {
  const { width, height } = t.meta;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const rgba = color(i);
    if (!rgba) continue;
    img.data[i * 4] = rgba[0];
    img.data[i * 4 + 1] = rgba[1];
    img.data[i * 4 + 2] = rgba[2];
    img.data[i * 4 + 3] = rgba[3] * 255;
  }
  ctx.putImageData(img, 0, 0);
  const big = document.createElement('canvas');
  big.width = width * scale;
  big.height = height * scale;
  const b = big.getContext('2d')!;
  b.imageSmoothingEnabled = true;
  b.imageSmoothingQuality = 'high';
  b.drawImage(c, 0, 0, big.width, big.height);
  return big.toDataURL('image/png');
}

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

function streamLines(t: Terrain, cellToLngLat: CellToLngLat): GeoJSON.FeatureCollection {
  const { meta, grids } = t;
  const acc = grids.flowAccum as Float32Array;
  const dir = grids.flowDir as Uint8Array;
  const n = acc.length;
  // threshold: top ~3% of cells, but at least 60 upstream cells
  const sample: number[] = [];
  for (let i = 0; i < n; i += 7) sample.push(acc[i]);
  sample.sort((a, b) => a - b);
  const thr = Math.max(60, sample[Math.floor(sample.length * 0.97)] ?? 60);
  const feats: GeoJSON.Feature[] = [];
  for (let i = 0; i < n; i++) {
    if (acc[i] < thr) continue;
    const d = dir[i];
    if (d > 7) continue;
    const x = (i % meta.width) + DX[d];
    const y = Math.floor(i / meta.width) + DY[d];
    if (x < 0 || y < 0 || x >= meta.width || y >= meta.height) continue;
    const j = y * meta.width + x;
    feats.push({
      type: 'Feature',
      properties: { a: Math.log10(acc[i]) },
      geometry: { type: 'LineString', coordinates: [cellToLngLat(meta, i), cellToLngLat(meta, j)] },
    });
  }
  return { type: 'FeatureCollection', features: feats };
}

export class AnalysisLayers {
  private map: MLMap;
  private hotspotMarkers: { m: maplibregl.Marker; h: Hotspot; badge: HTMLElement }[] = [];
  /** returns modelled peak depth (m) near a coordinate, or undefined before a run */
  modelLookup: ((coord: [number, number]) => number | undefined) | null = null;
  private compare = false;
  private news: NewsLayer | null = null;
  readonly groups: Record<string, string[]> = {
    depressions: ['depressions'],
    hand: ['hand'],
    streams: ['streams-glow', 'streams'],
    drains: ['drains'],
    lakes: ['lakes-fill', 'lakes-line'],
  };

  constructor(map: MLMap, t: Terrain, osm: OsmFC, hotspots: Hotspot[], cellToLngLat: CellToLngLat) {
    this.map = map;
    const before = beforeLabels();
    const dep = t.grids.depressionDepth as Float32Array;
    const hand = t.grids.hand as Float32Array;
    const lake = t.grids.lakeMask;
    const coords = gridCorners(t.meta);

    map.addSource('depressions', { type: 'image', url: gridImage(t, (i) => (dep[i] >= 0.05 ? depressionRGBA(dep[i]) : null)), coordinates: coords });
    map.addLayer({ id: 'depressions', type: 'raster', source: 'depressions', paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } }, before);

    map.addSource('hand', {
      type: 'image',
      url: gridImage(t, (i) => {
        const h = hand[i];
        if (!(h < 3) || lake[i]) return null;
        const a = 0.42 * (1 - h / 3);
        return [70, 255, 200, a];
      }),
      coordinates: coords,
    });
    map.addLayer({ id: 'hand', type: 'raster', source: 'hand', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 0 } }, before);

    const water = osm.features.filter((f) => f.properties.kind === 'water');
    map.addSource('lakes', { type: 'geojson', data: { type: 'FeatureCollection', features: water } });
    map.addLayer({ id: 'lakes-fill', type: 'fill', source: 'lakes', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#0f3a6e', 'fill-opacity': 0.75 } }, before);
    map.addLayer({ id: 'lakes-line', type: 'line', source: 'lakes', paint: { 'line-color': '#4fb8ff', 'line-width': 1, 'line-opacity': 0.7 } }, before);

    map.addSource('streams', { type: 'geojson', data: streamLines(t, cellToLngLat) });
    map.addLayer(
      {
        id: 'streams-glow',
        type: 'line',
        source: 'streams',
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
        paint: { 'line-color': '#2fb4ff', 'line-blur': 4, 'line-opacity': 0.45, 'line-width': ['interpolate', ['linear'], ['get', 'a'], 1.5, 3, 4, 10] },
      },
      before,
    );
    map.addLayer(
      {
        id: 'streams',
        type: 'line',
        source: 'streams',
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
        paint: { 'line-color': '#9be8ff', 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['get', 'a'], 1.5, 0.6, 4, 2.6] },
      },
      before,
    );

    const drains = osm.features.filter((f) => f.properties.kind === 'drain');
    map.addSource('drains', { type: 'geojson', data: { type: 'FeatureCollection', features: drains } });
    map.addLayer(
      { id: 'drains', type: 'line', source: 'drains', layout: { 'line-cap': 'round', visibility: 'none' }, paint: { 'line-color': '#38e0c8', 'line-width': 1.6, 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 } },
      before,
    );

    for (const h of hotspots) this.addHotspot(h);
  }

  private addHotspot(h: Hotspot) {
    const el = document.createElement('div');
    // subtle by default: a small ring (still a generous click target), details on click
    el.className = 'hotspot';
    el.innerHTML = '<span class="hotspot-core"></span><span class="hotspot-badge"></span>';
    const badge = el.querySelector('.hotspot-badge') as HTMLElement;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.title = `Reported flooding: ${h.name}`;
    el.setAttribute('aria-label', `Reported flooding: ${h.name}`);
    const events = [...h.events].sort((a, b) => b.date.localeCompare(a.date));
    const html = () => {
      const md = this.modelLookup?.(h.coord);
      const model =
        md === undefined
          ? ''
          : `<div class="pop-model ${md >= 0.15 ? 'agree' : 'miss'}"><span>Deepest street water within 300 m</span><b>${md < 0.02 ? 'dry' : md < 1 ? Math.round(md * 100) + ' cm' : md.toFixed(2) + ' m'}</b><em>${md >= 0.15 ? 'Model also floods here' : 'Model stays below 15 cm here'}</em></div>`;
      return `<div class="pop">
      <div class="pop-title">${esc(h.name)}</div>
      <div class="pop-sub">${events.length} reported flood${events.length === 1 ? '' : 's'}</div>${model}
      <ul class="pop-events">${events
        .map(
          (e) => {
            const href = safeHref(e.source);
            return `<li><time>${esc(fmtDate(e.date))}</time><p>${esc(e.summary)}</p>${href ? `<a href="${href}" target="_blank" rel="noopener">${esc(host(e.source!))}</a>` : ''}</li>`;
          },
        )
        .join('')}</ul></div>`;
    };
    const popup = new maplibregl.Popup({ offset: 14, maxWidth: '320px', className: 'glass-popup' }).setHTML(html());
    popup.on('open', () => popup.setHTML(html()));
    const m = new maplibregl.Marker({ element: el }).setLngLat(h.coord).setPopup(popup).addTo(this.map);
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      m.togglePopup();
    });
    this.hotspotMarkers.push({ m, h, badge });
  }

  /** Model vs reported: label each reported location with the modelled peak depth. */
  setCompare(on: boolean) {
    this.compare = on;
    this.refreshCompare();
  }

  refreshCompare() {
    for (const { m, h, badge } of this.hotspotMarkers) {
      const el = m.getElement();
      const md = this.compare ? this.modelLookup?.(h.coord) : undefined;
      if (md === undefined) {
        el.classList.remove('cmp-agree', 'cmp-miss');
        badge.textContent = '';
        continue;
      }
      el.classList.toggle('cmp-agree', md >= 0.15);
      el.classList.toggle('cmp-miss', md < 0.15);
      badge.textContent = md < 0.02 ? 'dry' : md < 1 ? `${Math.round(md * 100)} cm` : `${md.toFixed(1)} m`;
    }
  }

  setVisible(group: string, v: boolean) {
    if (group === 'news') {
      // flood reports in the news: loaded on first use (public/data/news-spots.json)
      if (v || this.news) (this.news ??= new NewsLayer(this.map)).setVisible(v);
      return;
    }
    if (group === 'hotspots') {
      for (const { m } of this.hotspotMarkers) m.getElement().style.display = v ? '' : 'none';
      return;
    }
    for (const id of this.groups[group] ?? []) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
  }

  /** A news spot's card, picked in the sidebar's "Reported flood spots" list (keyboard focus stays there). */
  openNews(s: NewsSpot) {
    (this.news ??= new NewsLayer(this.map)).open(s, false);
  }
}

function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function host(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return 'source';
  }
}
function fmtDate(d: string) {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : d;
}
