// Sidebar controls: Rain (source picker + summary), Map (basemap, terrain, layers),
// Drainage assumptions (model sliders) and Sources.
import type { RainSeries, SimParams } from '../types';
import { esc, fmtHour, fmtNum } from './format';
import { iconSvg } from './icons';

/**
 * `source` marks a real storm (archive rain); its description cites the report as "(https://...)".
 * `scaled` marks a real storm's twin whose archive timing is scaled to the reported gauge total.
 */
type Scenario = { id: string; label: string; description: string; source?: string; scaled?: boolean };

export interface LayerDef {
  id: string;
  label: string;
  swatch: string;
  on: boolean;
  /** analysis layers are listed separately and start off */
  analysis?: boolean;
  hint?: string;
}

/** Calm by default: water, buildings, road passability and affected places only. */
export const LAYERS: LayerDef[] = [
  { id: 'flood', label: 'Flood water', swatch: 'linear-gradient(90deg,#aaf0ff,#1ec8ff,#2878ff,#785aff)', on: true },
  { id: 'buildings', label: '3D buildings', swatch: 'linear-gradient(90deg,#aab6c6,#ffa024,#ff3b4f)', on: true },
  { id: 'roads', label: 'Road passability', swatch: 'linear-gradient(90deg,#ffc24d,#ff8a2a,#ff4458)', on: true },
  { id: 'facilities', label: 'Places cut off by water', swatch: 'dot:#e8203c', on: true },
  { id: 'allPlaces', label: 'All schools, hospitals, stops', swatch: 'dot:#dfeaf7', on: false, hint: 'Always shown when zoomed in to street level' },
  { id: 'lakes', label: 'Lakes and tanks', swatch: '#1e5aa0', on: true },
  { id: 'hotspots', label: 'Reported floods since 2017', swatch: 'ring:#ff8a96', on: true },
  { id: 'depressions', label: 'Low spots where water pools', swatch: 'linear-gradient(90deg,#ff78e6,#8c3cff)', on: false, analysis: true },
  { id: 'streams', label: 'Natural flow paths', swatch: '#9be8ff', on: false, analysis: true },
  { id: 'hand', label: 'Land under 3 m above a stream', swatch: '#46ffc8', on: false, analysis: true },
  { id: 'drains', label: 'Storm drains and canals', swatch: '#38e0c8', on: false, analysis: true },
  { id: 'news', label: 'Flood reports in the news', swatch: 'dot:#ffb340', on: false, analysis: true, hint: 'Bigger circle: more flood days reported. White ring: underpass' },
];

const SHORT: Record<string, string> = {
  forecast: 'Live forecast',
  'typical-evening': 'Typical evening',
  'rrnagar-2024-10-20': 'Oct 2024 storm',
  cloudburst: 'Cloudburst',
  'multi-day-soak': '3-day soak',
};

/**
 * Picker text. A real storm drops its "Real storm: " prefix (its group says so) and names its rain,
 * so the closed picker still tells raw archive rain from the gauge-scaled twin. The scaled twin
 * also drops the trailing "gauge" to fit the 260 px desktop picker ("20-22 Oct 2024 · scaled to 190 mm").
 */
function optText(x: Scenario) {
  if (SHORT[x.id]) return SHORT[x.id];
  if (!x.source) return x.label;
  const when = x.label.replace(/^Real storm: /, '');
  return x.scaled ? when.replace(/ mm gauge$/, ' mm') : `${when} · archive rain`;
}

/** Made-up scenarios first, then the real storms on archive rain, then the same storms scaled to the gauge totals. */
function optgroups(scenarios: Scenario[], selected?: string) {
  const opt = (x: Scenario) => `<option value="${esc(x.id)}"${x.id === selected ? ' selected' : ''}>${esc(optText(x))}</option>`;
  const group = (label: string, xs: Scenario[]) => (xs.length ? `<optgroup label="${esc(label)}">${xs.map(opt).join('')}</optgroup>` : '');
  const real = scenarios.filter((x) => x.source);
  if (!real.length) return scenarios.map(opt).join('');
  return (
    group('Scenarios', scenarios.filter((x) => !x.source)) +
    group('Real storms, archive rain', real.filter((x) => !x.scaled)) +
    group('Real storms, archive timing scaled to the gauge total', real.filter((x) => x.scaled))
  );
}

/** Escape a description and show each cited "(https://host/...)" as a short link to the report. */
function linkCitations(text: string) {
  return esc(text).replace(/\((https:\/\/([^/\s)]+)[^\s)]*)\)/g, (_m, url: string, host: string) => `(<a href="${url}" target="_blank" rel="noopener">${host.replace(/^www\./, '')}</a>)`);
}

export interface ControlHandlers {
  onSource(id: string): void;
  onVariant(v: 'best' | 'worst'): void;
  onRerun(p: SimParams): void;
  onBasemap(b: 'dark' | 'satellite'): void;
  onExaggeration(x: number): void;
  onLayer(id: string, on: boolean): void;
  /** any value shown in a collapsed section header changed */
  onSummary(): void;
}

export interface ControlMounts {
  rain: HTMLElement;
  map: HTMLElement;
  drainage: HTMLElement;
  sources: HTMLElement;
}

const PARAM_FMT: Record<keyof SimParams, (v: number) => string> = {
  drainCapacityMmHr: (v) => `${v} mm/h`,
  drainBlockage: (v) => `${Math.round(v * 100)}%`,
  infiltrationMmHr: (v) => `${v} mm/h`,
};

export class Controls {
  private m: ControlMounts;
  private h: ControlHandlers;
  private params: SimParams;
  private scenarios: Scenario[];
  private fcNote = 'Open-Meteo, 2 days back and 7 ahead';
  private layerOn = new Map<string, boolean>();
  private basemap: 'dark' | 'satellite' = 'dark';
  private mode: 'forecast' | 'scenario' = 'forecast';

  constructor(m: ControlMounts, scenarios: Scenario[], params: SimParams, exaggeration: number, h: ControlHandlers) {
    this.m = m;
    this.h = h;
    this.params = { ...params };
    this.scenarios = scenarios;
    for (const l of LAYERS) this.layerOn.set(l.id, l.on);

    const scen = scenarios.find((x) => x.id === 'rrnagar-2024-10-20') ?? scenarios[0];
    m.rain.innerHTML = `
      <div class="rain-pick">
        <div class="segmented" role="group" aria-label="Rain to predict from">
          <button type="button" data-mode="forecast" aria-pressed="true">Live forecast</button>
          <button type="button" data-mode="scenario" aria-pressed="false">Scenario</button>
        </div>
        <div class="segmented small variant" role="group" aria-label="Forecast variant">
          <button type="button" data-v="best" aria-pressed="true" title="Open-Meteo best match for Bengaluru">Best estimate</button>
          <button type="button" data-v="worst" aria-pressed="false" title="Hourly maximum of four weather models">Worst of 4 models</button>
        </div>
        <label class="popup-btn scen-pick hidden">
          <select id="scen" aria-label="Scenario">${optgroups(scenarios, scen?.id)}</select>${iconSvg('updown', 14, 2)}
        </label>
      </div>
      <p class="src-desc" id="src-desc"></p>
      <div class="rain-row">
        ${['now', 'tot', 'max', 'prob'].map((k) => `<div class="stat"><span class="stat-v" data-k="${k}">–</span><span class="stat-l" data-l="${k}"></span></div>`).join('')}
      </div>
      <p class="note" id="rain-note"></p>`;

    const lyr = (l: LayerDef) => {
      const sw = l.swatch.startsWith('dot:')
        ? `<i class="sw dot" style="--c:${l.swatch.slice(4)}"></i>`
        : l.swatch.startsWith('ring:')
          ? `<i class="sw ring" style="--c:${l.swatch.slice(5)}"></i>`
          : `<i class="sw" style="background:${l.swatch}"></i>`;
      return `<label class="lyr"${l.hint ? ` title="${esc(l.hint)}"` : ''}>${sw}<span>${esc(l.label)}</span><input type="checkbox" class="switch" role="switch" data-layer="${l.id}" ${l.on ? 'checked' : ''}></label>`;
    };
    m.map.innerHTML = `
      <div class="segmented" role="group" aria-label="Basemap">
        <button type="button" data-bm="dark" aria-pressed="true">Dark map</button>
        <button type="button" data-bm="satellite" aria-pressed="false">Satellite</button>
      </div>
      <label class="slider" style="margin-top:14px">
        <span class="sl-top"><span>Terrain height</span><output id="ex-out">${exaggeration.toFixed(1)}×</output></span>
        <input type="range" id="ex" min="1" max="5" step="0.1" value="${exaggeration}">
      </label>
      <h3 class="mini-h">On the map</h3>
      <div class="layers">${LAYERS.filter((l) => !l.analysis).map(lyr).join('')}</div>
      <h3 class="mini-h">Terrain analysis</h3>
      <div class="layers">${LAYERS.filter((l) => l.analysis).map(lyr).join('')}</div>`;

    m.drainage.innerHTML = `
      <p class="sec-lede">What the model assumes about the drains here. Change them and re-run.</p>
      ${this.slider('drainCapacityMmHr', 'Drain capacity', 0, 80, 1)}
      ${this.slider('drainBlockage', 'Drains blocked by silt and garbage', 0, 1, 0.05)}
      ${this.slider('infiltrationMmHr', 'Soaks into open ground', 0, 40, 1)}
      <button type="button" class="btn primary" id="rerun" disabled>${iconSvg('refresh', 15)}<span>Re-run prediction</span></button>`;

    this.wire();
    this.syncSource();
  }

  private slider(key: keyof SimParams, label: string, min: number, max: number, step: number) {
    const v = this.params[key];
    return `<label class="slider"><span class="sl-top"><span>${label}</span><output data-out="${key}">${PARAM_FMT[key](v)}</output></span>
      <input type="range" data-p="${key}" min="${min}" max="${max}" step="${step}" value="${v}"></label>`;
  }

  private wire() {
    const { rain, map, drainage } = this.m;
    const rerun = drainage.querySelector('#rerun') as HTMLButtonElement;
    drainage.querySelectorAll<HTMLInputElement>('input[data-p]').forEach((inp) =>
      inp.addEventListener('input', () => {
        const k = inp.dataset.p as keyof SimParams;
        this.params[k] = Number(inp.value);
        (drainage.querySelector(`output[data-out="${k}"]`) as HTMLOutputElement).textContent = PARAM_FMT[k](this.params[k]);
        rerun.disabled = false;
        this.h.onSummary();
      }),
    );
    rerun.addEventListener('click', () => {
      rerun.disabled = true;
      this.h.onRerun({ ...this.params });
    });
    rain.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-pressed') === 'true') return;
        this.mode = b.dataset.mode as 'forecast' | 'scenario';
        if (this.mode === 'forecast') this.setVariantUI('best');
        this.syncSource();
        this.h.onSource(this.source);
      }),
    );
    const sel = rain.querySelector('#scen') as HTMLSelectElement;
    sel.addEventListener('change', () => {
      this.syncSource();
      this.h.onSource(sel.value);
    });
    rain.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-pressed') === 'true') return;
        this.setVariantUI(b.dataset.v as 'best' | 'worst');
        this.h.onVariant(b.dataset.v as 'best' | 'worst');
      }),
    );
    // iOS-style filled track on every slider
    const fill = (inp: HTMLInputElement) => inp.style.setProperty('--p', `${((Number(inp.value) - Number(inp.min)) / (Number(inp.max) - Number(inp.min) || 1)) * 100}%`);
    [map, drainage].forEach((root) =>
      root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((inp) => {
        fill(inp);
        inp.addEventListener('input', () => fill(inp));
      }),
    );
    map.querySelectorAll<HTMLButtonElement>('[data-bm]').forEach((b) =>
      b.addEventListener('click', () => {
        this.setBasemapUI(b.dataset.bm as 'dark' | 'satellite');
        this.h.onBasemap(this.basemap);
      }),
    );
    const ex = map.querySelector('#ex') as HTMLInputElement;
    ex.addEventListener('input', () => {
      (map.querySelector('#ex-out') as HTMLOutputElement).textContent = `${Number(ex.value).toFixed(1)}×`;
      this.h.onExaggeration(Number(ex.value));
    });
    map.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((c) =>
      c.addEventListener('change', () => {
        this.layerOn.set(c.dataset.layer!, c.checked);
        this.h.onLayer(c.dataset.layer!, c.checked);
        this.h.onSummary();
      }),
    );
  }

  // ---------- state for the collapsed section headers ----------
  get source(): string {
    return this.mode === 'forecast' ? 'forecast' : (this.m.rain.querySelector('#scen') as HTMLSelectElement).value;
  }
  get sourceLabel(): string {
    return SHORT[this.source] ?? this.scenarios.find((s) => s.id === this.source)?.label ?? this.source;
  }
  get mapSummary(): string {
    const n = [...this.layerOn.values()].filter(Boolean).length;
    return `${this.basemap === 'dark' ? 'Dark' : 'Satellite'} · ${n} layers`;
  }
  get drainageSummary(): string {
    return `${this.params.drainCapacityMmHr} mm/h · ${Math.round(this.params.drainBlockage * 100)}% blocked`;
  }

  selectSource(id: string) {
    this.mode = id === 'forecast' ? 'forecast' : 'scenario';
    if (id !== 'forecast') (this.m.rain.querySelector('#scen') as HTMLSelectElement).value = id;
    this.syncSource();
  }

  /** Only the selected source shows its description; the best/worst toggle only applies to the forecast. */
  private syncSource() {
    const id = this.source;
    const fc = id === 'forecast';
    this.m.rain.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === this.mode)));
    this.m.rain.querySelector('.variant')!.classList.toggle('hidden', !fc);
    this.m.rain.querySelector('.scen-pick')!.classList.toggle('hidden', fc);
    const desc = fc ? this.fcNote : (this.scenarios.find((s) => s.id === id)?.description ?? '');
    (this.m.rain.querySelector('#src-desc') as HTMLElement).innerHTML = linkCitations(desc);
    this.h.onSummary();
  }

  private setVariantUI(v: 'best' | 'worst') {
    this.m.rain.querySelectorAll<HTMLElement>('[data-v]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === v)));
  }

  setBasemapUI(b: 'dark' | 'satellite') {
    this.basemap = b;
    this.m.map.querySelectorAll<HTMLElement>('[data-bm]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.bm === b)));
    this.h.onSummary();
  }

  /** Flip a layer's switch as a tap would (e.g. news reports on when a spot is picked from the list). */
  setLayer(id: string, on: boolean) {
    const c = this.m.map.querySelector<HTMLInputElement>(`input[data-layer="${id}"]`);
    if (!c || c.checked === on) return;
    c.checked = on;
    c.dispatchEvent(new Event('change'));
  }

  setForecastNote(text: string) {
    this.fcNote = text;
    this.syncSource();
  }

  setBusy(b: boolean) {
    this.m.rain.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('[data-mode], [data-v], #scen').forEach((x) => (x.disabled = b));
    if (b) (this.m.drainage.querySelector('#rerun') as HTMLButtonElement).disabled = true;
  }

  setSources(html: string) {
    this.m.sources.innerHTML = html;
  }

  /** Rain summary. For a forecast: from "now"; for a scenario: the whole event. */
  setRain(s: RainSeries, note?: string) {
    const q = (k: string) => this.m.rain.querySelector(`[data-k="${k}"]`) as HTMLElement;
    const l = (k: string) => this.m.rain.querySelector(`[data-l="${k}"]`) as HTMLElement;
    const unit = (v: number, u: string) => `${fmtNum(v, v < 10 ? 1 : 0)}<small>${u}</small>`;
    if (s.source === 'forecast' && s.nowIndex !== undefined) {
      const i0 = s.nowIndex;
      const next = s.mm.slice(i0, i0 + 24);
      const tot = next.reduce((a, b) => a + b, 0);
      const mx = Math.max(0, ...next);
      const mxI = next.indexOf(mx);
      const prob = s.probability ? Math.max(0, ...s.probability.slice(i0, i0 + 24)) : NaN;
      q('now').innerHTML = unit(s.mm[i0] ?? 0, 'mm');
      l('now').textContent = 'this hour';
      q('tot').innerHTML = unit(tot, 'mm');
      l('tot').textContent = 'next 24 h';
      q('max').innerHTML = unit(mx, 'mm');
      l('max').textContent = mx > 0 ? `peak hour, ${fmtHour(s.times[i0 + mxI])}` : 'peak hour';
      q('prob').innerHTML = Number.isFinite(prob) ? `${prob}<small>%</small>` : '–';
      l('prob').textContent = 'chance of rain';
    } else {
      const tot = s.mm.reduce((a, b) => a + b, 0);
      const mx = Math.max(0, ...s.mm);
      const wet = s.mm.filter((v) => v > 0.2).length;
      q('now').innerHTML = unit(tot, 'mm');
      l('now').textContent = 'total rain';
      q('tot').innerHTML = `${wet}<small>h</small>`;
      l('tot').textContent = 'of rain';
      q('max').innerHTML = unit(mx, 'mm');
      l('max').textContent = 'peak hour';
      q('prob').innerHTML = `${s.mm.length}<small>h</small>`;
      l('prob').textContent = 'predicted';
    }
    (this.m.rain.querySelector('#rain-note') as HTMLElement).innerHTML = note ?? '';
  }
}
