// The next three hours in half-hour steps: a compact bar over the map in Commute mode. Each step
// shows the worst level among the hotspots and how many are at watch or worse; picking a step
// recolours the pins. A slider (arrow keys, Home / End) for keyboards and screen readers.
import type { RiskLevel } from '../../commute/types';
import { fmtHHMM } from '../../commute/verdict';
import { LEVEL_COLOR, LEVEL_TEXT } from './levels';

export interface Step {
  t: number;
  worst: RiskLevel;
  /** hotspots at watch or worse */
  n: number;
}

export class Scrubber {
  readonly el: HTMLElement;
  private track: HTMLElement;
  private steps: Step[] = [];
  private k = 0;
  private onPick: (k: number) => void;

  constructor(parent: HTMLElement, onPick: (k: number) => void) {
    this.onPick = onPick;
    this.el = document.createElement('div');
    this.el.className = 'glass cm-scrub';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', 'Next 3 hours');
    this.el.innerHTML = `
      <div class="cm-scrub-head"><span class="cm-scrub-lbl">Next 3 hours</span><b class="cm-scrub-time"></b></div>
      <div class="cm-scrub-track" role="slider" tabindex="0" aria-label="Time, next 3 hours in half-hour steps" aria-valuemin="0"></div>`;
    this.track = this.el.querySelector('.cm-scrub-track') as HTMLElement;
    parent.appendChild(this.el);
    let drag = false;
    const pick = (e: PointerEvent) => {
      const r = this.track.getBoundingClientRect();
      const n = this.steps.length;
      if (!n) return;
      this.go(Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))));
    };
    this.track.addEventListener('pointerdown', (e) => {
      drag = true;
      this.track.setPointerCapture(e.pointerId);
      pick(e);
    });
    this.track.addEventListener('pointermove', (e) => drag && pick(e));
    this.track.addEventListener('pointerup', () => (drag = false));
    this.track.addEventListener('keydown', (e) => {
      const n = this.steps.length;
      if (!n) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') this.go(Math.min(n - 1, this.k + 1));
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') this.go(Math.max(0, this.k - 1));
      else if (e.key === 'Home') this.go(0);
      else if (e.key === 'End') this.go(n - 1);
      else return;
      e.preventDefault();
    });
  }

  private go(k: number) {
    if (k === this.k) return;
    this.setIndex(k);
    this.onPick(k);
  }

  get index(): number {
    return this.k;
  }

  set(steps: Step[]) {
    this.steps = steps;
    this.k = Math.min(this.k, Math.max(0, steps.length - 1));
    this.track.innerHTML = steps
      .map(
        (s, i) => `<span class="cm-step" style="--c:${LEVEL_COLOR[s.worst]}" data-k="${i}" aria-hidden="true">
          <i class="cm-step-bar" data-level="${s.worst}">${s.n ? s.n : ''}</i><em>${i === 0 ? 'Now' : fmtHHMM(s.t)}</em></span>`,
      )
      .join('');
    this.track.setAttribute('aria-valuemax', String(Math.max(0, steps.length - 1)));
    this.setIndex(this.k);
  }

  setIndex(k: number) {
    this.k = k;
    this.track.querySelectorAll('.cm-step').forEach((el, i) => el.classList.toggle('on', i === k));
    const s = this.steps[k];
    if (!s) return;
    const when = k === 0 ? `Now (${fmtHHMM(Date.now())})` : fmtHHMM(s.t);
    const what = s.n ? `${s.n} hotspot${s.n === 1 ? '' : 's'} at watch or worse; worst: ${LEVEL_TEXT[s.worst].toLowerCase()}` : 'no waterlogging expected at any hotspot';
    (this.el.querySelector('.cm-scrub-time') as HTMLElement).textContent = k === 0 ? 'Now' : fmtHHMM(s.t);
    this.track.setAttribute('aria-valuenow', String(k));
    this.track.setAttribute('aria-valuetext', `${when}: ${what}`);
  }

  setHidden(h: boolean) {
    this.el.hidden = h;
  }

  destroy() {
    this.el.remove();
  }
}
