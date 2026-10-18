// Bottom timeline: rain hangs from the top (hyetograph), flooded area rises
// from the bottom, with a scrubber, play/pause and speed. Minimises to a compact
// bar (play, time, flooded-area sparkline).
import type { RainSeries } from '../types';
import { fmtArea, fmtDay, fmtDayShort, fmtHour, istHour, relHours } from './format';
import { iconSvg } from './icons';
import { load, save } from './store';

const NS = 'http://www.w3.org/2000/svg';
const SPEEDS = [2, 4, 8, 16];
const SPARK_W = 132;
const SPARK_H = 26;

export interface TimelineHandlers {
  onHour(h: number): void;
  onPlay(playing: boolean): void;
  onSpeed(hoursPerSec: number): void;
  /** the timeline switched between full and compact */
  onCompact?(compact: boolean): void;
}

export class Timeline {
  private el: HTMLElement;
  private svg: SVGSVGElement;
  private spark: SVGSVGElement;
  private h: TimelineHandlers;
  private series: RainSeries | null = null;
  private area: number[] = [];
  private hour = 0;
  private playing = false;
  private W = 800;
  private readonly H = 86;
  private head!: SVGGElement;
  private sparkHead: SVGGElement | null = null;
  private peak: { x: number; lbl: SVGTextElement } | null = null;
  private pref: boolean;
  private forced = false;

  constructor(el: HTMLElement, h: TimelineHandlers) {
    this.el = el;
    this.h = h;
    this.pref = load('tl.compact', false);
    el.innerHTML = `
      <div class="tl-full">
        <div class="tl-top">
          <button type="button" class="tl-play" data-play aria-label="Play">${iconSvg('play', 16)}</button>
          <div class="tl-time"><b class="tl-clock">--:--</b><span class="tl-rel"></span></div>
          <div class="tl-read">
            <span><i class="dot rain"></i><b id="tl-rain">–</b> rain this hour</span>
            <span><i class="dot area"></i><b id="tl-area">–</b> under water</span>
          </div>
          <div class="segmented small" id="tl-speed" role="group" aria-label="Playback speed">
            ${SPEEDS.map((s, i) => `<button type="button" data-s="${s}" aria-pressed="${i === 1}" title="${s} predicted hours per second">${s}×</button>`).join('')}
          </div>
          <button type="button" class="icon-btn tl-min" aria-label="Minimise the timeline" data-tip="Minimise">${iconSvg('chevron', 15, 1.8)}</button>
        </div>
        <div class="tl-chart" id="tl-chart"><svg id="tl-svg" role="slider" tabindex="0" aria-label="Prediction hour" aria-valuemin="0"></svg></div>
      </div>
      <div class="tl-mini">
        <button type="button" class="tl-play" data-play aria-label="Play">${iconSvg('play', 14)}</button>
        <div class="tl-mtime"><b class="tl-clock">--:--</b><span class="tl-mday"></span></div>
        <svg class="tl-spark" width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" role="slider" tabindex="0" aria-label="Prediction hour (flooded area over time)" aria-valuemin="0"></svg>
        <button type="button" class="icon-btn tl-exp" aria-label="Expand the timeline" data-tip="Expand">${iconSvg('chevron', 15, 1.8)}</button>
      </div>
    `;
    this.svg = el.querySelector('#tl-svg') as unknown as SVGSVGElement;
    this.spark = el.querySelector('.tl-spark') as unknown as SVGSVGElement;
    el.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((b) => b.addEventListener('click', () => this.setPlaying(!this.playing, true)));
    el.querySelectorAll<HTMLButtonElement>('#tl-speed [data-s]').forEach((b) =>
      b.addEventListener('click', () => {
        el.querySelectorAll<HTMLElement>('#tl-speed [data-s]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        this.h.onSpeed(Number(b.dataset.s));
      }),
    );
    el.querySelector('.tl-min')!.addEventListener('click', () => this.setCompact(true));
    el.querySelector('.tl-exp')!.addEventListener('click', () => this.setCompact(false));
    this.scrubber(this.svg);
    this.scrubber(this.spark);
    new ResizeObserver(() => this.draw()).observe(el.querySelector('#tl-chart')!);
    this.apply();
  }

  /** pointer + arrow-key scrubbing on an svg that spans the whole series */
  private scrubber(svg: SVGSVGElement) {
    let drag = false;
    const pick = (e: PointerEvent) => {
      if (!this.series) return;
      const r = svg.getBoundingClientRect();
      const n = this.series.mm.length;
      const hr = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)));
      if (hr !== this.hour) this.h.onHour(hr);
    };
    svg.addEventListener('pointerdown', (e) => {
      drag = true;
      svg.setPointerCapture(e.pointerId);
      if (this.playing) this.setPlaying(false, true);
      pick(e);
    });
    svg.addEventListener('pointermove', (e) => drag && pick(e));
    svg.addEventListener('pointerup', () => (drag = false));
    svg.addEventListener('keydown', (e) => {
      if (!this.series) return;
      const n = this.series.mm.length;
      if (e.key === 'ArrowRight') this.h.onHour(Math.min(n - 1, this.hour + (e.shiftKey ? 6 : 1)));
      else if (e.key === 'ArrowLeft') this.h.onHour(Math.max(0, this.hour - (e.shiftKey ? 6 : 1)));
      else if (e.key === 'Home') this.h.onHour(0);
      else if (e.key === 'End') this.h.onHour(n - 1);
      else return;
      e.preventDefault();
    });
  }

  // ---------- compact ----------
  get compact(): boolean {
    return this.forced || this.pref;
  }

  setCompact(c: boolean) {
    this.pref = c;
    save('tl.compact', c);
    this.apply();
    const focus = this.el.querySelector<HTMLElement>(c ? '.tl-exp' : '.tl-min');
    if (this.el.contains(document.activeElement)) focus?.focus({ preventScroll: true });
  }

  /** Phones always use the compact bar. */
  setForceCompact(f: boolean) {
    if (f === this.forced) return;
    this.forced = f;
    this.apply();
  }

  private apply() {
    const c = this.compact;
    const changed = this.el.classList.contains('compact') !== c;
    this.el.classList.toggle('compact', c);
    this.el.classList.toggle('forced', this.forced);
    document.body.classList.toggle('tl-compact', c);
    if (changed) this.h.onCompact?.(c);
  }

  // ---------- data ----------
  setSeries(s: RainSeries, area: number[]) {
    this.series = s;
    this.area = area;
    this.svg.setAttribute('aria-valuemax', String(s.mm.length - 1));
    this.spark.setAttribute('aria-valuemax', String(s.mm.length - 1));
    this.draw();
    this.drawSpark();
  }

  setPlaying(p: boolean, notify = false) {
    this.playing = p;
    this.el.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((b) => {
      b.innerHTML = iconSvg(p ? 'pause' : 'play', b.closest('.tl-mini') ? 14 : 16);
      b.setAttribute('aria-label', p ? 'Pause' : 'Play');
      b.classList.toggle('on', p);
    });
    if (notify) this.h.onPlay(p);
  }

  setHour(h: number) {
    this.hour = h;
    const s = this.series;
    if (!s) return;
    const t = s.times[h];
    this.el.querySelectorAll('.tl-clock').forEach((x) => (x.textContent = fmtHour(t)));
    (this.el.querySelector('.tl-rel') as HTMLElement).textContent = `${fmtDay(t)}${s.source === 'forecast' ? `, ${relHours(h, s.nowIndex)}` : `, hour ${h + 1} of ${s.mm.length}`}`;
    (this.el.querySelector('.tl-mday') as HTMLElement).textContent = s.source === 'forecast' ? `${fmtDayShort(t)}, ${relHours(h, s.nowIndex)}` : fmtDay(t);
    (this.el.querySelector('#tl-rain') as HTMLElement).textContent = `${(s.mm[h] ?? 0).toFixed(1)} mm`;
    (this.el.querySelector('#tl-area') as HTMLElement).textContent = this.area.length ? fmtArea(this.area[h] ?? 0) : '–';
    for (const svg of [this.svg, this.spark]) {
      svg.setAttribute('aria-valuenow', String(h));
      svg.setAttribute('aria-valuetext', `${fmtDay(t)} ${fmtHour(t)}`);
    }
    const n = s.mm.length;
    if (this.head) {
      const bw = this.W / n;
      this.head.setAttribute('transform', `translate(${(h + 0.5) * bw},0)`);
      this.svg.querySelectorAll('.bar').forEach((b) => b.classList.toggle('past', Number(b.getAttribute('data-i')) <= h));
      this.placePeak((h + 0.5) * bw);
    }
    this.sparkHead?.setAttribute('transform', `translate(${((h + 0.5) / n) * SPARK_W},0)`);
  }

  /** Put the "peak" label on whichever side of the peak keeps it clear of the playhead. */
  private placePeak(headX: number) {
    const p = this.peak;
    if (!p) return;
    const w = p.lbl.getComputedTextLength() || (p.lbl.textContent ?? '').length * 5.8;
    const fitsR = p.x + 6 + w <= this.W - 2;
    const fitsL = p.x - 6 - w >= 2;
    const hitR = headX >= p.x + 3 && headX <= p.x + 9 + w;
    const hitL = headX >= p.x - 9 - w && headX <= p.x - 3;
    const left = !fitsR || (hitR && fitsL && !hitL);
    p.lbl.setAttribute('x', String(left ? p.x - 6 : p.x + 6));
    p.lbl.setAttribute('text-anchor', left ? 'end' : 'start');
  }

  private drawSpark() {
    const s = this.series;
    const svg = this.spark;
    svg.innerHTML = '';
    this.sparkHead = null;
    if (!s) return;
    const n = s.mm.length;
    const W = SPARK_W;
    const H = SPARK_H;
    const base = H - 3;
    const maxA = Math.max(1, ...this.area);
    const maxMm = Math.max(10, ...s.mm);
    const x = (i: number) => ((i + 0.5) / n) * W;
    const y = (i: number) => base - ((this.area[i] ?? 0) / maxA) * (H - 7);
    const mk = (tag: string, attrs: Record<string, string | number>, parent: Element = svg) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      parent.appendChild(e);
      return e;
    };
    // rain as faint ticks from the top, flooded area as a filled line
    for (let i = 0; i < n; i++) if (s.mm[i] > 0.05) mk('rect', { x: (i / n) * W, y: 0, width: Math.max(0.8, W / n - 0.4), height: Math.max(1, Math.sqrt(s.mm[i] / maxMm) * 7), class: 'sp-rain' });
    let d = `M0 ${base}`;
    for (let i = 0; i < n; i++) d += ` L${x(i).toFixed(1)} ${y(i).toFixed(1)}`;
    mk('path', { d: `${d} L${W} ${base} Z`, class: 'sp-area' });
    let l = '';
    for (let i = 0; i < n; i++) l += `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(i).toFixed(1)} `;
    mk('path', { d: l, class: 'sp-line' });
    if (s.nowIndex !== undefined) mk('line', { x1: x(s.nowIndex), x2: x(s.nowIndex), y1: 0, y2: H, class: 'sp-now' });
    this.sparkHead = mk('g', { class: 'sp-head' }) as SVGGElement;
    mk('line', { x1: 0, x2: 0, y1: 0, y2: H, class: 'sp-head-line' }, this.sparkHead);
    this.setHour(Math.min(this.hour, n - 1));
  }

  private draw() {
    const s = this.series;
    const svg = this.svg;
    const box = (this.el.querySelector('#tl-chart') as HTMLElement).getBoundingClientRect();
    if (box.width < 1 && this.head) return; // hidden while compact: keep the last drawing
    this.W = Math.max(200, box.width);
    const W = this.W;
    const H = this.H;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.innerHTML = '';
    this.peak = null;
    if (!s) return;
    const n = s.mm.length;
    const bw = W / n;
    const rainH = H * 0.42;
    const baseY = H - 14; // day labels below
    const maxMm = Math.max(10, ...s.mm);
    const el = (tag: string, attrs: Record<string, string | number>, parent: Element = svg) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      parent.appendChild(e);
      return e;
    };
    const defs = el('defs', {});
    const g1 = el('linearGradient', { id: 'gArea', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: 0, 'stop-color': '#5d7bff', 'stop-opacity': 0.75 }, g1);
    el('stop', { offset: 1, 'stop-color': '#1ec8ff', 'stop-opacity': 0.08 }, g1);

    // day bands + labels
    for (let i = 0; i < n; i++) {
      if (istHour(s.times[i]) === 0 || i === 0) {
        const x = i * bw;
        if (i > 0) el('line', { x1: x, x2: x, y1: 0, y2: baseY, class: 'tl-day' });
        if (W - x > 60) el('text', { x: x + 4, y: H - 3, class: 'tl-lbl' }).textContent = fmtDayShort(s.times[i]);
      } else if (istHour(s.times[i]) === 12 && bw * 12 > 40) {
        el('text', { x: i * bw + 2, y: H - 3, class: 'tl-lbl dim' }).textContent = '12:00';
      }
    }
    el('line', { x1: 0, x2: W, y1: baseY, y2: baseY, class: 'tl-base' });

    // flooded area rising from the bottom
    if (this.area.length) {
      const maxA = Math.max(1, ...this.area);
      const topSpace = baseY - rainH * 0.35;
      let d = `M0 ${baseY}`;
      for (let i = 0; i < n; i++) d += ` L${(i + 0.5) * bw} ${baseY - ((this.area[i] ?? 0) / maxA) * topSpace * 0.95}`;
      d += ` L${W} ${baseY} Z`;
      el('path', { d, fill: 'url(#gArea)', class: 'tl-area' });
      let l = '';
      for (let i = 0; i < n; i++) l += `${i ? 'L' : 'M'}${(i + 0.5) * bw} ${baseY - ((this.area[i] ?? 0) / maxA) * topSpace * 0.95} `;
      el('path', { d: l, class: 'tl-area-line' });
      const peak = this.area.indexOf(maxA);
      if (maxA > 1) {
        const px = (peak + 0.5) * bw;
        const py = baseY - topSpace * 0.95;
        el('circle', { cx: px, cy: py, r: 2.5, class: 'tl-peak' });
        // below the deepest rain bar, beside (never under) the playhead: see placePeak()
        const lbl = el('text', { x: px + 6, y: Math.min(baseY - 6, rainH + 12), class: 'tl-lbl peak' }) as SVGTextElement;
        lbl.textContent = `peak ${fmtArea(maxA)}`;
        this.peak = { x: px, lbl };
      }
    }
    // rain hanging from the top
    const bars = el('g', { class: 'bars' });
    for (let i = 0; i < n; i++) {
      const v = s.mm[i];
      if (v <= 0.05) continue;
      const hgt = Math.max(1.5, Math.sqrt(v / maxMm) * rainH);
      const r = el('rect', { x: i * bw + bw * 0.12, y: 0, width: Math.max(1, bw * 0.76), height: hgt, rx: Math.min(1.5, bw / 3), class: 'bar' }, bars);
      r.setAttribute('data-i', String(i));
      const p = s.probability?.[i];
      if (p !== undefined && p < 40) r.classList.add('unlikely');
    }
    el('text', { x: W - 4, y: 10, class: 'tl-lbl end' }).textContent = `${Math.round(maxMm)} mm/h`;

    // now marker
    if (s.nowIndex !== undefined) {
      const x = (s.nowIndex + 0.5) * bw;
      el('line', { x1: x, x2: x, y1: 0, y2: baseY, class: 'tl-now' });
      el('text', { x: x + 4, y: baseY - 4, class: 'tl-lbl now' }).textContent = 'now';
      // shade the past
      el('rect', { x: 0, y: 0, width: x, height: baseY, class: 'tl-past' });
    }
    // playhead
    this.head = el('g', { class: 'tl-head' }) as SVGGElement;
    el('line', { x1: 0, x2: 0, y1: 0, y2: baseY, class: 'tl-head-line' }, this.head);
    el('circle', { cx: 0, cy: baseY, r: 4.5, class: 'tl-head-knob' }, this.head);
    this.setHour(Math.min(this.hour, n - 1));
  }
}
