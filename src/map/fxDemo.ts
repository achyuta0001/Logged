// Standalone test bench for WaterFx + RainFx (fx-demo.html). Not part of the app bundle.
import { createMap } from './mapView';
import type { GridLayerName } from '../types';
import { loadTerrain } from '../terrain';
import { WaterFx } from './waterFx';
import { RainFx } from './rainFx';

async function loadData() {
  // the 560098 reference pack (format 2: loadTerrain decodes the quantised grids)
  const { meta, grids } = await loadTerrain('/data/pins/560098');
  const layer = <T extends Float32Array | Uint8Array>(name: GridLayerName): T => grids[name] as T;
  return {
    meta,
    dep: layer<Float32Array>('depressionDepth'),
    hand: layer<Float32Array>('hand'),
    lake: layer<Uint8Array>('lakeMask'),
    flowDir: layer<Uint8Array>('flowDir'),
    mask: layer<Uint8Array>('boundaryMask'),
  };
}

/** Storm stage 0..1: rises over 16 h, recedes slowly. */
function stage(h: number) {
  if (h < 16) return Math.pow(h / 16, 1.3);
  return Math.max(0.25, 1 - (h - 16) / 26);
}

function synthDepth(d: Awaited<ReturnType<typeof loadData>>, h: number, out: Float32Array) {
  const s = stage(h);
  for (let i = 0; i < out.length; i++) {
    // depressions fill from the bottom up
    let v = Math.max(0, d.dep[i] - 1.6 * (1 - s));
    // channel overflow: low HAND cells along drainage lines
    const ch = s * 1.1 - d.hand[i];
    if (ch > 0) v = Math.max(v, ch * 0.55);
    if (d.lake[i]) v = Math.max(v, 0.9 + 0.5 * s);
    out[i] = v > 0.015 ? Math.min(v, 2.5) : 0;
  }
}

async function main() {
  const data = await loadData();
  const { meta } = data;
  const [w, s, e, n] = meta.bbox;
  // Same basemap/terrain stack as the app (OpenFreeMap dark vector + AWS terrarium DEM).
  // Note: CARTO raster tiles now return an "API KEY REQUIRED" placeholder, so not used here.
  const map = await createMap(document.getElementById('map')!, meta.boundary, 1.6);
  const params0 = new URLSearchParams(location.search);
  map.jumpTo({
    center: [(w + e) / 2 + Number(params0.get('dx') ?? -0.002), (s + n) / 2 + Number(params0.get('dy') ?? -0.012)],
    zoom: Number(params0.get('z') ?? 13.7),
    pitch: Number(params0.get('pitch') ?? 60),
    bearing: -18,
  });
  (window as unknown as { fxMap: unknown }).fxMap = map;

  const water = new WaterFx(map, meta, data.mask, { beforeId: params0.get('before') ?? 'highway_name_other' });
  water.setFlowDir(data.flowDir);
  (window as unknown as { fxWater: unknown }).fxWater = water;
  const rain = new RainFx(document.getElementById('map')!);

  const depth = new Float32Array(meta.width * meta.height);
  const hourEl = document.getElementById('hour') as HTMLInputElement;
  const hourV = document.getElementById('hourv')!;
  const rainEl = document.getElementById('rain') as HTMLInputElement;
  const rainV = document.getElementById('rainv')!;
  const playBtn = document.getElementById('play') as HTMLButtonElement;
  const statsEl = document.getElementById('stats')!;
  const params = new URLSearchParams(location.search);
  if (params.has('hour')) hourEl.value = params.get('hour')!;
  if (params.has('rain')) rainEl.value = params.get('rain')!;
  let playing = !params.has('still');
  playBtn.textContent = playing ? 'Pause' : 'Play';

  let lastHourStep = -1;
  const applyHour = (h: number) => {
    hourV.textContent = h.toFixed(1);
    const step = Math.round(h * 2) / 2; // recompute depth every half sim-hour
    if (step !== lastHourStep) {
      lastHourStep = step;
      synthDepth(data, step, depth);
      water.setDepth(depth);
    }
    water.setTime(h);
  };
  const applyRain = () => {
    rainV.textContent = rainEl.value;
    rain.setIntensity(Number(rainEl.value));
  };
  hourEl.oninput = () => applyHour(Number(hourEl.value));
  rainEl.oninput = applyRain;
  playBtn.onclick = () => {
    playing = !playing;
    playBtn.textContent = playing ? 'Pause' : 'Play';
  };
  applyHour(Number(hourEl.value));
  applyRain();

  let prev = performance.now();
  const tick = (t: number) => {
    requestAnimationFrame(tick);
    const dt = (t - prev) / 1000;
    prev = t;
    if (playing) {
      let h = Number(hourEl.value) + dt * 0.8; // 0.8 sim-hours per second
      if (h > 36) h = 0;
      hourEl.value = String(h);
      applyHour(h);
    }
  };
  requestAnimationFrame(tick);

  setInterval(() => {
    const st = water.stats;
    statsEl.textContent =
      `canvas   ${st.width}×${st.height}\n` +
      `wet px   ${st.wetPixels.toLocaleString()}\n` +
      `frame    ${st.frameMs.toFixed(2)} ms\n` +
      `prepare  ${st.prepMs.toFixed(1)} ms`;
    (window as unknown as { fxStats: unknown }).fxStats = st;
  }, 500);
}

main();
