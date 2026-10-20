// The pincode view: its own chunk, which src/boot.ts loads with import() the first time a pincode opens.
import type { Map as MLMap, PaddingOptions } from 'maplibre-gl';
import type { ImpactReport, RainSeries, Severity, SimParams, Terrain } from './types';
import { loadDataset, type Dataset } from './ui/api';
import { cellToLngLat, lngLatToCell } from './terrain';
import {
  ARCHIVE_ATTRIBUTION,
  ARCHIVE_ATTRIBUTION_URL,
  fakeForecastVariants,
  fetchForecastVariants,
  fetchHistoricalEvent,
  HISTORICAL_EVENTS,
  SCENARIOS,
  WEATHER_ATTRIBUTION,
  WEATHER_ATTRIBUTION_URL,
  type ForecastVariants,
} from './weather';
import { FloodEngine, DEFAULT_PARAMS } from './sim/index';
import { computeImpact } from './impact';
import { aggregateEnsemble, ensembleStatusText, type EnsembleSummary } from './ensemble';
import type { EnsembleRunner } from './ensembleRun';
import { createMap, setBasemap, setExaggeration } from './map/mapView';
import { WaterFx } from './map/waterFx';
import { RainFx } from './map/rainFx';
import { mountStoryPanel } from './ui/story';
import { mountPlace } from './ui/place';
import { createTour } from './ui/tour';
import { AnalysisLayers } from './map/analysisLayers';
import { FeatureLayers, FACILITY_LABEL } from './map/features';
import { Loader } from './ui/loader';
import { Sidebar } from './ui/sidebar';
import { Controls, LAYERS } from './ui/controls';
import { ImpactView } from './ui/impactView';
import { Layout } from './ui/layout';
import { Legend } from './ui/legend';
import { Timeline } from './ui/timeline';
import { Tooltip } from './ui/tooltip';
import { esc, fmtArea, fmtDepth, fmtHour, fmtWeekday, relHours } from './ui/format';
import { iconSvg } from './ui/icons';
import type { PinEntry, PinIndex } from './types';
import { LEGACY_PIN, inflowCaveat } from './region/packs';
import { offlineForecastTime } from './sw-register';

const DEMO_SCENARIO = 'rrnagar-2024-10-20';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** below this flooded area (m², cells deeper than 10 cm) the outlook reads "no flooding" */
const DRY_AREA_M2 = 1000;

interface App {
  ds: Dataset;
  map: MLMap;
  engine: FloodEngine;
  flood: WaterFx;
  feats: FeatureLayers;
  analysis: AnalysisLayers;
  sidebar: Sidebar;
  controls: Controls;
  impactView: ImpactView;
  layout: Layout;
  timeline: Timeline;
  series: RainSeries | null;
  forecast: ForecastVariants | null;
  variant: 'best' | 'worst';
  params: SimParams;
  hour: number;
  /** the hour the header status talks about (peak ahead / scenario peak) */
  peak: number;
  playing: boolean;
  speed: number;
  impact: Map<number, ImpactReport>;
  area: number[];
  /** the live forecast could not be fetched, so the Oct 2024 storm stands in (the status says so) */
  forecastDown: boolean;
}

/** The persistent chrome every region renders into. */
export interface Shell {
  loader: Loader;
  sidebar: Sidebar;
  timeline: Timeline;
  timelineEl: HTMLElement;
  layout: Layout;
  index: PinIndex;
  /** the city overview data loaded (otherwise the app is pincode-only) */
  hasCity: boolean;
  /** switch region: a pincode, the city overview (null), or the Commute tab ('commute') */
  go(pin: string | null): void;
  /** ?scenario=, &basemap=, &view= for the region being opened: the page's own for the first region, none after */
  url: URLSearchParams;
}

/** What is on screen: the city overview, one pincode, or the Commute tab. Everything it creates goes in destroy(). */
export interface Region {
  kind: 'city' | 'pin' | 'commute';
  destroy(): void;
  reframe(): void;
  onTour?(): void;
  onStatus?(): void;
  setHour?(h: number): void;
  setPlaying?(p: boolean): void;
  setSpeed?(s: number): void;
  togglePlay?(): void;
  /** true while the region owns the keyboard (guided tour) */
  busy?(): boolean;
}

export async function openPin(shell: Shell, pin: PinEntry, base: string): Promise<Region> {
  const { loader, sidebar, timeline, layout, url } = shell;
  const timelineEl = shell.timelineEl;
  const ac = new AbortController();
  let disposed = false;
  let impactTimer = 0;
  let raf = 0;
  let exTimer = 0;
  let sumRaf = 0;
  /** true once the map is framed and the tour exists; layout callbacks wait for it */
  let ready = false;
  const legacy = pin.code === LEGACY_PIN;
  const placeName = pin.name.replace(/^Pincode \d+$/, '').trim();
  loader.setTitle(pin.code, `${placeName || 'Bengaluru'} flood outlook`);
  loader.show('Loading terrain, buildings and roads');
  loader.set(0.04);
  sidebar.setScope('pin');
  sidebar.setRegion(pin.code, legacy ? 'Rajarajeshwari Nagar, Bengaluru' : `${placeName ? `${placeName}, ` : ''}Bengaluru`, { back: shell.hasCity });
  sidebar.setTitle('story', legacy ? 'Why RR Nagar floods' : 'Model vs reported');
  sidebar.setStatus('none', 'Working out the flood outlook', '');
  // M4: catchments cross pincode edges; say quietly how much land drains in from outside the grid and how much is simulated
  const caveat = inflowCaveat(pin);
  sidebar.setCaveat(caveat?.text ?? null, caveat?.tip);
  timelineEl.hidden = false;
  document.title = `${pin.code} Flood Outlook`;
  const ds = await loadDataset(base);
  const { terrain, osm } = ds;
  const meta = terrain.meta;
  const c2l = (c: number) => cellToLngLat(meta, c);
  const center: [number, number] = [(meta.bbox[0] + meta.bbox[2]) / 2, (meta.bbox[1] + meta.bbox[3]) / 2];

  loader.set(0.25, 'Building the 3D map');
  const exaggeration = 2.4;
  const map = await createMap(document.getElementById('map')!, meta.boundary, exaggeration, legacy ? undefined : center);
  map.addControl(new Legend(), 'bottom-right');

  loader.set(0.35, 'Tracing low spots and flow paths');
  await tick();
  const analysis = new AnalysisLayers(map, terrain, osm, ds.hotspots, cellToLngLat);
  const flood = new WaterFx(map, meta, terrain.grids.boundaryMask as Uint8Array);
  flood.setFlowDir(terrain.grids.flowDir as Uint8Array);
  const rain = new RainFx(document.getElementById('map')!);
  const feats = new FeatureLayers(map, osm, c2l);

  const impactView = new ImpactView(sidebar.body('impact'), ds.depressions, {
    onDepression: (d) => flyTo(d.centroid, 16.2),
    onRoad: (name) => {
      const f = osm.features.find((x) => x.properties.kind === 'road' && x.properties.name === name);
      if (f) flyTo(c2l(f.properties.cell), 16.4);
    },
  });
  // The rain and drainage controls are live while the first load still runs, before `app` exists.
  // A choice made then is held here (the last of each kind wins) and applied once the first run
  // is on the map; touching `app` earlier threw "Cannot access 'app' before initialization".
  let early: { source?: string; variant?: 'best' | 'worst'; params?: SimParams } | null = {};
  const controls = new Controls(
    { rain: sidebar.body('rain'), map: sidebar.body('map'), drainage: sidebar.body('drainage'), sources: sidebar.body('sources') },
    [...SCENARIOS, ...HISTORICAL_EVENTS],
    DEFAULT_PARAMS,
    exaggeration,
    {
      onSource: (id) => {
        if (early) early.source = id;
        else void selectSource(id);
      },
      onVariant: (v) => {
        if (early) {
          early.variant = v;
          early.source = 'forecast';
          return;
        }
        app.variant = v;
        void selectSource('forecast');
      },
      onRerun: (p) => {
        if (early) {
          early.params = p;
          return;
        }
        app.params = p;
        if (app.series) void runSim(app.series);
      },
      onBasemap: (b) => setBasemap(map, b),
      onExaggeration: (x) => {
        setExaggeration(map, x);
        clearTimeout(exTimer);
        exTimer = window.setTimeout(() => void reground(map), 150);
      },
      onLayer: (id, on) => setLayer(id, on),
      onSummary: () => scheduleSummaries(),
    },
  );
  for (const l of LAYERS) setLayer(l.id, l.on);
  controls.setSources(sourcesHtml(meta.sources));

  loader.set(0.42, 'Fetching the rain forecast');
  let forecast: ForecastVariants | null = null;
  try {
    // ?fakeforecast=1 (npm run dev only): a made-up wet forecast, to check the model range on a dry day
    forecast = import.meta.env.DEV && url.get('fakeforecast') ? fakeForecastVariants() : await fetchForecastVariants(center[1], center[0]);
  } catch (e) {
    console.warn('[weather] forecast failed', e);
  }

  loader.set(0.48, 'Starting the flood model');
  const engine = await FloodEngine.create(terrain, DEFAULT_PARAMS);
  /** the forecast's range across weather models: predicted after the main run (compareModels) */
  let ensRunner: EnsembleRunner | null = null;
  let ens: EnsembleSummary | null = null;
  let compareGen = 0;

  const app: App = {
    ds,
    map,
    engine,
    flood,
    feats,
    analysis,
    sidebar,
    controls,
    impactView,
    layout,
    timeline,
    series: null,
    forecast,
    variant: 'best',
    params: { ...DEFAULT_PARAMS },
    hour: 0,
    peak: 0,
    playing: false,
    speed: 4,
    impact: new Map(),
    area: [],
    forecastDown: false,
  };

  if (import.meta.env.DEV) (window as any).__app = app;
  analysis.modelLookup = (coord) => modelNear(app, terrain, coord);
  const hoverTip = wireHover(app, terrain);

  const modelAt = (lng: number, lat: number) => modelNear(app, terrain, [lng, lat]);
  // the tour flies with the chrome hidden; it ends where it started, re-framed for the panels
  let preTour: { center: [number, number]; zoom: number; pitch: number; bearing: number } | null = null;
  const tour = createTour(map, {
    hotspots: ds.hotspots,
    depressions: ds.depressions,
    getModelDepthAt: modelAt,
    region: { code: pin.code, name: pin.name, center },
    onEnd: () => {
      const cam = preTour;
      preTour = null;
      map.once('moveend', () => void reground(map));
      if (!cam) return void map.easeTo({ padding: layout.padding(), duration: reduceMotion ? 0 : 600 });
      map.flyTo({ ...cam, padding: layout.padding(), duration: reduceMotion ? 0 : 2400, curve: 1.2, essential: true });
    },
  });
  function startTour() {
    if (!tour.isRunning) preTour = { center: map.getCenter().toArray() as [number, number], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    layout.setFocus(false);
    sidebar.getOutOfTheWay();
    tour.start();
  }
  const story = mountStoryPanel(sidebar.body('story'), {
    why: legacy,
    hotspots: ds.hotspots,
    depressions: ds.depressions,
    getModelDepthAt: modelAt,
    onFocus: (coord) => flyTo(coord, 16.2),
  });
  const place = mountPlace(document.getElementById('place-mount')!, {
    map,
    terrain,
    osm,
    engine,
    getHour: () => app.hour,
    getTimes: () => app.series?.times ?? [],
    getRain: () => app.series?.mm ?? [],
    depressions: ds.depressions,
    hotspots: ds.hotspots,
    onFocus: (coord) => flyTo(coord, 16.4),
    onChange: (p) => p && sidebar.setOpen('place', true, false),
  });
  let placeTimer = 0;

  // The live forecast whenever it loads, even a dry one (the status then says no flooding is
  // expected). The Oct 2024 storm stands in only when the forecast cannot be fetched, and the
  // status says so. ?scenario= overrides both.
  const demo = SCENARIOS.find((s) => s.id === DEMO_SCENARIO) ?? SCENARIOS[0];
  if (forecast) controls.setForecastNote(forecastSummary(forecast));
  const asked = SCENARIOS.find((s) => s.id === url.get('scenario'));
  // ?scenario=<real storm id> (raw archive rain or its -gauge twin) at the pin centroid; if the archive cannot be reached, open as usual
  const askedReal = asked ? undefined : HISTORICAL_EVENTS.find((e) => e.id === url.get('scenario'));
  const realSeries = askedReal ? await fetchHistoricalEvent((pin.centroid ?? center)[1], (pin.centroid ?? center)[0], askedReal).catch(() => null) : null;
  if (asked) {
    controls.selectSource(asked.id);
    await runSim(asked.build(), loader, true, 0.5, 0.5);
  } else if (askedReal && realSeries) {
    controls.selectSource(askedReal.id);
    await runSim(realSeries, loader, true, 0.5, 0.5);
  } else if (forecast) {
    controls.selectSource('forecast');
    await runSim(forecast.best, loader, true, 0.5, 0.5);
  } else {
    app.forecastDown = true;
    controls.selectSource(demo.id);
    await runSim(demo.build(), loader, true, 0.5, 0.5);
  }
  await frame(map, meta.bbox, layout.padding());
  if (url.get('basemap') === 'satellite') {
    setBasemap(map, 'satellite');
    controls.setBasemapUI('satellite');
  }
  const view = url.get('view')?.split(',').map(Number);
  if (view && view.length >= 3 && view.every(Number.isFinite)) {
    map.jumpTo({ center: [view[0], view[1]], zoom: view[2], pitch: view[3] ?? 60, bearing: view[4] ?? map.getBearing() });
    await reground(map);
  }
  loader.hide();
  ready = true;
  if (!view) intro(map);
  // no sourced reports and no hand-written story: nothing to show in that section
  sidebar.setHidden('story', !legacy && !ds.hotspots.length);
  // apply what was picked while loading (the first run may have reset the controls since)
  const picked = early;
  early = null;
  if (picked.params) app.params = picked.params;
  if (picked.variant) app.variant = picked.variant;
  if (picked.source) {
    controls.selectSource(picked.source);
    void selectSource(picked.source);
  } else if (picked.params && app.series) void runSim(app.series);

  const region: Region = {
    kind: 'pin',
    reframe,
    onTour: () => ready && (tour.isRunning ? tour.stop() : startTour()),
    onStatus: () => {
      if (!ready) return;
      setPlaying(false);
      setHour(app.peak);
      sidebar.getOutOfTheWay();
    },
    setHour: (h) => setHour(h),
    setPlaying: (p) => setPlaying(p),
    setSpeed: (s) => (app.speed = s),
    togglePlay: () => setPlaying(!app.playing),
    busy: () => ready && tour.isRunning,
    destroy() {
      if (disposed) return;
      disposed = true;
      ac.abort();
      setPlaying(false);
      cancelAnimationFrame(raf);
      cancelAnimationFrame(sumRaf);
      clearTimeout(impactTimer);
      clearTimeout(exTimer);
      clearTimeout(placeTimer);
      if (tour.isRunning) tour.stop();
      place.destroy();
      story.destroy();
      flood.destroy();
      rain.destroy();
      feats.destroy();
      engine.dispose();
      ensRunner?.dispose();
      sidebar.setRange('');
      hoverTip.hide();
      map.remove();
      sidebar.clearBodies();
      sidebar.setHidden('story', false);
      sidebar.setCaveat(null);
      app.impact.clear();
    },
  };
  return region;

  // ---------------------------------------------------------------------------
  /** Re-pad the camera so the subject stays centred in the free map area. */
  function reframe() {
    if (!ready || tour.isRunning) return;
    const p = layout.padding();
    const cur = map.getPadding();
    if (samePad(p, cur)) return;
    map.once('moveend', () => void reground(map));
    map.easeTo({ padding: p, duration: reduceMotion ? 0 : 450, easing: (t) => 1 - Math.pow(1 - t, 3), essential: true });
  }

  function setLayer(id: string, on: boolean) {
    if (id === 'flood') flood.setVisible(on);
    else if (id === 'buildings' || id === 'roads' || id === 'facilities') feats.setVisible(id, on);
    else if (id === 'allPlaces') feats.setAllPlaces(on);
    else analysis.setVisible(id, on);
  }

  async function selectSource(id: string) {
    setPlaying(false);
    let series: RainSeries | undefined;
    if (id === 'forecast') {
      if (!app.forecast) {
        try {
          app.forecast = await fetchForecastVariants(center[1], center[0]);
          controls.setForecastNote(forecastSummary(app.forecast));
        } catch {
          // the map keeps what it shows (still the stand-in storm if the forecast never loaded)
          controls.setRain(app.series ?? demo.build(), 'The forecast could not be loaded. Check your connection, or pick a scenario.');
          return;
        }
      }
      series = app.variant === 'worst' ? app.forecast.worst : app.forecast.best;
    } else if (HISTORICAL_EVENTS.some((e) => e.id === id)) {
      // real storm: archive rain at the pin centroid, raw or scaled to the gauge (the series ends in a 24 h dry recession)
      const ev = HISTORICAL_EVENTS.find((e) => e.id === id)!;
      const [lon, lat] = pin.centroid ?? center;
      controls.setBusy(true);
      try {
        series = await fetchHistoricalEvent(lat, lon, ev);
      } catch {
        controls.setBusy(false);
        controls.setRain(app.series ?? demo.build(), 'The rainfall archive could not be loaded. Check your connection, or pick another scenario.');
        return;
      }
    } else series = SCENARIOS.find((s) => s.id === id)?.build();
    if (!series || disposed) return;
    app.forecastDown = false;
    await runSim(series);
  }

  async function runSim(series: RainSeries, ld: Loader = loader, first = false, base = 0, span = 1) {
    app.series = series;
    stopCompare();
    setPlaying(false);
    controls.setBusy(true);
    if (!first) ld.show('Predicting where water flows');
    engine.setParams(app.params);
    const t0 = performance.now();
    try {
      await engine.run(series, (h, n) => ld.set(base + (span * h) / Math.max(1, n), `Predicting hour ${h} of ${n}`));
    } catch (e) {
      console.error(e);
      ld.error('The flood model stopped with an error. Reload the page to try again.');
      controls.setBusy(false);
      return;
    }
    console.info(`[sim] ${series.mm.length} h in ${Math.round(performance.now() - t0)} ms`);
    app.impact.clear();
    const n = Math.min(engine.hours || series.mm.length, series.mm.length);
    const area = Array.from({ length: n }, (_, h) => engine.snapshot(h)?.floodedAreaM2 ?? 0);
    app.area = area;
    timeline.setSeries(series, area);
    controls.setRain(series, rainNote(series, app.forecast, app.forecastDown));
    controls.setBusy(false);
    analysis.refreshCompare();
    story.refresh();
    place.refresh();
    // open at the worst hour still ahead (or the worst overall for a scenario)
    const from = series.source === 'forecast' ? (series.nowIndex ?? 0) : 0;
    let best = from;
    for (let h = from; h < n; h++) if (area[h] > area[best]) best = h;
    updateStatus();
    setHour(area[best] > 0 ? best : from);
    if (!first) ld.hide();
    if (series.source === 'forecast') void compareModels(series);
  }

  /** Drop the comparison across weather models (a new prediction is starting) and what it showed. */
  function stopCompare() {
    compareGen++;
    ensRunner?.cancel();
    ens = null;
    impactView.setEnsemble(null);
    sidebar.setRange('');
  }

  /**
   * Once the main prediction is on screen: predict the same hours on each forecast model's own rain
   * (a second worker, one model at a time) and show the range. A newer run or region drops it.
   */
  async function compareModels(series: RainSeries) {
    const fc = app.forecast;
    if (!fc || fc.members.length < 2) return;
    const gen = compareGen;
    impactView.setEnsemble(null, fc.members.length);
    if (!ensRunner) {
      const { EnsembleRunner } = await import('./ensembleRun');
      if (disposed) return;
      ensRunner ??= new EnsembleRunner(terrain, osm);
    }
    if (gen !== compareGen) return;
    const res = await ensRunner.run({ members: fc.members, params: { ...app.params }, hours: 48, dryAreaM2: DRY_AREA_M2, reuse: { mm: series.mm, area: app.area, impactAt } });
    if (disposed || gen !== compareGen) return;
    if (!res) return void impactView.setEnsemble(null); // the comparison failed: no range, as for a scenario
    const r = (app.area[app.peak] ?? 0) >= DRY_AREA_M2 ? impactAt(app.peak) : undefined;
    ens = aggregateEnsemble(res, r?.overall ?? 'none');
    impactView.setEnsemble(ens);
    timeline.setBand(ens && !ens.dry ? ens.band : null);
    updateStatus();
  }

  function impactAt(h: number): ImpactReport | undefined {
    const cached = app.impact.get(h);
    if (cached) return cached;
    const snap = engine.snapshot(h);
    if (!snap) return undefined;
    try {
      const r = computeImpact(terrain, osm, snap);
      app.impact.set(h, r);
      return r;
    } catch (e) {
      console.error('[impact]', e);
      return undefined;
    }
  }

  /** The header's one-line answer: leads with the conclusion for the next 48 h (or the scenario). */
  function updateStatus() {
    const s = app.series;
    if (!s) return;
    const n = app.area.length;
    if (!n) return;
    const fc = s.source === 'forecast';
    sidebar.setRange(fc ? ensembleStatusText(ens) : '');
    const from = fc ? Math.min(n - 1, s.nowIndex ?? 0) : 0;
    const to = fc ? Math.min(n, from + 48) : n;
    let peak = from;
    for (let h = from; h < to; h++) if (app.area[h] > app.area[peak]) peak = h;
    app.peak = peak;
    // the forecast could not be fetched, so the Oct 2024 storm stands in: say so instead of "Scenario: ..."
    const standIn = !fc && app.forecastDown ? 'Live forecast unavailable · showing the Oct 2024 storm' : '';
    // no network: the forecast is the copy the service worker kept, so say how old it is
    const off = fc ? offlineNote(app.forecast) : '';
    const r = (app.area[peak] ?? 0) >= DRY_AREA_M2 ? impactAt(peak) : undefined;
    const sev: Severity = r?.overall ?? 'none';
    if (!r || sev === 'none') {
      const rainMm = fc ? rainAhead(s, 48) : s.mm.reduce((a, b) => a + b, 0);
      sidebar.setStatus(
        'none',
        fc ? '<b>No flooding expected</b> in the next 48\u00a0h' : '<b>No flooding</b> in this scenario',
        fc ? `${fmtMm(rainMm)} of rain forecast${app.variant === 'worst' ? ' (worst case)' : ''}${off ? ` · ${off}` : ''}` : standIn || `Scenario: ${controls.sourceLabel}, ${fmtMm(rainMm)}`,
      );
      return;
    }
    const t = s.times[peak];
    const area = (r.floodedAreaKm2 >= 0.01 ? `${r.floodedAreaKm2.toFixed(2)} km²` : fmtArea(r.floodedAreaKm2 * 1e6)).replace(' ', '\u00a0');
    const ctx = fc ? `${off || 'Live forecast'}${app.variant === 'worst' ? ', worst case' : ''} · peak ${relHours(peak, s.nowIndex)}` : standIn || `Scenario: ${controls.sourceLabel}`;
    sidebar.setStatus(sev, `<b>${SEV_PHRASE[sev]}</b> at ${fmtHour(t)}\u00a0${fmtWeekday(t)} — ${area} under water`, ctx, 'Show that hour');
  }

  function scheduleSummaries() {
    if (sumRaf) return;
    sumRaf = requestAnimationFrame(() => {
      sumRaf = 0;
      sidebar.setSummary('impact', impactView.summary);
      sidebar.setSummary('rain', controls.sourceLabel);
      sidebar.setSummary('map', controls.mapSummary);
      sidebar.setSummary('drainage', controls.drainageSummary);
      sidebar.setSummary('story', document.querySelector('#sec-story .st-score')?.textContent ?? '');
      sidebar.setSummary('sources', 'OSM · Copernicus · Open-Meteo');
    });
  }

  function setHour(h: number) {
    app.hour = h;
    const snap = engine.snapshot(h);
    const depth = snap?.depth ?? null;
    flood.setDepth(depth);
    flood.setTime(h);
    rain.setIntensity(app.series?.mm[h] ?? 0);
    feats.update(depth);
    timeline.setHour(h);
    clearTimeout(placeTimer);
    if (app.playing) placeTimer = window.setTimeout(() => app.hour === h && place.setHour(h), 160);
    else place.setHour(h);
    const maxA = Math.max(1, ...app.area);
    document.documentElement.style.setProperty('--level', (0.1 + 0.55 * ((app.area[h] ?? 0) / maxA)).toFixed(3));
    const time = app.series?.times[h] ?? Date.now();
    const cached = app.impact.get(h);
    if (cached || !snap) {
      impactView.update(time, cached, depth);
      scheduleSummaries();
      return;
    }
    clearTimeout(impactTimer);
    impactTimer = window.setTimeout(
      () => {
        if (app.hour !== h) return;
        impactView.update(time, impactAt(h), depth);
        scheduleSummaries();
      },
      app.playing ? 140 : 0,
    );
  }

  function setPlaying(p: boolean) {
    app.playing = p;
    timeline.setPlaying(p);
    layout.setPlaying(p);
    cancelAnimationFrame(raf);
    if (!p || !app.series) return;
    const n = Math.min(engine.hours, app.series.mm.length);
    if (app.hour >= n - 1) setHour(0);
    let acc = 0;
    let last = performance.now();
    const step = (t: number) => {
      acc += ((t - last) / 1000) * app.speed;
      last = t;
      if (acc >= 1) {
        const adv = Math.floor(acc);
        acc -= adv;
        const next = app.hour + adv;
        if (next >= n - 1) {
          setHour(n - 1);
          setPlaying(false);
          return;
        }
        setHour(next);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function flyTo(c: [number, number], zoom: number) {
    // narrow screens: get the sidebar out of the way so the destination is visible
    sidebar.getOutOfTheWay();
    map.flyTo({ center: c, zoom, pitch: 64, bearing: map.getBearing(), padding: layout.padding(), speed: 0.9, curve: 1.4, essential: true, ...(reduceMotion ? { duration: 0 } : {}) });
    map.once('moveend', () => void reground(map));
  }
}

const SEV_PHRASE: Record<Severity, string> = {
  none: 'No flooding',
  low: 'Minor flooding',
  moderate: 'Moderate flooding',
  high: 'Heavy flooding',
  severe: 'Severe flooding',
};

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

const fmtMm = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}\u00a0mm`;

function samePad(a: PaddingOptions, b: PaddingOptions) {
  const k = ['left', 'right', 'top', 'bottom'] as const;
  return k.every((x) => Math.abs((a[x] ?? 0) - (b[x] ?? 0)) < 1);
}

function rainNote(s: RainSeries, fc: ForecastVariants | null, forecastDown = false): string {
  if (s.source !== 'forecast') {
    if (forecastDown) return 'The live forecast could not be loaded, so the map shows the October 2024 storm. Pick Live forecast to try again.';
    return fc ? `Live forecast: ${forecastSummary(fc).replace(/^Next 48 h: /, '')} over the next 48 h.` : '';
  }
  const i0 = s.nowIndex ?? 0;
  const next72 = s.mm.slice(i0, i0 + 72).reduce((a, b) => a + b, 0);
  const past48 = s.mm.slice(Math.max(0, i0 - 48), i0).reduce((a, b) => a + b, 0);
  if (next72 < 5) return `Little rain in the next 3 days (${next72.toFixed(1)} mm), so not much water collects. Pick a scenario to see a heavy storm.`;
  return `${next72.toFixed(0)} mm forecast over the next 3 days${past48 > 1 ? `, after ${past48.toFixed(0)} mm in the last 2 days` : ''}.`;
}

function rainAhead(s: RainSeries, hours: number) {
  const i0 = s.nowIndex ?? 0;
  return s.mm.slice(i0, i0 + hours).reduce((a, b) => a + b, 0);
}

function forecastSummary(f: ForecastVariants) {
  const b = rainAhead(f.best, 48);
  const w = rainAhead(f.worst, 48);
  return `Next 48 h: ${b.toFixed(0)} mm best estimate, ${w.toFixed(0)} mm worst case`;
}

/** "Offline · forecast from 18:05" when the forecast on screen is a saved copy, not live; '' otherwise */
function offlineNote(f: ForecastVariants | null): string {
  const t = offlineForecastTime(f?.fetchedAt);
  if (t === null) return '';
  const day = fmtWeekday(t) === fmtWeekday(Date.now()) ? '' : `${fmtWeekday(t)} `;
  return `Offline · forecast from ${day}${fmtHour(t)}`;
}

function sourcesHtml(sources: string[]) {
  const row = (what: string, html: string) => `<li><span>${what}</span><p>${html}</p></li>`;
  return `<p class="sec-lede warn">${iconSvg('alert', 13)}<span>A prototype model for planning and awareness, not an official flood warning. Follow BBMP and KSNDMC advisories.</span></p>
    <ul class="src-list">
      ${sources.map((x) => row(/openstreetmap/i.test(x) ? 'Map data' : /dem|copernicus/i.test(x) ? 'Elevation' : 'Data', esc(x))).join('')}
      ${row('Weather', `<a href="${WEATHER_ATTRIBUTION_URL}" target="_blank" rel="noopener">${esc(WEATHER_ATTRIBUTION)}</a>`)}
      ${row('Past rain', `<a href="${ARCHIVE_ATTRIBUTION_URL}" target="_blank" rel="noopener">${esc(ARCHIVE_ATTRIBUTION)}</a>; the real storms' dates and gauge totals link to news reports`)}
      ${row('Basemap', '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>, © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a>, © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>')}
      ${row('Satellite', '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless by EOX</a> (CC BY 4.0, modified Copernicus Sentinel data 2020)')}
      ${row('3D terrain', '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen/Tilezen terrain tiles</a> (SRTM and others)')}
      ${row('Flood reports', 'Deccan Herald, The News Minute, Citizen Matters and others; each report links to its source')}
    </ul>`;
}

/** street water only: radius for "Model vs reported" (reports name neighbourhoods, not exact streets) */
const NEAR_M = 300;

/**
 * Deepest modelled STREET water within 300 m of a coordinate, from the running max of the
 * last run. Cells inside storm drains, canals and lakes are skipped: water there is not
 * street flooding.
 */
function modelNear(app: App, t: Terrain, coord: [number, number]): number | undefined {
  const n = app.engine.hours;
  if (!n) return undefined;
  const snap = app.engine.snapshot(n - 1);
  if (!snap) return undefined;
  const c = lngLatToCell(t.meta, coord[0], coord[1]);
  if (c < 0) return undefined;
  const drain = t.grids.drainMask;
  const lake = t.grids.lakeMask;
  const w = t.meta.width;
  const r = Math.max(1, Math.round(NEAR_M / t.meta.cellSizeM));
  const x0 = c % w;
  const y0 = Math.floor(c / w);
  let mx = 0;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = x0 + dx;
      const y = y0 + dy;
      if (x < 0 || y < 0 || x >= w || y >= t.meta.height) continue;
      const i = y * w + x;
      if (drain[i] || lake[i]) continue;
      const v = snap.maxDepth[i];
      if (v > mx) mx = v;
    }
  return mx;
}

function wireHover(app: App, t: Terrain) {
  const tip = new Tooltip();
  const map = app.map;
  const g = t.grids;
  // cell -> depression label
  const depOf = new Int32Array(t.meta.width * t.meta.height).fill(-1);
  app.ds.depressions.forEach((d, i) => d.cells.forEach((c) => (depOf[c] = i)));
  let pending: { x: number; y: number; lng: number; lat: number } | null = null;
  let rafId = 0;
  const FAC_LAYERS = ['facilities', 'facilities-all'];
  const render = () => {
    rafId = 0;
    if (!pending) return;
    const { x, y, lng, lat } = pending;
    const c = lngLatToCell(t.meta, lng, lat);
    if (c < 0) return tip.hide();
    const feats = map.queryRenderedFeatures(
      [
        [x - 8, y - 8],
        [x + 8, y + 8],
      ],
      { layers: [...FAC_LAYERS, 'roads'].filter((l) => map.getLayer(l)) },
    );
    const fac = feats.find((f) => FAC_LAYERS.includes(f.layer.id));
    const road = feats.find((f) => f.layer.id === 'roads' && f.properties?.name);
    const di = depOf[c];
    const title = fac ? `${esc(String(fac.properties?.name || FACILITY_LABEL[fac.properties?.kind] || 'Facility'))}` : road ? esc(String(road.properties!.name)) : di >= 0 ? esc(app.ds.depressions[di].label ?? 'Low spot') : 'Here';
    const sub = fac ? (FACILITY_LABEL[fac.properties?.kind] ?? '') : road ? 'Road' : di >= 0 ? 'Low spot' : '';
    const water = app.engine.snapshot(app.hour)?.depth[c] ?? 0;
    const rows: [string, string, string?][] = [
      ['Water now', fmtDepth(water), water >= 0.15 ? 'wet' : ''],
      ['Ground level', `${(g.elevation[c] as number).toFixed(1)} m`],
      ['Pools up to', (g.depressionDepth[c] as number) >= 0.05 ? `${(g.depressionDepth[c] as number).toFixed(2)} m` : 'drains away'],
      ['Height above stream', `${(g.hand[c] as number).toFixed(1)} m`],
    ];
    if (g.drainMask[c]) rows.push(['Drain', 'storm drain here']);
    if (g.lakeMask[c]) rows.push(['Water body', 'lake or tank']);
    tip.show(
      x,
      y,
      `<div class="tip-h">${fac ? `<span class="tip-ico">${iconSvg(String(fac.properties?.kind), 14)}</span>` : ''}<div><b>${title}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div></div>
      <dl>${rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls ?? ''}">${v}</dd>`).join('')}</dl>`,
    );
  };
  map.on('mousemove', (e) => {
    pending = { x: e.point.x, y: e.point.y, lng: e.lngLat.lng, lat: e.lngLat.lat };
    if (!rafId) rafId = requestAnimationFrame(render);
  });
  map.on('mouseout', () => {
    pending = null;
    tip.hide();
  });
  map.on('movestart', () => tip.hide());
  map.on('click', (e) => {
    pending = { x: e.point.x, y: e.point.y, lng: e.lngLat.lng, lat: e.lngLat.lat };
    render();
  });
  return tip;
}

async function frame(map: MLMap, bbox: [number, number, number, number], padding: PaddingOptions) {
  map.setPadding(padding);
  const cam = map.cameraForBounds(
    [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ],
    { padding: 10 },
  );
  if (!cam) return;
  map.jumpTo({ center: cam.center, zoom: (cam.zoom ?? 13.5) + 0.25, pitch: 58, bearing: -18 });
  await reground(map);
}

/** Put the camera's centre on the (exaggerated) terrain surface so framing is not offset. */
export async function reground(map: MLMap) {
  for (let i = 0; i < 40; i++) {
    const e = map.queryTerrainElevation(map.getCenter());
    if (e != null && e > 1) {
      map.jumpTo({ elevation: e });
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function intro(map: MLMap) {
  if (reduceMotion) return;
  const end = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), elevation: map.getCenterElevation() };
  map.jumpTo({ zoom: end.zoom - 0.9, pitch: 35, bearing: end.bearing - 30 });
  // A long ease can drop the centre elevation to 0 with terrain on; carry it and re-anchor after.
  map.once('moveend', () => void reground(map));
  map.easeTo({ ...end, duration: 4200, easing: (t) => 1 - Math.pow(1 - t, 3), essential: true });
}
