// Bottom timeline: rain hangs from the top (hyetograph), flooded area rises
// from the bottom, with a scrubber, play/pause and speed.
import type { RainSeries } from '../types';
import { DEPTH_LEGEND } from '../map/colors';
import { fmtArea, fmtDay, fmtDayShort, fmtHour, istHour, relHours } from './format';
import { iconSvg } from './icons';

const NS = 'http://www.w3.org/2000/svg';
const SPEEDS = [2, 4, 8, 16];

export interface TimelineHandlers {
  onHour(h: number): void;
  onPlay(playing: boolean): void;
  onSpeed(hoursPerSec: number): void;
}

export class Timeline {
  private el: HTMLElement;
  private svg: SVGSVGElement;
  private h: TimelineHandlers;
  private series: RainSeries | null = null;
  private area: number[] = [];
  private hour = 0;
  private playing = false;
  private W = 800;
  private readonly H = 92;
  private head!: SVGGElement;

  constructor(el: HTMLElement, h: TimelineHandlers) {
    this.el = el;
    this.h = h;
    el.innerHTML = `
      <div class="tl-top">
        <button class="tl-play" id="tl-play" aria-label="Play">${iconSvg('play', 16)}</button>
        <div class="tl-time"><b id="tl-clock">--:--</b><span id="tl-rel"></span></div>
        <div class="tl-read">
          <span><i class="dot rain"></i><b id="tl-rain">–</b> rain this hour</span>
          <span><i class="dot area"></i><b id="tl-area">–</b> under water</span>
        </div>
        <div class="seg small" id="tl-speed" role="group" aria-label="Playback speed">
          ${SPEEDS.map((s, i) => `<button data-s="${s}" class="${i === 1 ? 'on' : ''}" title="${s} simulated hours per second">${s}×</button>`).join('')}
        </div>
        <div class="legend" aria-label="Water depth: ${DEPTH_LEGEND.map((l) => l.label).join(', ')}">
          <span>2 cm</span><i style="background:linear-gradient(90deg,${DEPTH_LEGEND.map((l) => l.color).join(',')})"></i><span>1 m+</span>
        </div>
      </div>
      <div class="tl-chart" id="tl-chart"><svg id="tl-svg" role="slider" tabindex="0" aria-label="Simulation hour"></svg></div>
    `;
    this.svg = el.querySelector('#tl-svg') as unknown as SVGSVGElement;
    (el.querySelector('#tl-play') as HTMLButtonElement).addEventListener('click', () => this.setPlaying(!this.playing, true));
    el.querySelectorAll<HTMLButtonElement>('#tl-speed [data-s]').forEach((b) =>
      b.addEventListener('click', () => {
        el.querySelectorAll('#tl-speed [data-s]').forEach((x) => x.classList.toggle('on', x === b));
        this.h.onSpeed(Number(b.dataset.s));
      }),
    );
    let drag = false;
    const pick = (e: PointerEvent) => {
      if (!this.series) return;
      const r = this.svg.getBoundingClientRect();
      const n = this.series.mm.length;
      const hr = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)));
      if (hr !== this.hour) this.h.onHour(hr);
    };
    this.svg.addEventListener('pointerdown', (e) => {
      drag = true;
      this.svg.setPointerCapture(e.pointerId);
      if (this.playing) this.setPlaying(false, true);
      pick(e);
    });
    this.svg.addEventListener('pointermove', (e) => drag && pick(e));
    this.svg.addEventListener('pointerup', () => (drag = false));
    this.svg.addEventListener('keydown', (e) => {
      if (!this.series) return;
      const n = this.series.mm.length;
      if (e.key === 'ArrowRight') this.h.onHour(Math.min(n - 1, this.hour + (e.shiftKey ? 6 : 1)));
      else if (e.key === 'ArrowLeft') this.h.onHour(Math.max(0, this.hour - (e.shiftKey ? 6 : 1)));
      else return;
      e.preventDefault();
    });
    new ResizeObserver(() => this.draw()).observe(el.querySelector('#tl-chart')!);
  }

  setSeries(s: RainSeries, area: number[]) {
    this.series = s;
    this.area = area;
    this.draw();
  }

  setPlaying(p: boolean, notify = false) {
    this.playing = p;
    const b = this.el.querySelector('#tl-play') as HTMLButtonElement;
    b.innerHTML = iconSvg(p ? 'pause' : 'play', 16);
    b.setAttribute('aria-label', p ? 'Pause' : 'Play');
    b.classList.toggle('on', p);
    if (notify) this.h.onPlay(p);
  }

  setHour(h: number) {
    this.hour = h;
    const s = this.series;
    if (!s) return;
    const t = s.times[h];
    (this.el.querySelector('#tl-clock') as HTMLElement).textContent = fmtHour(t);
    (this.el.querySelector('#tl-rel') as HTMLElement).textContent = `${fmtDay(t)}${s.source === 'forecast' ? `, ${relHours(h, s.nowIndex)}` : `, hour ${h + 1} of ${s.mm.length}`}`;
    (this.el.querySelector('#tl-rain') as HTMLElement).textContent = `${(s.mm[h] ?? 0).toFixed(1)} mm`;
    (this.el.querySelector('#tl-area') as HTMLElement).textContent = this.area.length ? fmtArea(this.area[h] ?? 0) : '–';
    this.svg.setAttribute('aria-valuenow', String(h));
    this.svg.setAttribute('aria-valuetext', `${fmtDay(t)} ${fmtHour(t)}`);
    if (this.head) {
      const n = s.mm.length;
      const bw = this.W / n;
      this.head.setAttribute('transform', `translate(${(h + 0.5) * bw},0)`);
      this.svg.querySelectorAll('.bar').forEach((b, i) => b.classList.toggle('past', i <= h));
    }
  }

  private draw() {
    const s = this.series;
    const svg = this.svg;
    const box = (this.el.querySelector('#tl-chart') as HTMLElement).getBoundingClientRect();
    this.W = Math.max(200, box.width);
    const W = this.W;
    const H = this.H;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.innerHTML = '';
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
        el('text', { x: Math.min(W - 70, px + 6), y: Math.max(rainH * 0.6, py + 3), class: 'tl-lbl peak' }).textContent = `peak ${fmtArea(maxA)}`;
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
