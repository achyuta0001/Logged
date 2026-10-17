import type { RainSeries, SimParams } from '../types';
type Scenario = { id: string; label: string; description: string };
import { esc, fmtHour, fmtNum } from './format';
import { iconSvg } from './icons';

export interface LayerDef {
  id: string;
  label: string;
  swatch: string;
  on: boolean;
  hint?: string;
}

export const LAYERS: LayerDef[] = [
  { id: 'flood', label: 'Flood water', swatch: 'linear-gradient(90deg,#aaf0ff,#1ec8ff,#2878ff,#785aff)', on: true },
  { id: 'buildings', label: '3D buildings', swatch: 'linear-gradient(90deg,#aab6c6,#ffa024,#ff3b4f)', on: true },
  { id: 'roads', label: 'Road passability', swatch: 'linear-gradient(90deg,#ffc24d,#ff8a2a,#ff4458)', on: true },
  { id: 'facilities', label: 'Schools, hospitals, transit', swatch: '#dfeaf7', on: true },
  { id: 'depressions', label: 'Low spots where water pools', swatch: 'linear-gradient(90deg,#ff78e6,#8c3cff)', on: false },
  { id: 'streams', label: 'Natural flow paths', swatch: '#9be8ff', on: false },
  { id: 'hand', label: 'Land under 3 m above a stream', swatch: '#46ffc8', on: false },
  { id: 'drains', label: 'Storm drains and canals', swatch: '#38e0c8', on: false },
  { id: 'lakes', label: 'Lakes and tanks', swatch: '#1e5aa0', on: true },
  { id: 'hotspots', label: 'Reported floods since 2017', swatch: '#ff5a6e', on: true },
];


export interface LeftHandlers {
  onSource(id: string): void;
  onVariant(v: 'best' | 'worst'): void;
  onRerun(p: SimParams): void;
  onBasemap(b: 'dark' | 'satellite'): void;
  onExaggeration(x: number): void;
  onLayer(id: string, on: boolean): void;
}

export class LeftPanel {
  private el: HTMLElement;
  private h: LeftHandlers;
  private params: SimParams;

  constructor(el: HTMLElement, scenarios: Scenario[], params: SimParams, exaggeration: number, h: LeftHandlers) {
    this.el = el;
    this.h = h;
    this.params = { ...params };
    el.innerHTML = `
      <div class="brand">
        <div class="brand-top">
          <div class="brand-pin">560098</div>
          <button class="tour-btn" id="tour-btn" type="button">${iconSvg('play', 12)}<span>Tour</span></button>
        </div>
        <div class="brand-name">Rajarajeshwari Nagar, Bengaluru</div>
        <p class="brand-lede">Where rain will pool, hour by hour, from the terrain, the drains and the forecast.</p>
      </div>

      <section class="sec" id="rain">
        <h2>Rain</h2>
        <div class="rain-grid">
          <div class="stat"><span class="stat-v" data-k="now">–</span><span class="stat-l" data-l="now">This hour</span></div>
          <div class="stat"><span class="stat-v" data-k="tot">–</span><span class="stat-l" data-l="tot">Next 24 h</span></div>
          <div class="stat"><span class="stat-v" data-k="max">–</span><span class="stat-l" data-l="max">Wettest hour</span></div>
          <div class="stat"><span class="stat-v" data-k="prob">–</span><span class="stat-l" data-l="prob">Chance of rain</span></div>
        </div>
        <p class="note" id="rain-note"></p>
      </section>

      <section class="sec">
        <h2>Rain to simulate</h2>
        <div class="sources" role="radiogroup" aria-label="Rain to simulate">
          <div class="src-wrap">
            <label class="src"><input type="radio" name="src" value="forecast" checked><span><b>Live forecast</b><em id="fc-note">Open-Meteo, 2 days back and 7 ahead</em></span></label>
            <div class="seg small variant" role="group" aria-label="Forecast variant">
              <button data-v="best" class="on" title="Open-Meteo best match for Bengaluru">Best estimate</button>
              <button data-v="worst" title="Hourly maximum of four weather models">Worst case of 4 models</button>
            </div>
          </div>
          ${scenarios.map((s) => `<label class="src"><input type="radio" name="src" value="${esc(s.id)}"><span><b>${esc(s.label)}</b><em>${esc(s.description)}</em></span></label>`).join('')}
        </div>
      </section>

      <section class="sec">
        <h2>Drainage assumptions</h2>
        ${this.slider('drainCapacityMmHr', 'Drain capacity', 0, 80, 1, (v) => `${v} mm/h`)}
        ${this.slider('drainBlockage', 'Drains blocked by silt and garbage', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
        ${this.slider('infiltrationMmHr', 'Soaks into open ground', 0, 40, 1, (v) => `${v} mm/h`)}
        <button class="btn primary" id="rerun" disabled>${iconSvg('refresh', 16)}<span>Re-run simulation</span></button>
      </section>

      <section class="sec">
        <h2>Map</h2>
        <div class="seg" role="group" aria-label="Basemap">
          <button data-bm="dark" class="on">Dark map</button>
          <button data-bm="satellite">Satellite</button>
        </div>
        <label class="slider">
          <span class="sl-top"><span>Terrain height</span><output id="ex-out">${exaggeration.toFixed(1)}×</output></span>
          <input type="range" id="ex" min="1" max="5" step="0.1" value="${exaggeration}">
        </label>
        <div class="layers">
          ${LAYERS.map(
            (l) => `<label class="lyr"><input type="checkbox" data-layer="${l.id}" ${l.on ? 'checked' : ''}><i class="sw" style="background:${l.swatch}"></i><span>${esc(l.label)}</span></label>`,
          ).join('')}
        </div>
      </section>

      <div id="story-mount"></div>

      <p class="foot" id="foot"></p>
    `;
    this.wire();
  }

  private slider(key: keyof SimParams, label: string, min: number, max: number, step: number, fmt: (v: number) => string) {
    const v = this.params[key];
    return `<label class="slider"><span class="sl-top"><span>${label}</span><output data-out="${key}">${fmt(v)}</output></span>
      <input type="range" data-p="${key}" min="${min}" max="${max}" step="${step}" value="${v}" data-fmt="${key}"></label>`;
  }

  private wire() {
    const el = this.el;
    const fmts: Record<string, (v: number) => string> = {
      drainCapacityMmHr: (v) => `${v} mm/h`,
      drainBlockage: (v) => `${Math.round(v * 100)}%`,
      infiltrationMmHr: (v) => `${v} mm/h`,
    };
    const rerun = el.querySelector('#rerun') as HTMLButtonElement;
    el.querySelectorAll<HTMLInputElement>('input[data-p]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.p as keyof SimParams;
        this.params[k] = Number(inp.value);
        (el.querySelector(`output[data-out="${k}"]`) as HTMLOutputElement).textContent = fmts[k](this.params[k]);
        rerun.disabled = false;
      });
    });
    rerun.addEventListener('click', () => {
      rerun.disabled = true;
      this.h.onRerun({ ...this.params });
    });
    el.querySelectorAll<HTMLInputElement>('input[name="src"]').forEach((r) =>
      r.addEventListener('change', () => {
        if (!r.checked) return;
        this.syncVariant();
        if (r.value === 'forecast') this.setVariantUI('best');
        this.h.onSource(r.value);
      }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.classList.contains('on')) return;
        this.setVariantUI(b.dataset.v as 'best' | 'worst');
        this.h.onVariant(b.dataset.v as 'best' | 'worst');
      }),
    );
    this.syncVariant();
    el.querySelectorAll<HTMLButtonElement>('[data-bm]').forEach((b) =>
      b.addEventListener('click', () => {
        el.querySelectorAll('[data-bm]').forEach((x) => x.classList.toggle('on', x === b));
        this.h.onBasemap(b.dataset.bm as 'dark' | 'satellite');
      }),
    );
    const ex = el.querySelector('#ex') as HTMLInputElement;
    ex.addEventListener('input', () => {
      (el.querySelector('#ex-out') as HTMLOutputElement).textContent = `${Number(ex.value).toFixed(1)}×`;
      this.h.onExaggeration(Number(ex.value));
    });
    el.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((c) => c.addEventListener('change', () => this.h.onLayer(c.dataset.layer!, c.checked)));
  }

  selectSource(id: string) {
    const r = this.el.querySelector<HTMLInputElement>(`input[name="src"][value="${CSS.escape(id)}"]`);
    if (r) r.checked = true;
    this.syncVariant();
  }

  private syncVariant() {
    const on = (this.el.querySelector('input[name="src"][value="forecast"]') as HTMLInputElement).checked;
    this.el.querySelector('.variant')!.classList.toggle('hidden', !on);
  }

  private setVariantUI(v: 'best' | 'worst') {
    this.el.querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.v === v));
  }

  setBasemapUI(b: 'dark' | 'satellite') {
    this.el.querySelectorAll('[data-bm]').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.bm === b));
  }

  setForecastNote(text: string) {
    (this.el.querySelector('#fc-note') as HTMLElement).textContent = text;
  }

  setBusy(b: boolean) {
    this.el.querySelectorAll<HTMLInputElement>('input[name="src"]').forEach((r) => (r.disabled = b));
    this.el.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((x) => (x.disabled = b));
    if (b) (this.el.querySelector('#rerun') as HTMLButtonElement).disabled = true;
  }

  setFoot(html: string) {
    (this.el.querySelector('#foot') as HTMLElement).innerHTML = html;
  }

  /** Rain summary. For a forecast: from "now"; for a scenario: whole event. */
  setRain(s: RainSeries, note?: string) {
    const q = (k: string) => this.el.querySelector(`[data-k="${k}"]`) as HTMLElement;
    const l = (k: string) => this.el.querySelector(`[data-l="${k}"]`) as HTMLElement;
    const unit = (v: number, u: string) => `${fmtNum(v, v < 10 ? 1 : 0)}<small>${u}</small>`;
    if (s.source === 'forecast' && s.nowIndex !== undefined) {
      const i0 = s.nowIndex;
      const next = s.mm.slice(i0, i0 + 24);
      const tot = next.reduce((a, b) => a + b, 0);
      const mx = Math.max(0, ...next);
      const mxI = next.indexOf(mx);
      const prob = s.probability ? Math.max(0, ...s.probability.slice(i0, i0 + 24)) : NaN;
      q('now').innerHTML = unit(s.mm[i0] ?? 0, 'mm');
      l('now').textContent = 'This hour';
      q('tot').innerHTML = unit(tot, 'mm');
      l('tot').textContent = 'Next 24 h';
      q('max').innerHTML = unit(mx, 'mm');
      l('max').textContent = mx > 0 ? `Wettest hour, ${fmtHour(s.times[i0 + mxI])}` : 'Wettest hour';
      q('prob').innerHTML = Number.isFinite(prob) ? `${prob}<small>%</small>` : '–';
      l('prob').textContent = 'Chance of rain';
    } else {
      const tot = s.mm.reduce((a, b) => a + b, 0);
      const mx = Math.max(0, ...s.mm);
      const wet = s.mm.filter((v) => v > 0.2).length;
      q('now').innerHTML = unit(tot, 'mm');
      l('now').textContent = 'Total rain';
      q('tot').innerHTML = `${wet}<small>h</small>`;
      l('tot').textContent = 'Hours of rain';
      q('max').innerHTML = unit(mx, 'mm');
      l('max').textContent = 'Wettest hour';
      q('prob').innerHTML = `${s.mm.length}<small>h</small>`;
      l('prob').textContent = 'Simulated';
    }
    (this.el.querySelector('#rain-note') as HTMLElement).innerHTML = note ?? '';
  }
}
