// Standalone harness for the "Your place" panel (place-demo.html). Not part of the app bundle.
// URL params: ?pin=lng,lat  &mode=walk|two_wheeler|car  &dest=metro|hospital|main_road|none
//             &hour=N  &q=<search text>  &scenario=<id>  &view=lng,lat,zoom[,pitch,bearing]
import '../style.css';
import { loadDataset } from '../ui/api';
import { createMap } from '../map/mapView';
import { WaterFx } from '../map/waterFx';
import { FloodEngine } from '../sim/index';
import { SCENARIOS } from '../weather';
import { mountPlace } from '../ui/place';

const q = new URLSearchParams(location.search);
const status = document.getElementById('status')!;
const slider = document.getElementById('hour') as HTMLInputElement;
const out = document.getElementById('hourv')!;
const playBtn = document.getElementById('play') as HTMLButtonElement;

if (q.has('fresh')) {
  try {
    localStorage.removeItem('rrnagar-flood:place:v1');
  } catch {
    /* ignore */
  }
}

const ds = await loadDataset();
const { terrain, osm } = ds;
const meta = terrain.meta;
status.textContent = 'Building the 3D map…';
const map = await createMap(document.getElementById('map')!, meta.boundary, 2.0);
const water = new WaterFx(map, meta, terrain.grids.boundaryMask as Uint8Array);
water.setFlowDir(terrain.grids.flowDir as Uint8Array);

status.textContent = 'Simulating the storm…';
const engine = await FloodEngine.create(terrain);
const sc = SCENARIOS.find((s) => s.id === (q.get('scenario') ?? 'rrnagar-2024-10-20')) ?? SCENARIOS[0];
const series = sc.build();
await engine.run(series, (h, n) => (status.textContent = `Simulating hour ${h} of ${n}…`));
const n = Math.min(engine.hours, series.mm.length);
let peak = 0;
for (let h = 0; h < n; h++) if ((engine.snapshot(h)?.floodedAreaM2 ?? 0) > (engine.snapshot(peak)?.floodedAreaM2 ?? 0)) peak = h;
let hour = q.has('hour') ? Math.max(0, Math.min(n - 1, Number(q.get('hour')) || 0)) : peak;
status.textContent = '';

const fmt = (t: number) =>
  new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

const place = mountPlace(document.getElementById('place-mount')!, {
  map,
  terrain,
  osm,
  engine,
  getHour: () => hour,
  getTimes: () => series.times,
  depressions: ds.depressions,
  hotspots: ds.hotspots,
  onFocus: (c) => map.flyTo({ center: c, zoom: 16.2, pitch: 58, essential: true }),
});

function setHour(h: number) {
  hour = h;
  const snap = engine.snapshot(h);
  water.setDepth(snap?.depth ?? null);
  water.setTime(h);
  slider.value = String(h);
  out.textContent = `${fmt(series.times[h])} · ${series.mm[h] ?? 0} mm rain`;
  place.setHour(h);
}
slider.max = String(n - 1);
slider.addEventListener('input', () => setHour(Number(slider.value)));
setHour(hour);
place.refresh();

let playing = false;
let raf = 0;
playBtn.addEventListener('click', () => {
  playing = !playing;
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  playBtn.innerHTML = playing
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5L7 4.5Z"/></svg>';
  cancelAnimationFrame(raf);
  if (!playing) return;
  let acc = 0;
  let last = performance.now();
  const step = (t: number) => {
    acc += ((t - last) / 1000) * 4;
    last = t;
    if (acc >= 1) {
      acc -= Math.floor(acc);
      setHour((hour + 1) % n);
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
});

// ---- URL-driven setup for screenshots
const view = q.get('view')?.split(',').map(Number);
if (view && view.length >= 3 && view.every(Number.isFinite)) map.jumpTo({ center: [view[0], view[1]], zoom: view[2], pitch: view[3] ?? 58, bearing: view[4] ?? -18 });
const click = (sel: string) => document.querySelector<HTMLButtonElement>(sel)?.click();
const mode = q.get('mode');
if (mode) click(`.pl-seg [data-mode="${mode}"]`);
const pin = q.get('pin')?.split(',').map(Number);
if (pin && pin.length === 2 && pin.every(Number.isFinite)) {
  place.pin([pin[0], pin[1]]);
  if (!view) map.jumpTo({ center: [pin[0], pin[1]], zoom: 15.4, pitch: 55, bearing: -18 });
}
const dest = q.get('dest');
if (dest) {
  const active = document.querySelector('.pl-cap[aria-pressed="true"]') as HTMLButtonElement | null;
  if (dest === 'none') active?.click();
  else if (active?.dataset.dest !== dest) click(`.pl-cap[data-dest="${dest}"]`);
}
const text = q.get('q');
if (text) {
  const input = document.querySelector<HTMLInputElement>('.pl-field input')!;
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

Object.assign(window as unknown as Record<string, unknown>, { __place: place, __map: map, __engine: engine, __setHour: setHour });
