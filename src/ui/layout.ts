// Layout controller: screen mode (phone / tablet / desktop), focus mode, keyboard
// shortcuts, and the map padding that keeps the subject centred in the free map area.
import type { PaddingOptions } from 'maplibre-gl';
import type { Mode, Sidebar } from './sidebar';
import type { Timeline } from './timeline';
import { iconSvg } from './icons';

export interface LayoutHandlers {
  /** the free map area changed: re-pad the camera */
  onFrame(): void;
  /** play / pause from the focus-mode button */
  onPlay(): void;
  /** true while something else owns the keyboard (the guided tour) */
  busy(): boolean;
}

const PHONE = window.matchMedia('(max-width: 720px)');
const TABLET = window.matchMedia('(max-width: 1180px)');

const cssPx = (name: string) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || !!t.closest('input, textarea, select'));

/** first control a keyboard user can reach inside `root` */
const firstControl = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].find(
    (x) => !(x as HTMLButtonElement).disabled && !x.closest('[hidden], [inert]') && x.getClientRects().length > 0 && getComputedStyle(x).visibility !== 'hidden',
  );

export class Layout {
  mode: Mode = 'desktop';
  private sb: Sidebar;
  private tl: Timeline;
  private tlEl: HTMLElement;
  private h: LayoutHandlers;
  private bar: HTMLElement;
  private focusOn = false;

  constructor(sb: Sidebar, tl: Timeline, tlEl: HTMLElement, bar: HTMLElement, h: LayoutHandlers) {
    this.sb = sb;
    this.tl = tl;
    this.tlEl = tlEl;
    this.h = h;
    this.bar = bar;
    bar.inert = true;
    bar.innerHTML = `
      <button type="button" class="fb-btn fb-play" aria-label="Play">${iconSvg('play', 14)}</button>
      <button type="button" class="fb-btn fb-restore" aria-label="Show the panels (H)" aria-keyshortcuts="H">${iconSvg('panel_open', 17)}<span>Panels</span><kbd>H</kbd></button>`;
    bar.querySelector('.fb-play')!.addEventListener('click', () => h.onPlay());
    bar.querySelector('.fb-restore')!.addEventListener('click', () => this.setFocus(false));

    // the map is a named landmark, and the first Tab stop skips past it to the controls
    document.getElementById('map')?.setAttribute('role', 'region');
    const skip = document.createElement('a');
    skip.className = 'skip-link';
    skip.href = '#sidebar';
    skip.textContent = 'Skip to controls';
    skip.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.focusOn) this.setFocus(false);
      const root = this.mode !== 'phone' && this.sb.minimised ? this.sb.rail : this.sb.panel;
      firstControl(root)?.focus();
    });
    document.body.prepend(skip);
    // Esc hides hover/focus tooltips until the pointer or focus moves on (WCAG 1.4.13)
    const tipsOn = () => document.body.classList.remove('tips-off');
    document.addEventListener('pointermove', tipsOn, { passive: true });
    document.addEventListener('focusin', tipsOn);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && document.body.classList.add('tips-off'), true);

    const onMode = () => this.applyMode();
    PHONE.addEventListener('change', onMode);
    TABLET.addEventListener('change', onMode);
    this.applyMode(false);

    let rz = 0;
    window.addEventListener('resize', () => {
      clearTimeout(rz);
      rz = window.setTimeout(() => h.onFrame(), 200);
    });

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || h.busy()) return;
      if (e.key === '[') {
        e.preventDefault();
        if (this.focusOn) this.setFocus(false);
        this.sb.toggle();
      } else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        this.toggleFocus();
      } else if (e.key === 'Escape') {
        const popup = document.querySelector<HTMLElement>('.maplibregl-popup .maplibregl-popup-close-button');
        if (popup) {
          // a map card (news report, reported flood) closes first, like any popover
          const inside = popup.closest('.maplibregl-popup')!.contains(document.activeElement);
          popup.click();
          if (inside) document.querySelector<HTMLElement>('#map .maplibregl-canvas')?.focus({ preventScroll: true });
          return;
        }
        if (this.focusOn) this.setFocus(false);
        else if (this.mode !== 'desktop' && !this.sb.minimised) this.sb.setMinimised(true);
      }
    });
  }

  private applyMode(notify = true) {
    const mode: Mode = PHONE.matches ? 'phone' : TABLET.matches ? 'tablet' : 'desktop';
    this.mode = mode;
    const b = document.body.classList;
    b.toggle('mode-phone', mode === 'phone');
    b.toggle('mode-tablet', mode === 'tablet');
    b.toggle('mode-desktop', mode === 'desktop');
    this.sb.setMode(mode);
    this.tl.setForceCompact(mode === 'phone');
    if (notify) this.h.onFrame();
  }

  get focus(): boolean {
    return this.focusOn;
  }

  /** Focus mode: only the map, plus a tiny restore + play control. */
  setFocus(on: boolean) {
    if (on === this.focusOn) return;
    this.focusOn = on;
    const active = document.activeElement;
    document.body.classList.toggle('focus', on);
    this.bar.inert = !on;
    // keep keyboard focus on something visible
    if (on && active instanceof HTMLElement && active !== document.body && !this.bar.contains(active)) (this.bar.querySelector('.fb-restore') as HTMLElement).focus({ preventScroll: true });
    if (!on && active instanceof HTMLElement && this.bar.contains(active)) {
      const back = this.sb.minimised && this.mode !== 'phone' ? this.sb.rail.querySelector<HTMLElement>('[data-act="focus"]') : this.sb.panel.querySelector<HTMLElement>('#focus-btn');
      back?.focus({ preventScroll: true });
    }
    this.h.onFrame();
  }

  toggleFocus() {
    this.setFocus(!this.focusOn);
  }

  setPlaying(p: boolean) {
    const b = this.bar.querySelector('.fb-play') as HTMLButtonElement;
    b.innerHTML = iconSvg(p ? 'pause' : 'play', 14);
    b.setAttribute('aria-label', p ? 'Pause' : 'Play');
    b.classList.toggle('on', p);
  }

  /** Map padding: the part of the screen not covered by the sidebar, rail and timeline. */
  padding(): PaddingOptions {
    if (this.focusOn) return { top: 0, bottom: 0, left: 0, right: 0 };
    const gap = cssPx('--gap');
    const tl = this.tlEl.offsetHeight;
    if (this.mode === 'phone') return { top: 0, left: 0, right: 0, bottom: this.sb.peekHeight + tl + gap * 2 };
    // tablets: the expanded sidebar overlays the map, so frame against the rail
    const side = this.mode === 'tablet' || this.sb.minimised ? this.sb.rail : this.sb.panel;
    return { top: 0, right: 0, left: gap + side.offsetWidth, bottom: tl + gap * 2 };
  }
}
