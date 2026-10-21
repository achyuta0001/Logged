// Bengaluru Urban overview: district outline, every pincode coloured by the precomputed
// flood-susceptibility index (public/data/city/city.geojson, `npm run data:city`), a legend,
// offline pincode search and click-to-open. Calm by default: one fill layer, one outline, no labels
// until hover; the sidebar's "Pincodes" section holds the legend, search and the ranked list, and
// "Reported flood spots" lists the spots named in news reports (src/ui/spotList.ts).
import type { MapLayerMouseEvent } from 'maplibre-gl';
import type { PinEntry } from '../types';
import type { Region, Shell } from '../main';
import { createMap, beforeLabels } from '../map/mapView';
import { Tooltip } from '../ui/tooltip';
import { esc } from '../ui/format';
import { iconSvg } from '../ui/icons';
import { searchPins } from './packs';
import { NewsLayer, NEWS_COLOR } from '../map/newsLayer';
import { reportsByArea } from '../commute/near';
import type { NewsSpot } from '../commute/spots';
import { SpotList } from '../ui/spotList';

export interface CityData {
  district: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
  pins: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, { kind: 'pin'; code: string; name: string; s: number }>;
  generated?: string;
}

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const BASE = (env?.BASE_URL ?? '/').replace(/\/?$/, '/');

/** Sequential ramp on the dark map: low recedes into slate, high glows cyan -> violet (same direction as the depth ramp). */
export const SUSC_RAMP: [number, string][] = [
  [0, '#1c2636'],
  [0.35, '#1d4f8f'],
  [0.6, '#2f8fe0'],
  [0.8, '#64d2ff'],
  [1, '#bf8cff'],
];
/** plain-language band for a 0..1 rank-based index */
export function suscBand(s: number): string {
  return s >= 0.75 ? 'Very high' : s >= 0.5 ? 'High' : s >= 0.25 ? 'Moderate' : 'Lower';
}

export async function loadCity(): Promise<CityData | null> {
  try {
    const r = await fetch(`${BASE}data/city/city.geojson`);
    if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) throw new Error(`HTTP ${r.status}`);
    const fc = (await r.json()) as GeoJSON.FeatureCollection & { generated?: string };
    const district = fc.features.find((f) => f.properties?.kind === 'district') as CityData['district'] | undefined;
    const pins = fc.features.filter((f) => f.properties?.kind === 'pin') as CityData['pins']['features'];
    if (!district || !pins.length) throw new Error('city.geojson has no district or pincodes');
    return { district, pins: { type: 'FeatureCollection', features: pins }, generated: fc.generated };
  } catch (e) {
    console.warn('[city] overview unavailable, opening 560098', e);
    return null;
  }
}

const ACCENT = '#64d2ff';
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export async function openCity(shell: Shell, city: CityData): Promise<Region> {
  const { loader, sidebar, layout, index } = shell;
  let disposed = false;
  const byCode = new Map(index.pins.map((p) => [p.code, p]));
  const built = index.pins.filter((p) => p.pack);
  loader.setTitle('Bengaluru', 'Bengaluru Urban flood explorer');
  loader.show('Drawing the pincodes');
  loader.set(0.2);
  sidebar.setScope('city');
  sidebar.setRegion('Bengaluru', `Bengaluru Urban · ${city.pins.features.length} pincodes`, { title: 'Bengaluru Urban district', tour: false });
  sidebar.setStatus('none', '<b>Pick a pincode</b> to model its flooding', `${built.length} with a 3D flood model · colours rank flood susceptibility`, undefined, ACCENT);
  const spotList = new SpotList(sidebar); // "Reported flood spots": hidden until its spots load
  shell.timelineEl.hidden = true;
  document.title = 'Bengaluru Urban Flood Explorer';

  const bb = bbox(city.district.geometry);
  const center: [number, number] = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
  const map = await createMap(document.getElementById('map')!, city.district.geometry, 1.4, center, { demMaxZoom: 10 });
  loader.set(0.7);

  // feature ids for hover state
  const data: CityData['pins'] = {
    type: 'FeatureCollection',
    features: city.pins.features.map((f, i) => ({ ...f, id: i, properties: { ...f.properties, pack: byCode.get(f.properties.code)?.pack ? 1 : 0 } })),
  };
  map.addSource('pins', {
    type: 'geojson',
    data,
    attribution: 'Pincodes &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL); susceptibility from Copernicus DEM GLO-30 &copy; DLR e.V., &copy; Airbus Defence and Space GmbH, provided under COPERNICUS by the EU and ESA',
  });
  const ramp = SUSC_RAMP.flatMap(([v, c]) => [v, c]);
  // under the basemap labels like every overlay; the news circles go in there later, so they sit above the fill
  const anchor = beforeLabels();
  const before = anchor && map.getLayer(anchor) ? anchor : undefined;
  map.addLayer(
    {
      id: 'pins-fill',
      type: 'fill',
      source: 'pins',
      paint: {
        'fill-color': ['interpolate', ['linear'], ['coalesce', ['get', 's'], 0], ...ramp] as unknown as string,
        'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.85, ['boolean', ['feature-state', 'sel'], false], 0.82, ['interpolate', ['linear'], ['coalesce', ['get', 's'], 0], 0, 0.38, 1, 0.78]],
      },
    },
    before,
  );
  map.addLayer(
    {
      id: 'pins-line',
      type: 'line',
      source: 'pins',
      paint: {
        'line-color': '#d6f6ff',
        'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.95, ['boolean', ['feature-state', 'sel'], false], 0.95, 0.22],
        'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2, ['boolean', ['feature-state', 'sel'], false], 2.2, 0.7],
      },
    },
    before,
  );
  // pincodes with a built pack get a quiet cyan ring so "openable" is visible without clutter
  map.addLayer(
    {
      id: 'pins-pack',
      type: 'line',
      source: 'pins',
      filter: ['==', ['get', 'pack'], 1],
      paint: { 'line-color': '#64d2ff', 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [2, 1.5] },
    },
    before,
  );

  const idOf = new Map(data.features.map((f) => [f.properties.code, f.id as number]));
  const tip = new Tooltip();
  let hover = -1;
  let sel = -1;
  const setHover = (id: number) => {
    if (hover === id) return;
    if (hover >= 0) map.setFeatureState({ source: 'pins', id: hover }, { hover: false });
    hover = id;
    if (id >= 0) map.setFeatureState({ source: 'pins', id }, { hover: true });
  };
  const setSel = (id: number) => {
    if (sel >= 0) map.setFeatureState({ source: 'pins', id: sel }, { sel: false });
    sel = id;
    if (id >= 0) map.setFeatureState({ source: 'pins', id }, { sel: true });
  };
  // flood reports in the news: a secondary number per pincode in the hover card, an optional layer,
  // and every spot in the "Reported flood spots" list
  let newsBy = new Map<string, { spots: number; reports: number }>();
  const news = new NewsLayer(map, 'city-news');
  void news.ready.then((spots) => {
    if (disposed) return;
    newsBy = reportsByArea(city.pins.features.map((f) => ({ key: f.properties.code, geometry: f.geometry })), spots);
    spotList.set(spots, showSpot);
  });
  const tipHtml = (code: string) => {
    const p = byCode.get(code);
    const f = data.features[idOf.get(code)!];
    const s = f?.properties.s ?? p?.susceptibility ?? 0;
    return `<div class="tip-h"><div><b>${esc(code)}</b><span>${esc(p?.name ?? f?.properties.name ?? '')}</span></div></div>
      <dl><dt>Flood susceptibility</dt><dd>${suscBand(s)} · ${Math.round(s * 100)}</dd>
      ${newsBy.has(code) ? `<dt>In the news</dt><dd>${newsBy.get(code)!.reports} flood report${newsBy.get(code)!.reports === 1 ? '' : 's'}</dd>` : ''}
      ${p ? `<dt>Area</dt><dd>${p.areaKm2.toFixed(1)} km²</dd>` : ''}
      <dt>3D flood model</dt><dd class="${p?.pack ? 'wet' : ''}">${p?.pack ? 'Click to open' : 'Not built yet'}</dd></dl>`;
  };
  // a news circle drawn over a pincode takes the pointer: a tap on it opens only its card
  map.on('mousemove', 'pins-fill', (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return;
    if (news.hit(e.point)) {
      setHover(-1);
      tip.hide();
      return;
    }
    setHover(f.id as number);
    map.getCanvas().style.cursor = 'pointer';
    tip.show(e.point.x, e.point.y, tipHtml(String(f.properties?.code)));
  });
  map.on('mouseleave', 'pins-fill', () => {
    setHover(-1);
    map.getCanvas().style.cursor = '';
    tip.hide();
  });
  map.on('movestart', () => tip.hide());
  map.on('click', 'pins-fill', (e: MapLayerMouseEvent) => {
    if (news.hit(e.point)) return; // the news layer opens that circle's card
    const code = String(e.features?.[0]?.properties?.code ?? '');
    if (code) choose(code, false);
  });

  // ---------------------------------------------------------------- sidebar: legend, search, ranked list
  const body = sidebar.body('city');
  const ranked = [...index.pins].filter((p) => idOf.has(p.code)).sort((a, b) => (b.susceptibility ?? 0) - (a.susceptibility ?? 0));
  const grad = SUSC_RAMP.map(([v, c]) => `${c} ${v * 100}%`).join(', ');
  body.innerHTML = `
    <div class="city">
      <label class="city-search">
        ${iconSvg('target', 15)}
        <input type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="city-results" placeholder="Pincode or area, e.g. 560103 or Bellandur" aria-label="Find a pincode by number or area name" autocomplete="off" spellcheck="false" />
      </label>
      <ul class="city-results" id="city-results" role="listbox" aria-label="Matching pincodes" hidden></ul>
      <figure class="city-legend" aria-label="Legend: flood susceptibility, lower to higher">
        <div class="city-ramp" style="background: linear-gradient(90deg, ${grad})"></div>
        <figcaption><span>Lower</span><span>Flood susceptibility</span><span>Higher</span></figcaption>
        <p class="city-key"><i class="city-ring" aria-hidden="true"></i>Dashed outline: 3D flood model ready</p>
        <div class="layers"><label class="lyr" title="Spots named in news reports of flooding. Bigger circle: more flood days reported. White ring: underpass"><i class="sw dot" style="--c:${NEWS_COLOR}"></i><span>Flood reports in the news</span><input type="checkbox" class="switch city-news" role="switch"></label></div>
      </figure>
      <details class="city-how">
        <summary>How the colours are worked out</summary>
        <p>Each pincode is ranked against the others on four terrain measures from the Copernicus 30 m elevation model and OpenStreetMap: how much ground sits less than 2 m above the nearest stream or drain (35 %), how much water its hollows can hold (25 %), how much is paved or built over (20 %), and how much land upstream drains into it (20 %). It ranks places; it is not a forecast or a probability.</p>
        <p>Dark gaps are areas with no pincode boundary in OpenStreetMap yet.</p>
      </details>
      <div class="city-list-head"><h3>Most susceptible</h3><span>${ranked.length} ranked</span></div>
      <ol class="city-list"></ol>
      <button type="button" class="city-more btn-link">Show all</button>
    </div>`;
  // listeners go on .city (replaced with the region), never on the persistent section body:
  // anything bound to `body` would outlive destroy() and keep this map alive
  const root = body.querySelector('.city') as HTMLElement;
  const input = body.querySelector('input') as HTMLInputElement;
  const results = body.querySelector('.city-results') as HTMLUListElement;
  const list = body.querySelector('.city-list') as HTMLOListElement;
  const more = body.querySelector('.city-more') as HTMLButtonElement;
  const cells = (p: PinEntry, rank?: number) =>
    `${rank !== undefined ? `<span class="city-rank">${rank}</span>` : ''}
      <span class="city-sw" style="background:${color(p.susceptibility ?? 0)}" aria-hidden="true"></span>
      <span class="city-name"><b>${p.code}</b><span>${esc(p.name)}</span></span>
      <span class="city-val">${p.susceptibility !== undefined ? `${suscBand(p.susceptibility)}` : ''}</span>
      ${p.pack ? `<span class="city-3d" title="3D flood model ready">3D</span>` : ''}`;
  const row = (p: PinEntry, rank?: number) => `<li><button type="button" class="city-row" data-code="${p.code}">${cells(p, rank)}</button></li>`;
  // search results are a listbox: focus stays in the input, the active option is announced (combobox pattern)
  const option = (p: PinEntry, i: number) => `<li role="option" id="city-opt-${i}" class="city-row" data-code="${p.code}" aria-selected="false">${cells(p)}</li>`;
  let showAll = false;
  const renderList = () => {
    list.innerHTML = (showAll ? ranked : ranked.slice(0, 8)).map((p, i) => row(p, i + 1)).join('');
    more.textContent = showAll ? 'Show fewer' : `Show all ${ranked.length}`;
    more.hidden = ranked.length <= 8;
  };
  renderList();
  more.addEventListener('click', () => {
    showAll = !showAll;
    renderList();
  });
  let active = -1;
  const setActive = (i: number, scroll = false) => {
    const rows = [...results.querySelectorAll<HTMLElement>('.city-row')];
    rows.forEach((r, j) => {
      r.classList.toggle('active', j === i);
      r.setAttribute('aria-selected', String(j === i));
    });
    if (rows[i]) input.setAttribute('aria-activedescendant', rows[i].id);
    else input.removeAttribute('aria-activedescendant');
    if (scroll) rows[i]?.scrollIntoView({ block: 'nearest' });
  };
  const renderResults = () => {
    const q = input.value.trim();
    const hits = q ? searchPins(index, q, 8) : [];
    results.hidden = !q;
    input.setAttribute('aria-expanded', String(!!q));
    active = hits.length ? 0 : -1;
    results.innerHTML = hits.length
      ? hits.map(option).join('')
      : q
        ? '<li class="city-none" role="option" aria-disabled="true" aria-selected="false">No pincode or area by that name in Bengaluru Urban</li>'
        : '';
    setActive(active);
  };
  input.addEventListener('input', renderResults);
  input.addEventListener('keydown', (e) => {
    const rows = [...results.querySelectorAll<HTMLElement>('.city-row')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      setActive(active, true);
    } else if (e.key === 'Enter' && rows[active]) {
      e.preventDefault();
      choose(rows[active].dataset.code!, true);
    } else if (e.key === 'Escape') {
      input.value = '';
      renderResults();
    }
  });
  root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.city-row');
    if (b) choose(b.dataset.code!, true);
  });
  root.addEventListener('mouseover', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.city-row');
    setHover(b ? (idOf.get(b.dataset.code!) ?? -1) : -1);
  });
  root.addEventListener('mouseleave', () => setHover(-1));
  root.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.classList.contains('city-news')) news.setVisible(t.checked);
  });

  /** select a pincode: open it when its pack exists, otherwise frame it and say so */
  function choose(code: string, fly: boolean) {
    const p = byCode.get(code);
    const id = idOf.get(code) ?? -1;
    setSel(id);
    if (p?.pack) {
      shell.go(code);
      return;
    }
    if (p) {
      sidebar.setStatus('none', `<b>${esc(code)}</b> · ${esc(p.name)}`, `${suscBand(p.susceptibility ?? 0)} susceptibility · no 3D flood model built for this pincode yet`, undefined, ACCENT);
      if (fly) {
        sidebar.getOutOfTheWay();
        const cam = map.cameraForBounds([[p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[3]]], { padding: 40 });
        if (cam) map.flyTo({ ...cam, padding: layout.padding(), pitch: 45, duration: reduceMotion() ? 0 : 1600, essential: true });
      }
    }
  }

  /** a spot picked in the list: news layer on (its switch too), the spot's card open, the map flown there */
  function showSpot(s: NewsSpot) {
    const sw = root.querySelector('.city-news') as HTMLInputElement;
    if (!sw.checked) {
      sw.checked = true;
      news.setVisible(true);
    }
    news.open(s, false);
    sidebar.getOutOfTheWay();
    map.flyTo({ center: s.coord, zoom: 15, pitch: 45, padding: layout.padding(), duration: reduceMotion() ? 0 : 1600, essential: true });
  }

  // sources
  sidebar.body('sources').innerHTML = `<ul class="src-list">
      <li><span>Boundaries</span><p>Pincode and district boundaries © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL 1.0)</p></li>
      <li><span>Elevation</span><p>Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA</p></li>
      <li><span>Basemap</span><p><a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>, © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a>, © OpenStreetMap contributors</p></li>
      <li><span>3D terrain</span><p><a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen/Tilezen terrain tiles</a> (SRTM and others)</p></li>
    </ul>`;
  sidebar.setSummary('sources', 'OSM · Copernicus');
  sidebar.setSummary('city', `${built.length} with 3D model`);

  // frame the district
  map.setPadding(layout.padding());
  const cam = map.cameraForBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 24 });
  if (cam) map.jumpTo({ center: cam.center, zoom: cam.zoom, pitch: 32, bearing: 0 });
  loader.hide();

  return {
    kind: 'city',
    reframe() {
      if (disposed) return;
      map.easeTo({ padding: layout.padding(), duration: reduceMotion() ? 0 : 450, essential: true });
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      tip.hide();
      news.destroy();
      map.remove();
      sidebar.clearBodies();
      shell.timelineEl.hidden = false;
    },
  };
}

function color(s: number): string {
  for (let i = 1; i < SUSC_RAMP.length; i++) {
    const [v1, c1] = SUSC_RAMP[i];
    const [v0, c0] = SUSC_RAMP[i - 1];
    if (s <= v1) {
      const t = (s - v0) / (v1 - v0 || 1);
      const a = parseInt(c0.slice(1), 16);
      const b = parseInt(c1.slice(1), 16);
      const ch = (sh: number) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t);
      return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
    }
  }
  return SUSC_RAMP[SUSC_RAMP.length - 1][1];
}

function bbox(g: GeoJSON.Geometry): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c: unknown): void => {
    if (typeof (c as number[])[0] === 'number') {
      const [x, y] = c as number[];
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    } else (c as unknown[]).forEach(walk);
  };
  walk((g as GeoJSON.Polygon).coordinates);
  return [w, s, e, n];
}

